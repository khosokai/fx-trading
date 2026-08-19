import type { BidAskCandle, Timeframe } from "./candle.ts";

/**
 * 戦略の契約。バックテストエンジンと本番Workerが「同一の実装」を実行する
 * (パリティ原則)。戦略はここで定義された情報以外を見てはならない。
 */

/** 目標ポジション方向: -1=ショート, 0=ノーポジ, 1=ロング */
export type Signal = -1 | 0 | 1;

export interface StrategyContext {
  /** OANDA形式のインストルメント名 (例: "USD_JPY") */
  instrument: string;
  /**
   * 戦略の主時間軸のローソク足 (確定足のみ)。
   * candles[0..index] が「見えている」情報。未来は存在しない。
   */
  candles: BidAskCandle[];
  index: number;
  /**
   * M1から共通ロジックで集計した上位足の全系列。
   * 【重要】未来を含む配列なので、htfIndex[tf] より先を見てはならない。
   */
  htf: Partial<Record<Timeframe, BidAskCandle[]>>;
  /** 各上位足について「現在のバーの終了時刻までに確定している」最後のインデックス */
  htfIndex: Partial<Record<Timeframe, number>>;
  /** 現在のポジション方向 */
  position: Signal;
}

export interface Decision {
  target: Signal;
  /** target≠0 のとき必須。エンジン/発注層が強制する (サーバー側SLの根拠) */
  stopLossPips?: number;
  takeProfitPips?: number;
  /**
   * リスク予算(riskPct)の何割を使うか (0〜1、省略時1)。
   * ATRサイジング等はここで表現する。
   */
  riskFraction?: number;
  /** 判定理由 (ログ用、動作には影響しない) */
  reason?: string;
}

export interface Strategy {
  /** 安定ID。decisions/paramsに記録される (例: "donchian_v1") */
  id: string;
  name: string;
  /** 主時間軸。本番ではこの足が新しく確定したときだけdecideが呼ばれる */
  timeframe: Timeframe;
  /** 主時間軸で必要な助走本数。これに達するまでdecideは呼ばれない */
  warmup: number;
  decide(ctx: StrategyContext): Decision;
}

/** フラット判定 (target=0) のショートハンド */
export const FLAT: Decision = { target: 0 };
