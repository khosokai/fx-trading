import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BidAskCandle } from "../src/core/candle.ts";
import { TF_MS } from "../src/core/candle.ts";
import { isWeekendClosed } from "../src/core/sessions.ts";
import {
  assertCompleteness,
  checkCompleteness,
  IncompleteDataError,
} from "../src/data/completeness.ts";
import { walkForward } from "../src/backtest/walkForward.ts";
import type { Strategy } from "../src/core/strategy.ts";

/**
 * データ完全性ゲートのテスト。
 * 背景: EUR/USDの11ヶ月欠損 + 2024-12の1週間部分欠損に研究4ラウンド気づかなかった
 * 事故 (docs/research.md 2026-08-21)。WFAが不完全データを拒否することを固定する。
 */

/** 週末クローズを除いた連続M15シリーズを生成 */
function syntheticM15(fromIso: string, toIso: string): BidAskCandle[] {
  const tfMs = TF_MS.M15;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const out: BidAskCandle[] = [];
  for (let t = Math.ceil(from / tfMs) * tfMs; t < to; t += tfMs) {
    if (isWeekendClosed(t)) continue;
    const px = 1.1 + 0.001 * Math.sin(t / 86_400_000);
    out.push({
      time: t,
      bid: { o: px, h: px + 0.0002, l: px - 0.0002, c: px },
      ask: { o: px + 0.0001, h: px + 0.0003, l: px - 0.0001, c: px + 0.0001 },
      volume: 10,
    });
  }
  return out;
}

test("完全なシリーズは欠損率ほぼ0で通過する", () => {
  const candles = syntheticM15("2024-01-01T00:00:00Z", "2024-04-01T00:00:00Z");
  const months = checkCompleteness(candles, "M15");
  assert.ok(months.length >= 3);
  for (const m of months) {
    assert.ok(m.missingRate < 0.01, `${m.month}: ${m.missingRate}`);
  }
  assertCompleteness(candles, "M15"); // 投げないこと
});

test("1週間の欠落はデフォルト閾値0.2で検知される", () => {
  const holeFrom = Date.parse("2024-02-05T00:00:00Z");
  const holeTo = holeFrom + 7 * 86_400_000;
  const candles = syntheticM15("2024-01-01T00:00:00Z", "2024-04-01T00:00:00Z").filter(
    (c) => c.time < holeFrom || c.time >= holeTo,
  );
  assert.throws(
    () => assertCompleteness(candles, "M15"),
    (err: unknown) => {
      assert.ok(err instanceof IncompleteDataError);
      assert.deepEqual(err.violations.map((v) => v.month), ["2024-02"]);
      assert.ok(err.violations[0]!.missingRate > 0.2);
      return true;
    },
  );
});

test("中間の丸ごと欠損月も検知される (実測本数0でも期待本数は数えられる)", () => {
  const candles = syntheticM15("2024-01-01T00:00:00Z", "2024-04-01T00:00:00Z").filter(
    (c) => !new Date(c.time).toISOString().startsWith("2024-02"),
  );
  assert.throws(
    () => assertCompleteness(candles, "M15"),
    (err: unknown) => {
      assert.ok(err instanceof IncompleteDataError);
      const feb = err.violations.find((v) => v.month === "2024-02");
      assert.ok(feb && feb.actual === 0 && feb.missingRate === 1);
      return true;
    },
  );
});

test("祝日規模の欠損 (2営業日 ≈ 9%) は誤検知しない", () => {
  // 12月の年末休場を模す: 12/25と1/1相当の2平日を抜く
  const d1 = Date.parse("2024-02-14T00:00:00Z");
  const d2 = Date.parse("2024-02-20T00:00:00Z");
  const day = 86_400_000;
  const candles = syntheticM15("2024-01-01T00:00:00Z", "2024-04-01T00:00:00Z").filter(
    (c) => !(c.time >= d1 && c.time < d1 + day) && !(c.time >= d2 && c.time < d2 + day),
  );
  assertCompleteness(candles, "M15"); // 投げないこと
});

test("walkForwardは不完全データで実行を拒否し、completeness:falseは合成テスト用に残る", () => {
  // 50本ごとにロングする最小戦略 (取引ゼロだとウィンドウ自体が作られないため)
  const flat: Strategy = {
    id: "sometimes-long",
    name: "sometimes-long",
    timeframe: "M15",
    warmup: 1,
    decide: (ctx) => (ctx.candles.length % 50 === 0 ? { target: 1, stopLossPips: 10, takeProfitPips: 10 } : { target: 0 }),
  };
  const holeFrom = Date.parse("2024-03-04T00:00:00Z");
  const candles = syntheticM15("2024-01-01T00:00:00Z", "2024-07-01T00:00:00Z").filter(
    (c) => c.time < holeFrom || c.time >= holeFrom + 10 * 86_400_000,
  );
  const opts = { trainDays: 60, testDays: 30 };
  assert.throws(() => walkForward(candles, [flat], "USD_JPY", opts), IncompleteDataError);
  // 明示的な無効化 (合成データのテスト専用) では実行できる
  walkForward(candles, [flat], "USD_JPY", { ...opts, completeness: false });
});
