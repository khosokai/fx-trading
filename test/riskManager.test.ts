import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { SafetyConfig } from "../src/safety/config.ts";
import { RiskManager, type OrderCheckRequest } from "../src/safety/riskManager.ts";
import { MemoryStateStore, STATE_KEYS, setJson } from "../src/safety/state.ts";

const CONFIG: SafetyConfig = {
  maxUnitsPerOrder: 10_000,
  maxTotalUnits: 20_000,
  maxRiskPct: 1,
  maxMarginUsedPct: 40,
  dailyLossLimitPct: 3,
  maxDrawdownPct: 15,
  maxOrdersPerHour: 5,
  maxPriceDeviationPct: 1,
  maxSpreadPips: 2,
  flattenOnKill: false,
};

// 平日の通常時間帯 (NY 10:00 EDT = 2026-07-15 14:00 UTC 水曜)
const NORMAL_TIME = Date.parse("2026-07-15T14:00:00Z");

function baseRequest(overrides: Partial<OrderCheckRequest> = {}): OrderCheckRequest {
  return {
    instrument: "USD_JPY",
    units: 5_000,
    price: 150.0,
    refPrice: 150.0,
    spreadPips: 0.4,
    currentTotalUnits: 0,
    nowMs: NORMAL_TIME,
    ...overrides,
  };
}

describe("RiskManager.checkOrder", () => {
  it("正常な注文は通る", async () => {
    const rm = new RiskManager(CONFIG, new MemoryStateStore());
    assert.deepEqual(await rm.checkOrder(baseRequest()), { ok: true });
  });

  it("キルスイッチ発動中は拒否 (POST直前の再チェック)", async () => {
    const store = new MemoryStateStore();
    await setJson(store, STATE_KEYS.killSwitch, {
      active: true,
      reason: "test",
      trippedAt: "2026-07-15T00:00:00Z",
    });
    const rm = new RiskManager(CONFIG, store);
    const result = await rm.checkOrder(baseRequest());
    assert.equal(result.ok, false);
  });

  it("1注文の上限を超えたら拒否 (ショートの負units も絶対値で判定)", async () => {
    const rm = new RiskManager(CONFIG, new MemoryStateStore());
    assert.equal((await rm.checkOrder(baseRequest({ units: 10_001 }))).ok, false);
    assert.equal((await rm.checkOrder(baseRequest({ units: -10_001 }))).ok, false);
    assert.equal((await rm.checkOrder(baseRequest({ units: -10_000 }))).ok, true);
  });

  it("総ポジション上限を超えたら拒否", async () => {
    const rm = new RiskManager(CONFIG, new MemoryStateStore());
    const result = await rm.checkOrder(baseRequest({ currentTotalUnits: 15_001 }));
    assert.equal(result.ok, false);
  });

  it("スプレッドガード: 上限pipsを超えていたら見送り", async () => {
    const rm = new RiskManager(CONFIG, new MemoryStateStore());
    const result = await rm.checkOrder(baseRequest({ spreadPips: 2.5 }));
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /スプレッド/);
  });

  it("ロールオーバー帯 (NY 16:55-17:10) は新規発注ブラックアウト", async () => {
    const rm = new RiskManager(CONFIG, new MemoryStateStore());
    // 夏時間: NY 17:00 = 21:00 UTC
    const inBlackout = Date.parse("2026-07-15T21:05:00Z");
    const result = await rm.checkOrder(baseRequest({ nowMs: inBlackout }));
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /ロールオーバー/);
  });

  it("参照価格からの乖離が大きい注文は拒否 (桁間違い対策)", async () => {
    const rm = new RiskManager(CONFIG, new MemoryStateStore());
    const result = await rm.checkOrder(baseRequest({ price: 153.0, refPrice: 150.0 }));
    assert.equal(result.ok, false);
  });

  it("証拠金使用率の上限を超えたら拒否", async () => {
    const rm = new RiskManager(CONFIG, new MemoryStateStore());
    const result = await rm.checkOrder(baseRequest({ marginUsedPctAfter: 45 }));
    assert.equal(result.ok, false);
  });

  it("発注頻度の上限 (recordOrderで永続化されたカウンタ)", async () => {
    const store = new MemoryStateStore();
    const rm = new RiskManager(CONFIG, store);
    for (let i = 0; i < CONFIG.maxOrdersPerHour; i++) {
      await rm.recordOrder(NORMAL_TIME - 1000 * (i + 1));
    }
    const result = await rm.checkOrder(baseRequest());
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /発注頻度/);
  });
});

describe("RiskManager.checkEquity", () => {
  it("日次損失が上限に達したらviolation", async () => {
    const store = new MemoryStateStore();
    const rm = new RiskManager(CONFIG, store);
    const first = await rm.checkEquity(1_000_000, NORMAL_TIME);
    assert.equal(first.violation, null);
    const after = await rm.checkEquity(969_000, NORMAL_TIME + 3600_000); // -3.1%
    assert.ok(after.violation?.includes("日次損失"));
  });

  it("取引日 (NY17:00区切り) が変わると日次基準がリセットされる", async () => {
    const store = new MemoryStateStore();
    const rm = new RiskManager(CONFIG, store);
    await rm.checkEquity(1_000_000, NORMAL_TIME);
    // 同じUTC日でもNY17:00を跨げば翌取引日 → 基準リセットで違反にならない
    const nextTradingDay = Date.parse("2026-07-15T22:00:00Z");
    const result = await rm.checkEquity(969_000, nextTradingDay);
    assert.equal(result.violation, null);
    assert.equal(result.dailyPnl, 0);
  });

  it("最大ドローダウンが上限に達したらviolation", async () => {
    const store = new MemoryStateStore();
    const rm = new RiskManager(CONFIG, store);
    await rm.checkEquity(1_000_000, NORMAL_TIME);
    // 日次損失(-3%)より先にDD(-15%)判定にかからないよう、日をまたいで下げる
    let t = NORMAL_TIME;
    let equity = 1_000_000;
    let violation: string | null = null;
    for (let day = 0; day < 8; day++) {
      t += 24 * 3600_000;
      equity *= 0.975;
      const check = await rm.checkEquity(equity, t);
      if (check.violation) {
        violation = check.violation;
        break;
      }
    }
    assert.ok(violation?.includes("ドローダウン"), `violation: ${violation}`);
  });
});
