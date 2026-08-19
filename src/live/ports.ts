import type { OandaTransaction } from "../oanda/types.ts";

/**
 * ライブボットが必要とする永続化の抽象。
 * 実装は worker/db.ts (D1)。src/live は worker/ に依存しない。
 */

export interface DecisionInsert {
  ts: string;
  strategyId: string;
  instrument: string;
  barTime: number;
  closeBid: number;
  closeAsk: number;
  position: number;
  target: number;
  action: "none" | "open" | "close" | "reverse";
  slPips?: number;
  tpPips?: number;
  status: "ok" | "blocked" | "error" | "dry_run";
  reason?: string;
  paramVersion?: number;
  live: boolean;
}

export interface IntentInsert {
  clientId: string;
  ts: string;
  instrument: string;
  units: number;
  slDistancePips?: number;
  tpPrice?: number;
  decisionId?: number;
}

export type IntentStatus = "pending" | "created" | "filled" | "rejected" | "unknown" | "orphaned";

export interface IntentRow {
  clientId: string;
  ts: string;
  instrument: string;
  units: number;
  status: IntentStatus;
  decisionId: number | null;
}

export interface EquitySnapshotInsert {
  ts: string;
  nav: number;
  balance: number;
  marginUsed: number;
  unrealizedPl: number;
  spreadPips?: number;
  openUnits: number;
}

export interface ParamsDoc {
  strategies: StrategyParamsEntry[];
}

export interface StrategyParamsEntry {
  /** レジストリのキー ("donchian" | "sessionBreakout" | "bbRsi") */
  type: string;
  enabled: boolean;
  instrument: string;
  /** 1トレードのリスク割合(%)。SAFETY_MAX_RISK_PCTでキャップされる */
  riskPct: number;
  takeProfitR?: number;
  params: Record<string, number | string>;
}

export interface BotDb {
  /**
   * バーゲート付きの判定記録。同一 (strategy, instrument, barTime) が
   * 既に存在すればnull (= このバーは処理済み、以降の処理をスキップ)。
   */
  gateDecision(d: DecisionInsert): Promise<number | null>;
  updateDecision(
    id: number,
    fields: { status?: string; reason?: string; action?: string },
  ): Promise<void>;
  insertIntent(i: IntentInsert): Promise<void>;
  updateIntent(
    clientId: string,
    fields: { status: IntentStatus; oandaOrderId?: string; oandaTxnId?: string },
  ): Promise<void>;
  listIntentsByStatus(status: IntentStatus): Promise<IntentRow[]>;
  /** transaction台帳への冪等取り込み (INSERT OR IGNORE) + trades導出更新 */
  ingestTransactions(txns: OandaTransaction[]): Promise<void>;
  insertEquitySnapshot(s: EquitySnapshotInsert): Promise<void>;
  getParams(): Promise<{ version: number; doc: ParamsDoc } | null>;
}
