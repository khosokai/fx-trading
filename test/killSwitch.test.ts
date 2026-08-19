import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { KillSwitch, type TradingActions } from "../src/safety/killSwitch.ts";
import { Notifier } from "../src/safety/notifier.ts";
import { MemoryStateStore, isKillSwitchActive } from "../src/safety/state.ts";

function makeActions(log: string[]): TradingActions {
  return {
    async cancelAllOrders() {
      log.push("cancel");
      return 2;
    },
    async closeAllPositions() {
      log.push("flatten");
    },
  };
}

// Webhook無効のNotifier (コンソール出力のみ)
const notifier = new Notifier(undefined);

describe("KillSwitch", () => {
  it("trip: ロックを最優先で永続化し、注文キャンセルを実行する", async () => {
    const store = new MemoryStateStore();
    const log: string[] = [];
    const ks = new KillSwitch(makeActions(log), notifier, store, false);
    await ks.trip("テスト発動");
    assert.equal(await isKillSwitchActive(store), true);
    assert.deepEqual(log, ["cancel"]); // flatten=falseならクローズしない
  });

  it("flatten=trueなら全ポジションクローズも行う", async () => {
    const store = new MemoryStateStore();
    const log: string[] = [];
    const ks = new KillSwitch(makeActions(log), notifier, store, true);
    await ks.trip("テスト発動");
    assert.deepEqual(log, ["cancel", "flatten"]);
  });

  it("多重発動は無視される", async () => {
    const store = new MemoryStateStore();
    const log: string[] = [];
    const ks = new KillSwitch(makeActions(log), notifier, store, false);
    await ks.trip("1回目");
    await ks.trip("2回目");
    assert.deepEqual(log, ["cancel"]);
  });

  it("市場操作が失敗してもロックは維持される", async () => {
    const store = new MemoryStateStore();
    const failing: TradingActions = {
      async cancelAllOrders(): Promise<number> {
        throw new Error("API down");
      },
      async closeAllPositions() {},
    };
    const ks = new KillSwitch(failing, notifier, store, false);
    await ks.trip("障害時");
    assert.equal(await isKillSwitchActive(store), true);
  });

  it("resetで解除される (人間の明示操作)", async () => {
    const store = new MemoryStateStore();
    const ks = new KillSwitch(makeActions([]), notifier, store, false);
    await ks.trip("発動");
    await KillSwitch.reset(store);
    assert.equal(await isKillSwitchActive(store), false);
  });
});
