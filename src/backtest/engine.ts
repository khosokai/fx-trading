import { TF_MS, type BidAskCandle, type Timeframe } from "../core/candle.ts";
import { pipSize, pipValueJpyPerUnit, quoteCurrency } from "../core/pips.ts";
import {
  inSession,
  isRolloverBlackout,
  isWeekendClosed,
  rolloverFinancingDays,
  type SessionName,
} from "../core/sessions.ts";
import type { Decision, Signal, Strategy, StrategyContext } from "../core/strategy.ts";

/**
 * Bid/Askスプレッド対応のロング/ショート・バックテストエンジン。
 *
 * 規律 (gmo-coinの実証済み設計を踏襲):
 * - シグナルは足の終値で判定し、翌足の始値で執行する (先読み防止)
 * - 買いはAsk、売りはBidで約定する (スプレッドが常にコストになる)
 *
 * バー内SL/TPの保守的固定ルール (テストで恒久化。変更時はテストも必ず更新):
 * ① 判定はエグジット側価格 (ロング→Bid足、ショート→Ask足)
 * ② 窓開けで始値が既にSLを超えていれば始値で約定 (さらにSLスリッページを加算)
 * ③ 同一バーでSLとTPの両方にタッチしたら SL約定とみなす (最悪ケース)
 * ④ TPは指値どおり約定 (窓開けでも有利方向には滑らせない)。
 *    SLには設定可能な不利スリッページを標準で上乗せする
 *    (stopLossOnFillは保証SLではない。介入日等で額面約定を仮定すると過大評価)
 */

export interface BacktestConfig {
  initialEquityJpy: number;
  /** 1トレードでリスクに晒すequityの割合 (%)。SL幅から逆算してサイズが決まる */
  riskPct: number;
  /** ユニット数の上限 (安全キャップ) */
  maxUnits: number;
  /** 証拠金レバレッジ上限 (国内FXは25倍) */
  leverage: number;
  /** 成行約定に上乗せする追加スリッページ (pips)。エントリー/シグナル決済に適用 */
  extraSlippagePips: number;
  /** SL約定に上乗せする不利スリッページ (pips) */
  slSlippagePips: number;
  /**
   * スプレッド上乗せ (pips)。感度分析用。
   * DukascopyはECN系でリテール実スプレッドより狭い可能性があるため、
   * +0.2 / +0.5 を標準レポートに併記する。半分ずつBid/Ask両側に振る。
   */
  spreadMarkupPips: number;
  /** スワップポイント (pips/日)。正=受取, 負=支払。未指定は0 */
  swapPipsPerDay?: { long: number; short: number };
  /** 週末クローズ前に強制フラットするか (デイトレ標準: true) */
  flattenBeforeWeekend: boolean;
  /** 指定時はこのセッション中のみ新規エントリーを許可する (決済は常時可) */
  sessionFilter?: SessionName[];
  /**
   * 非JPYクォートペアのpip価値換算 (1unitあたりJPY)。
   * EUR/USD等では同時刻のUSD/JPYレートから作って渡す。
   * JPYクォートペアでは省略可 (pipSizeがそのままJPY)。
   */
  pipValueJpyAt?: (ms: number) => number;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  initialEquityJpy: 1_000_000,
  riskPct: 0.5,
  maxUnits: 100_000,
  leverage: 25,
  extraSlippagePips: 0,
  slSlippagePips: 0.3,
  spreadMarkupPips: 0,
  flattenBeforeWeekend: true,
};

export type CloseReason = "signal" | "sl" | "tp" | "weekend" | "end";

export interface TradeRecord {
  direction: 1 | -1;
  units: number;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  plPips: number;
  /** スワップ込みの損益 (JPY) */
  plJpy: number;
  swapJpy: number;
  /** エントリー時スプレッド (pips, 上乗せ込み) */
  entrySpreadPips: number;
  closeReason: CloseReason;
}

export interface EquityPoint {
  time: number;
  value: number;
}

export interface BacktestResult {
  strategyId: string;
  instrument: string;
  timeframe: Timeframe;
  config: BacktestConfig;
  equity: EquityPoint[];
  trades: TradeRecord[];
  finalEquity: number;
}

interface OpenPosition {
  direction: 1 | -1;
  units: number;
  entryTime: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number | null;
  entrySpreadPips: number;
  swapJpy: number;
}

export interface RunOptions {
  /** 上位足 (M1から集計済み)。ctx.htf / ctx.htfIndex に渡される */
  htf?: Partial<Record<Timeframe, BidAskCandle[]>>;
}

export function runBacktest(
  candles: BidAskCandle[],
  strategy: Strategy,
  instrument: string,
  config: BacktestConfig = DEFAULT_CONFIG,
  options: RunOptions = {},
): BacktestResult {
  if (candles.length <= strategy.warmup + 1) {
    throw new Error(`データ不足: ${candles.length}本 (warmup=${strategy.warmup})`);
  }
  const pip = pipSize(instrument);
  const tfMs = TF_MS[strategy.timeframe];
  const markupHalf = (config.spreadMarkupPips / 2) * pip;
  const pipValueAt = resolvePipValue(instrument, config);
  const htf = options.htf ?? {};
  const htfKeys = Object.keys(htf) as Timeframe[];

  let cash = config.initialEquityJpy;
  let pos: OpenPosition | null = null;
  const trades: TradeRecord[] = [];
  const equity: EquityPoint[] = [];
  let pending: Decision | null = null;

  // 上位足インデックスは単調増加なのでカーソルを進めるだけでよい
  const htfCursor: Partial<Record<Timeframe, number>> = {};
  for (const tf of htfKeys) htfCursor[tf] = -1;

  const closeTrade = (
    exitTime: number,
    rawExitPrice: number,
    reason: CloseReason,
  ): void => {
    if (!pos) return;
    const plPips = ((rawExitPrice - pos.entryPrice) / pip) * pos.direction;
    const plJpy = plPips * pipValueAt(exitTime) * pos.units + pos.swapJpy;
    cash += plJpy;
    trades.push({
      direction: pos.direction,
      units: pos.units,
      entryTime: pos.entryTime,
      entryPrice: pos.entryPrice,
      exitTime,
      exitPrice: rawExitPrice,
      plPips,
      plJpy,
      swapJpy: pos.swapJpy,
      entrySpreadPips: pos.entrySpreadPips,
      closeReason: reason,
    });
    pos = null;
  };

  const tryOpen = (bar: BidAskCandle, decision: Decision): void => {
    const target = decision.target;
    if (target === 0) return;
    // エントリーフィルタ: セッション / ロールオーバーブラックアウト / 週末直前
    if (config.sessionFilter && !config.sessionFilter.some((s) => inSession(bar.time, s))) return;
    if (isRolloverBlackout(bar.time)) return;
    if (config.flattenBeforeWeekend && isWeekendClosed(bar.time + tfMs)) return;

    const slPips = decision.stopLossPips;
    if (slPips === undefined || !(slPips > 0)) {
      throw new Error(`戦略 ${strategy.id} がSLなしでエントリーしようとした (stopLossPips必須)`);
    }
    const effAskO = bar.ask.o + markupHalf;
    const effBidO = bar.bid.o - markupHalf;
    const slip = config.extraSlippagePips * pip;
    const entryPrice = target === 1 ? effAskO + slip : effBidO - slip;

    const riskFraction = clamp01(decision.riskFraction ?? 1);
    const pipValue = pipValueAt(bar.time);
    const riskBudget = cash * (config.riskPct / 100) * riskFraction;
    let units = Math.floor(riskBudget / (slPips * pipValue));
    // 証拠金キャップ (JPYクォートは price×units/leverage が必要証拠金。
    // 非JPYはpip価値換算レートで近似)
    const jpyPerPricePoint = pipValue / pip; // 1unitあたり価格1.0の変動が何JPYか
    const marginCap = Math.floor((cash * config.leverage) / (entryPrice * jpyPerPricePoint));
    units = Math.min(units, marginCap, config.maxUnits);
    if (units < 1) return;

    pos = {
      direction: target,
      units,
      entryTime: bar.time,
      entryPrice,
      slPrice: entryPrice - target * slPips * pip,
      tpPrice:
        decision.takeProfitPips !== undefined && decision.takeProfitPips > 0
          ? entryPrice + target * decision.takeProfitPips * pip
          : null,
      entrySpreadPips: (effAskO - effBidO) / pip,
      swapJpy: 0,
    };
  };

  for (let i = strategy.warmup; i < candles.length; i++) {
    const bar = candles[i]!;

    // 1. 前の足の終値時点の判定を、この足の始値で執行する
    if (pending) {
      const decision = pending;
      pending = null;
      if (pos !== null && decision.target !== (pos as OpenPosition).direction) {
        const p = pos as OpenPosition;
        const slip = config.extraSlippagePips * pip;
        const exitPrice =
          p.direction === 1 ? bar.bid.o - markupHalf - slip : bar.ask.o + markupHalf + slip;
        closeTrade(bar.time, exitPrice, "signal");
      }
      if (pos === null) tryOpen(bar, decision);
    }

    // 2. バー内SL/TP判定 (保守的ルール①〜④)
    if (pos) {
      const p: OpenPosition = pos;
      const slSlip = config.slSlippagePips * pip;
      if (p.direction === 1) {
        const o = bar.bid.o - markupHalf;
        const h = bar.bid.h - markupHalf;
        const l = bar.bid.l - markupHalf;
        if (o <= p.slPrice) {
          closeTrade(bar.time, o - slSlip, "sl"); // ② 窓開けSL
        } else if (l <= p.slPrice) {
          closeTrade(bar.time, p.slPrice - slSlip, "sl"); // ③ SL優先
        } else if (p.tpPrice !== null && h >= p.tpPrice) {
          closeTrade(bar.time, p.tpPrice, "tp"); // ④ TPは指値どおり
        }
      } else {
        const o = bar.ask.o + markupHalf;
        const h = bar.ask.h + markupHalf;
        const l = bar.ask.l + markupHalf;
        if (o >= p.slPrice) {
          closeTrade(bar.time, o + slSlip, "sl");
        } else if (h >= p.slPrice) {
          closeTrade(bar.time, p.slPrice + slSlip, "sl");
        } else if (p.tpPrice !== null && l <= p.tpPrice) {
          closeTrade(bar.time, p.tpPrice, "tp");
        }
      }
    }

    // 3. スワップ近似: この足の区間で跨いだロールオーバー分を積む
    if (pos && config.swapPipsPerDay) {
      const p: OpenPosition = pos;
      const days = rolloverFinancingDays(bar.time, bar.time + tfMs);
      if (days > 0) {
        const rate = p.direction === 1 ? config.swapPipsPerDay.long : config.swapPipsPerDay.short;
        p.swapJpy += days * rate * pipValueAt(bar.time) * p.units;
      }
    }

    // 4. 週末前強制フラット (この足が週末クローズ前の最後の足)
    if (pos && config.flattenBeforeWeekend && isWeekendClosed(bar.time + tfMs)) {
      const p: OpenPosition = pos;
      const slip = config.extraSlippagePips * pip;
      const exitPrice =
        p.direction === 1 ? bar.bid.c - markupHalf - slip : bar.ask.c + markupHalf + slip;
      closeTrade(bar.time, exitPrice, "weekend");
    }

    // 5. 終値で戦略判定 (次の足の始値で執行される)
    const barCloseTime = bar.time + tfMs;
    for (const tf of htfKeys) {
      const series = htf[tf]!;
      let cursor = htfCursor[tf]!;
      while (
        cursor + 1 < series.length &&
        series[cursor + 1]!.time + TF_MS[tf] <= barCloseTime
      ) {
        cursor += 1;
      }
      htfCursor[tf] = cursor;
    }
    const position: Signal = pos === null ? 0 : (pos as OpenPosition).direction;
    const ctx: StrategyContext = {
      instrument,
      candles,
      index: i,
      htf,
      htfIndex: { ...htfCursor },
      position,
    };
    const decision = strategy.decide(ctx);
    if (decision.target !== position) pending = decision;

    // 6. 足の終値でのequity記録 (含み損益はエグジット側価格で評価)
    let value = cash;
    if (pos) {
      const p: OpenPosition = pos;
      const mark = p.direction === 1 ? bar.bid.c - markupHalf : bar.ask.c + markupHalf;
      const unrealizedPips = ((mark - p.entryPrice) / pip) * p.direction;
      value += unrealizedPips * pipValueAt(bar.time) * p.units + p.swapJpy;
    }
    equity.push({ time: bar.time, value });
  }

  // 最終足で強制決済して損益を確定する
  const last = candles[candles.length - 1]!;
  if (pos) {
    const p: OpenPosition = pos;
    const exitPrice = p.direction === 1 ? last.bid.c - markupHalf : last.ask.c + markupHalf;
    closeTrade(last.time, exitPrice, "end");
    equity[equity.length - 1] = { time: last.time, value: cash };
  }

  return {
    strategyId: strategy.id,
    instrument,
    timeframe: strategy.timeframe,
    config,
    equity,
    trades,
    finalEquity: cash,
  };
}

function resolvePipValue(instrument: string, config: BacktestConfig): (ms: number) => number {
  if (config.pipValueJpyAt) return config.pipValueJpyAt;
  if (quoteCurrency(instrument) === "JPY") {
    const v = pipValueJpyPerUnit(instrument);
    return () => v;
  }
  throw new Error(
    `${instrument} はJPYクォートではないため config.pipValueJpyAt が必要です (USD/JPYレート換算)`,
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}
