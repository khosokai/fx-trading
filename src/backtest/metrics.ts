import { TF_MS, type Timeframe } from "../core/candle.ts";
import type { BacktestResult } from "./engine.ts";

export interface Metrics {
  totalReturnPct: number;
  /** 年率換算リターン */
  cagrPct: number;
  /** 年率換算シャープレシオ (リスクフリーレート0) */
  sharpe: number;
  maxDrawdownPct: number;
  tradeCount: number;
  winRatePct: number;
  profitFactor: number;
  /** 1トレードあたり期待値 (JPY) */
  expectancyJpy: number;
  /** 1トレードあたり期待値 (pips) */
  expectancyPips: number;
  totalPips: number;
  /** 支払ったエントリースプレッドの合計 (pips) */
  totalSpreadCostPips: number;
  /** 1トレードあたり平均スプレッドコスト (pips) */
  avgSpreadPips: number;
  maxConsecutiveLosses: number;
  periodDays: number;
}

export function computeMetrics(result: BacktestResult, timeframe?: Timeframe): Metrics {
  const tf = timeframe ?? result.timeframe;
  const { equity, trades, config } = result;
  const first = equity[0];
  const last = equity[equity.length - 1];
  if (!first || !last) throw new Error("equityが空です");

  const totalReturn = result.finalEquity / config.initialEquityJpy - 1;
  const periodDays = (last.time - first.time) / 86_400_000;
  const years = periodDays / 365;
  const cagr = years > 0 && totalReturn > -1 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;

  // 足ごとのリターンからシャープレシオを年率換算
  // (FXは週末休場だが、比較用の一貫した慣行としてカレンダー換算を使う)
  const periodsPerYear = (365 * 86_400_000) / TF_MS[tf];
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!.value;
    returns.push(prev > 0 ? equity[i]!.value / prev - 1 : 0);
  }
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 0 ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, 1 - p.value / peak);
  }

  const wins = trades.filter((t) => t.plJpy > 0);
  const losses = trades.filter((t) => t.plJpy <= 0);
  const grossWin = wins.reduce((a, t) => a + t.plJpy, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.plJpy, 0);
  const totalPl = trades.reduce((a, t) => a + t.plJpy, 0);
  const totalPips = trades.reduce((a, t) => a + t.plPips, 0);
  const totalSpreadCostPips = trades.reduce((a, t) => a + t.entrySpreadPips, 0);

  let maxConsecutiveLosses = 0;
  let streak = 0;
  for (const t of trades) {
    if (t.plJpy <= 0) {
      streak += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
    } else {
      streak = 0;
    }
  }

  return {
    totalReturnPct: totalReturn * 100,
    cagrPct: cagr * 100,
    sharpe,
    maxDrawdownPct: maxDrawdown * 100,
    tradeCount: trades.length,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancyJpy: trades.length > 0 ? totalPl / trades.length : 0,
    expectancyPips: trades.length > 0 ? totalPips / trades.length : 0,
    totalPips,
    totalSpreadCostPips,
    avgSpreadPips: trades.length > 0 ? totalSpreadCostPips / trades.length : 0,
    maxConsecutiveLosses,
    periodDays: Math.round(periodDays),
  };
}

export function formatMetrics(m: Metrics): string {
  return [
    `期間: ${m.periodDays}日`,
    `総リターン: ${m.totalReturnPct.toFixed(1)}%`,
    `年率: ${m.cagrPct.toFixed(1)}%`,
    `シャープ: ${m.sharpe.toFixed(2)}`,
    `最大DD: -${m.maxDrawdownPct.toFixed(1)}%`,
    `取引数: ${m.tradeCount}`,
    `勝率: ${m.winRatePct.toFixed(0)}%`,
    `PF: ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`,
    `期待値: ${m.expectancyPips.toFixed(2)}pips (スプレッド平均 ${m.avgSpreadPips.toFixed(2)}pips)`,
  ].join("  ");
}
