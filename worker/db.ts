import type {
  BotDb,
  DecisionInsert,
  EquitySnapshotInsert,
  IntentInsert,
  IntentRow,
  IntentStatus,
  ParamsDoc,
} from "../src/live/ports.ts";
import type { OandaTransaction } from "../src/oanda/types.ts";

/**
 * D1によるBotDb実装。
 * - decisions: UNIQUE(strategy_id, instrument, bar_time) によるバーゲート
 * - oanda_transactions: id主キー + INSERT OR IGNORE で取り込みが冪等
 * - trades: ORDER_FILLのtradeOpened/tradesClosedから導出 (trade_idで冪等)
 */
export class D1BotDb implements BotDb {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async gateDecision(d: DecisionInsert): Promise<number | null> {
    const res = await this.db
      .prepare(
        `INSERT INTO decisions
           (ts, strategy_id, instrument, bar_time, close_bid, close_ask,
            position, target, action, sl_pips, tp_pips, status, reason, param_version, live)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (strategy_id, instrument, bar_time) DO NOTHING
         RETURNING id`,
      )
      .bind(
        d.ts,
        d.strategyId,
        d.instrument,
        d.barTime,
        d.closeBid,
        d.closeAsk,
        d.position,
        d.target,
        d.action,
        d.slPips ?? null,
        d.tpPips ?? null,
        d.status,
        d.reason ?? null,
        d.paramVersion ?? null,
        d.live ? 1 : 0,
      )
      .first<{ id: number }>();
    return res?.id ?? null;
  }

  async updateDecision(
    id: number,
    fields: { status?: string; reason?: string; action?: string },
  ): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.status !== undefined) {
      sets.push("status = ?");
      binds.push(fields.status);
    }
    if (fields.reason !== undefined) {
      sets.push("reason = ?");
      binds.push(fields.reason);
    }
    if (fields.action !== undefined) {
      sets.push("action = ?");
      binds.push(fields.action);
    }
    if (sets.length === 0) return;
    binds.push(id);
    await this.db
      .prepare(`UPDATE decisions SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
  }

  async insertIntent(i: IntentInsert): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO orders_intent
           (client_id, ts, instrument, units, sl_distance_pips, tp_price, decision_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .bind(
        i.clientId,
        i.ts,
        i.instrument,
        i.units,
        i.slDistancePips ?? null,
        i.tpPrice ?? null,
        i.decisionId ?? null,
      )
      .run();
  }

  async updateIntent(
    clientId: string,
    fields: { status: IntentStatus; oandaOrderId?: string; oandaTxnId?: string },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE orders_intent
         SET status = ?,
             oanda_order_id = COALESCE(?, oanda_order_id),
             oanda_txn_id = COALESCE(?, oanda_txn_id),
             resolved_at = CASE WHEN ? IN ('filled','rejected','orphaned') THEN datetime('now') ELSE resolved_at END
         WHERE client_id = ?`,
      )
      .bind(fields.status, fields.oandaOrderId ?? null, fields.oandaTxnId ?? null, fields.status, clientId)
      .run();
  }

  async listIntentsByStatus(status: IntentStatus): Promise<IntentRow[]> {
    const res = await this.db
      .prepare(
        `SELECT client_id, ts, instrument, units, status, decision_id
         FROM orders_intent WHERE status = ? ORDER BY ts`,
      )
      .bind(status)
      .all<{
        client_id: string;
        ts: string;
        instrument: string;
        units: number;
        status: IntentStatus;
        decision_id: number | null;
      }>();
    return res.results.map((r) => ({
      clientId: r.client_id,
      ts: r.ts,
      instrument: r.instrument,
      units: r.units,
      status: r.status,
      decisionId: r.decision_id,
    }));
  }

  async ingestTransactions(txns: OandaTransaction[]): Promise<void> {
    for (const t of txns) {
      const id = Number(t.id);
      if (!Number.isFinite(id)) continue;
      const ts = unixToIso(t.time);
      // 生台帳への冪等取り込み
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO oanda_transactions
             (id, ts, type, instrument, units, price, pl, financing, reason, client_order_id, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          ts,
          t.type,
          t.instrument ?? null,
          t.units !== undefined ? Number(t.units) : null,
          t.price !== undefined ? Number(t.price) : null,
          t.pl !== undefined ? Number(t.pl) : null,
          t.financing !== undefined ? Number(t.financing) : null,
          t.reason ?? null,
          t.clientOrderID ?? t.clientExtensions?.id ?? null,
          JSON.stringify(t),
        )
        .run();

      // トレード導出 (ORDER_FILLのみ)
      if (t.type === "ORDER_FILL") {
        if (t.tradeOpened) {
          await this.db
            .prepare(
              `INSERT INTO trades (oanda_trade_id, instrument, units, entry_ts, entry_price, strategy_id, state)
               VALUES (?, ?, ?, ?, ?, ?, 'open')
               ON CONFLICT (oanda_trade_id) DO NOTHING`,
            )
            .bind(
              t.tradeOpened.tradeID,
              t.instrument ?? "",
              Number(t.tradeOpened.units),
              ts,
              Number(t.tradeOpened.price),
              t.clientExtensions?.tag ?? null,
            )
            .run();
        }
        for (const closed of t.tradesClosed ?? []) {
          await this.db
            .prepare(
              `UPDATE trades
               SET exit_ts = ?, exit_price = ?, pl_jpy = ?,
                   financing_jpy = financing_jpy + ?, state = 'closed'
               WHERE oanda_trade_id = ? AND state = 'open'`,
            )
            .bind(
              ts,
              Number(closed.price),
              Number(closed.realizedPL),
              t.financing !== undefined ? Number(t.financing) : 0,
              closed.tradeID,
            )
            .run();
        }
      }
    }
  }

  async findTransactionByClientOrderId(clientOrderId: string): Promise<{ id: string } | null> {
    const row = await this.db
      .prepare("SELECT id FROM oanda_transactions WHERE client_order_id = ? LIMIT 1")
      .bind(clientOrderId)
      .first<{ id: number }>();
    return row ? { id: String(row.id) } : null;
  }

  async insertEquitySnapshot(s: EquitySnapshotInsert): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO equity_snapshots
           (ts, nav, balance, margin_used, unrealized_pl, spread_pips, open_units)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(s.ts, s.nav, s.balance, s.marginUsed, s.unrealizedPl, s.spreadPips ?? null, s.openUnits)
      .run();
  }

  async getParams(): Promise<{ version: number; doc: ParamsDoc } | null> {
    const row = await this.db
      .prepare("SELECT version, json FROM params WHERE id = 1")
      .first<{ version: number; json: string }>();
    if (!row) return null;
    return { version: row.version, doc: JSON.parse(row.json) as ParamsDoc };
  }

  /**
   * 当月のUSD建て取引量 (新規+決済の両フィルを合算 = OANDAのGold判定と同じ数え方)。
   * 台帳からのSUM導出のみ。加算カウンタは持たない (並行tick二重加算の排除)。
   */
  async monthlyUsdNotional(month: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT SUM(CASE
                  WHEN instrument LIKE 'USD/_%' ESCAPE '/' THEN ABS(units)
                  WHEN instrument LIKE '%/_USD' ESCAPE '/' THEN ABS(units) * price
                  ELSE 0
                END) AS usd
         FROM oanda_transactions
         WHERE type = 'ORDER_FILL' AND ts LIKE ?`,
      )
      .bind(`${month}%`)
      .first<{ usd: number | null }>();
    return row?.usd ?? 0;
  }

  /** パラメータ保存: version+1で本体を更新し、履歴に追記する */
  async saveParams(doc: ParamsDoc, note?: string): Promise<number> {
    const current = await this.db
      .prepare("SELECT version FROM params WHERE id = 1")
      .first<{ version: number }>();
    const version = (current?.version ?? 0) + 1;
    const json = JSON.stringify(doc);
    const now = new Date().toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO params (id, version, json, updated_at) VALUES (1, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at`,
        )
        .bind(version, json, now),
      this.db
        .prepare("INSERT INTO params_history (version, json, updated_at, note) VALUES (?, ?, ?, ?)")
        .bind(version, json, now, note ?? null),
    ]);
    return version;
  }
}

/** OANDAのUNIX秒文字列 → ISO8601 */
function unixToIso(unix: string): string {
  return new Date(Math.round(Number(unix) * 1000)).toISOString();
}
