import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { OandaApiError } from "../src/httpClient.ts";
import type { OandaClient } from "../src/oanda/client.ts";
import type { KillSwitch } from "../src/safety/killSwitch.ts";
import { Notifier, type NotifyLevel } from "../src/safety/notifier.ts";
import type { SafetyConfig } from "../src/safety/config.ts";
import { RiskManager } from "../src/safety/riskManager.ts";
import { MemoryStateStore } from "../src/safety/state.ts";
import { superviseOnce } from "../src/safety/supervisor.ts";

class CaptureNotifier extends Notifier {
  messages: { level: NotifyLevel; message: string }[] = [];

  constructor() {
    super(undefined);
  }

  override async notify(level: NotifyLevel, message: string): Promise<void> {
    this.messages.push({ level, message });
  }
}

const CONFIG: SafetyConfig = {
  maxUnitsPerOrder: 10_000,
  maxTotalUnits: 20_000,
  maxRiskPct: 1,
  maxMarginUsedPct: 40,
  dailyLossLimitPct: 3,
  maxDrawdownPct: 15,
  maxOrdersPerHour: 20,
  maxPriceDeviationPct: 1,
  maxSpreadPips: 2,
  flattenOnKill: false,
};

function fakeClient(behavior: () => Promise<unknown>): OandaClient {
  return { getAccountSummary: behavior } as unknown as OandaClient;
}

const noopKillSwitch = { trip: async () => {} } as unknown as KillSwitch;

describe("superviseOnce: 401検知 (Gold降格/トークン失効)", () => {
  it("401への遷移時に一度だけ緊急通知する (連続401では繰り返さない)", async () => {
    const store = new MemoryStateStore();
    const notifier = new CaptureNotifier();
    const deps = {
      client: fakeClient(async () => {
        throw new OandaApiError(401, "Insufficient authorization to perform request");
      }),
      store,
      riskManager: new RiskManager(CONFIG, store),
      killSwitch: noopKillSwitch,
      notifier,
    };
    await superviseOnce(deps);
    await superviseOnce(deps);
    const criticals = notifier.messages.filter((m) => m.level === "critical");
    assert.equal(criticals.length, 1);
    assert.match(criticals[0]!.message, /401/);
    assert.match(criticals[0]!.message, /Gold降格/);
  });

  it("正常時は通知せずlastStatusを更新する", async () => {
    const store = new MemoryStateStore();
    const notifier = new CaptureNotifier();
    await superviseOnce({
      client: fakeClient(async () => ({
        account: { NAV: "1000000" },
      })),
      store,
      riskManager: new RiskManager(CONFIG, store),
      killSwitch: noopKillSwitch,
      notifier,
    });
    assert.equal(notifier.messages.filter((m) => m.level === "critical").length, 0);
  });

  it("日次損失の違反でキルスイッチをtripする", async () => {
    const store = new MemoryStateStore();
    const notifier = new CaptureNotifier();
    let tripped: string | null = null;
    const ks = { trip: async (reason: string) => void (tripped = reason) } as unknown as KillSwitch;
    const rm = new RiskManager(CONFIG, store);
    let nav = 1_000_000;
    const deps = {
      client: fakeClient(async () => ({ account: { NAV: String(nav) } })),
      store,
      riskManager: rm,
      killSwitch: ks,
      notifier,
    };
    const t = Date.parse("2026-08-19T10:00:00Z");
    await superviseOnce(deps, t);
    nav = 960_000; // -4% (上限3%)
    await superviseOnce(deps, t + 3600_000);
    assert.ok(tripped !== null && (tripped as string).includes("日次損失"));
  });
});
