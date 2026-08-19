import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { reconcile, type BotDeps } from "../src/live/tradingBot.ts";
import type {
  BotDb,
  DecisionInsert,
  EquitySnapshotInsert,
  IntentInsert,
  IntentRow,
  IntentStatus,
  ParamsDoc,
} from "../src/live/ports.ts";
import type { OandaClient } from "../src/oanda/client.ts";
import type { OandaTransaction } from "../src/oanda/types.ts";
import type { SafetyConfig } from "../src/safety/config.ts";
import { Notifier, type NotifyLevel } from "../src/safety/notifier.ts";
import { RiskManager } from "../src/safety/riskManager.ts";
import { MemoryStateStore, STATE_KEYS } from "../src/safety/state.ts";

/**
 * reconcile (照合) の単体テスト — 最も安全クリティカルな編成ロジック。
 * 特に「カーソル前進とintent解決の間でWorkerが死んだ」ケースで
 * 誤orphan判定しないこと (永続台帳ベースの解決) を回帰テストで固定する。
 */

class FakeBotDb implements BotDb {
  intents: (IntentRow & { oandaTxnId?: string })[] = [];
  /** client_order_id → txn id の永続台帳 (ingestで蓄積) */
  ledger = new Map<string, string>();
  ingested: OandaTransaction[] = [];

  async gateDecision(_d: DecisionInsert): Promise<number | null> {
    throw new Error("not used");
  }
  async updateDecision(): Promise<void> {
    throw new Error("not used");
  }
  async insertIntent(_i: IntentInsert): Promise<void> {
    throw new Error("not used");
  }
  async updateIntent(
    clientId: string,
    fields: { status: IntentStatus; oandaOrderId?: string; oandaTxnId?: string },
  ): Promise<void> {
    const intent = this.intents.find((i) => i.clientId === clientId);
    if (!intent) throw new Error(`intentがない: ${clientId}`);
    intent.status = fields.status;
    if (fields.oandaTxnId !== undefined) intent.oandaTxnId = fields.oandaTxnId;
  }
  async listIntentsByStatus(status: IntentStatus): Promise<IntentRow[]> {
    return this.intents.filter((i) => i.status === status);
  }
  async ingestTransactions(txns: OandaTransaction[]): Promise<void> {
    this.ingested.push(...txns);
    for (const t of txns) {
      const cid = t.clientOrderID ?? t.clientExtensions?.id;
      if (cid) this.ledger.set(cid, t.id);
    }
  }
  async findTransactionByClientOrderId(clientOrderId: string): Promise<{ id: string } | null> {
    const id = this.ledger.get(clientOrderId);
    return id !== undefined ? { id } : null;
  }
  async insertEquitySnapshot(_s: EquitySnapshotInsert): Promise<void> {
    throw new Error("not used");
  }
  async getParams(): Promise<{ version: number; doc: ParamsDoc } | null> {
    throw new Error("not used");
  }
}

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

const NOW = Date.parse("2026-08-20T10:00:00Z");

function fakeClient(overrides: Partial<Record<string, unknown>> = {}): OandaClient {
  return {
    getAccountSummary: async () => ({
      account: { NAV: "1000000", lastTransactionID: "100" },
      lastTransactionID: "100",
    }),
    getTransactionsSince: async () => ({ transactions: [], lastTransactionID: "100" }),
    ...overrides,
  } as unknown as OandaClient;
}

function makeDeps(db: FakeBotDb, client: OandaClient, store: MemoryStateStore): BotDeps {
  return {
    client,
    db,
    store,
    riskManager: new RiskManager(CONFIG, store),
    safetyConfig: CONFIG,
    notifier: new CaptureNotifier(),
    live: false,
  };
}

function intent(clientId: string, status: IntentStatus, ageMs: number): IntentRow {
  return {
    clientId,
    ts: new Date(NOW - ageMs).toISOString(),
    instrument: "USD_JPY",
    units: 1000,
    status,
    decisionId: 1,
  };
}

describe("reconcile", () => {
  it("初回はlastTransactionIdを初期化するだけで取り込みしない", async () => {
    const db = new FakeBotDb();
    const store = new MemoryStateStore();
    await reconcile(makeDeps(db, fakeClient(), store), NOW);
    assert.equal(await store.get(STATE_KEYS.lastTransactionId), "100");
    assert.equal(db.ingested.length, 0);
  });

  it("unknown intentは台帳に約定txnがあればfilledに解決する", async () => {
    const db = new FakeBotDb();
    db.intents.push(intent("fx-a-1", "unknown", 60_000));
    const store = new MemoryStateStore();
    await store.set(STATE_KEYS.lastTransactionId, "100");
    const client = fakeClient({
      getTransactionsSince: async () => ({
        transactions: [
          { id: "101", time: "1755680000", type: "ORDER_FILL", clientOrderID: "fx-a-1" },
        ] as OandaTransaction[],
        lastTransactionID: "101",
      }),
    });
    await reconcile(makeDeps(db, client, store), NOW);
    assert.equal(db.intents[0]!.status, "filled");
    assert.equal(db.intents[0]!.oandaTxnId, "101");
  });

  it("【回帰】カーソル前進後にWorkerが死んでも、次tickで台帳から正しくfilledと判定する", async () => {
    // tick N+1: 約定txnは取り込み済み・カーソル前進済み・intent解決前に死亡 — を再現
    const db = new FakeBotDb();
    db.ledger.set("fx-a-1", "101"); // 台帳には永続化済み
    db.intents.push(intent("fx-a-1", "unknown", 300_000)); // orphan猶予も超過している
    const store = new MemoryStateStore();
    await store.set(STATE_KEYS.lastTransactionId, "101"); // カーソルは前進済み
    // tick N+2: sinceidはもう約定txnを返さない
    const client = fakeClient({
      getTransactionsSince: async () => ({ transactions: [], lastTransactionID: "101" }),
    });
    await reconcile(makeDeps(db, client, store), NOW);
    // レスポンスだけ見る実装ならorphanedに誤判定するが、台帳ベースならfilled
    assert.equal(db.intents[0]!.status, "filled");
  });

  it("unknownは猶予内 (3分未満) なら保留し、猶予超過でorphanedにする", async () => {
    const db = new FakeBotDb();
    db.intents.push(intent("fx-fresh", "unknown", 60_000)); // 1分前
    db.intents.push(intent("fx-old", "unknown", 300_000)); // 5分前
    const store = new MemoryStateStore();
    await store.set(STATE_KEYS.lastTransactionId, "100");
    await reconcile(makeDeps(db, fakeClient(), store), NOW);
    assert.equal(db.intents.find((i) => i.clientId === "fx-fresh")!.status, "unknown");
    assert.equal(db.intents.find((i) => i.clientId === "fx-old")!.status, "orphaned");
  });

  it("pendingは90秒超過でunknownに降格する (それ未満は保留)", async () => {
    const db = new FakeBotDb();
    db.intents.push(intent("fx-p-new", "pending", 30_000));
    db.intents.push(intent("fx-p-old", "pending", 120_000));
    const store = new MemoryStateStore();
    await store.set(STATE_KEYS.lastTransactionId, "100");
    await reconcile(makeDeps(db, fakeClient(), store), NOW);
    assert.equal(db.intents.find((i) => i.clientId === "fx-p-new")!.status, "pending");
    assert.equal(db.intents.find((i) => i.clientId === "fx-p-old")!.status, "unknown");
  });
});
