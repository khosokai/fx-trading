import type { BidAskCandle, Timeframe } from "../core/candle.ts";
import type { Strategy } from "../core/strategy.ts";
import {
  DEFAULT_CONFIG,
  runBacktest,
  type BacktestConfig,
  type BacktestResult,
  type EquityPoint,
  type RunOptions,
  type TradeRecord,
} from "./engine.ts";
import { computeMetrics, type Metrics } from "./metrics.ts";
import { assertCompleteness } from "../data/completeness.ts";

/**
 * ウォークフォワード分析 (WFA)。gmo-coinから移植。
 * 「学習期間でパラメータ選択 → 直後の検証期間で評価」を時間をずらしながら繰り返し、
 * 検証期間(アウト・オブ・サンプル)の成績だけを繋いで評価する。
 * 1回きりのイン/アウト分割より過学習に厳しい検証法。
 */

/** fromTime以降を評価対象に、warmup分の助走データを付けてバックテストする */
export function runRange(
  candles: BidAskCandle[],
  strategy: Strategy,
  instrument: string,
  fromTime: number,
  toTime: number,
  config: BacktestConfig = DEFAULT_CONFIG,
  options: RunOptions = {},
): BacktestResult {
  const startIdx = candles.findIndex((c) => c.time >= fromTime);
  if (startIdx < 0) throw new Error("期間内にデータがありません");
  const slice = candles
    .slice(Math.max(0, startIdx - strategy.warmup))
    .filter((c) => c.time < toTime);
  return runBacktest(slice, strategy, instrument, config, options);
}

export interface WalkForwardWindow {
  trainFrom: number;
  testFrom: number;
  testTo: number;
  /** 学習期間でシャープレシオ最良だった戦略 */
  bestId: string;
  trainMetrics: Metrics;
  testMetrics: Metrics;
  testResult: BacktestResult;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  /** 全検証期間を繋いだアウト・オブ・サンプル成績 */
  aggregate: Metrics;
  oosFrom: number;
  oosTo: number;
}

export interface WalkForwardOptions {
  trainDays: number;
  testDays: number;
  config?: BacktestConfig;
  runOptions?: RunOptions;
  /**
   * データ完全性ゲートの欠損率閾値 (デフォルト0.2)。false で無効化できるが、
   * それは合成データのテスト専用 — 実データの研究で無効化してはならない
   * (docs/research.md 2026-08-21: EUR/USD 11ヶ月欠損に4ラウンド気づかなかった
   * 事故の再発防止として、WFA自体が不完全データを拒否する)
   */
  completeness?: number | false;
}

export function walkForward(
  candles: BidAskCandle[],
  candidates: Strategy[],
  instrument: string,
  opts: WalkForwardOptions,
): WalkForwardResult {
  if (candles.length === 0) throw new Error("candlesが空です");
  if (candidates.length === 0) throw new Error("candidatesが空です");
  const timeframe = candidates[0]!.timeframe;
  if (!candidates.every((c) => c.timeframe === timeframe)) {
    throw new Error("candidatesの時間軸が揃っていません");
  }
  // 不完全データでのWFAを構造的に禁止する (実行を拒否。閾値超の月を列挙して投げる)
  if (opts.completeness !== false) {
    assertCompleteness(candles, timeframe, opts.completeness);
  }
  const config = opts.config ?? DEFAULT_CONFIG;
  const runOptions = opts.runOptions ?? {};
  const trainMs = opts.trainDays * 86_400_000;
  const testMs = opts.testDays * 86_400_000;
  const start = candles[0]!.time;
  const end = candles[candles.length - 1]!.time;

  const windows: WalkForwardWindow[] = [];
  for (let cursor = start; cursor + trainMs + testMs / 2 < end; cursor += testMs) {
    const trainFrom = cursor;
    const testFrom = cursor + trainMs;
    const testTo = Math.min(testFrom + testMs, end + 1);

    // 学習期間で全候補を評価し、シャープレシオ最良を選ぶ
    let best: { strategy: Strategy; metrics: Metrics } | null = null;
    for (const strategy of candidates) {
      let metrics: Metrics;
      try {
        metrics = computeMetrics(
          runRange(candles, strategy, instrument, trainFrom, testFrom, config, runOptions),
        );
      } catch {
        continue; // データ不足の候補はスキップ
      }
      if (!best || metrics.sharpe > best.metrics.sharpe) best = { strategy, metrics };
    }
    if (!best) continue;

    // 選ばれた1つだけを検証期間で評価する
    let testResult: BacktestResult;
    try {
      testResult = runRange(candles, best.strategy, instrument, testFrom, testTo, config, runOptions);
    } catch {
      continue;
    }
    windows.push({
      trainFrom,
      testFrom,
      testTo,
      bestId: best.strategy.id,
      trainMetrics: best.metrics,
      testMetrics: computeMetrics(testResult),
      testResult,
    });
  }
  if (windows.length === 0) throw new Error("ウィンドウを1つも作れませんでした (データ不足)");

  return {
    windows,
    aggregate: stitchMetrics(windows, instrument, timeframe, config),
    oosFrom: windows[0]!.testFrom,
    oosTo: windows[windows.length - 1]!.testTo,
  };
}

/** 各ウィンドウの検証期間エクイティを複利で繋ぎ、全体の成績を計算する */
function stitchMetrics(
  windows: WalkForwardWindow[],
  instrument: string,
  timeframe: Timeframe,
  config: BacktestConfig,
): Metrics {
  const equity: EquityPoint[] = [];
  const trades: TradeRecord[] = [];
  let capital = config.initialEquityJpy;

  for (const w of windows) {
    const points = w.testResult.equity;
    const base = points[0]!.value;
    for (const p of points) {
      equity.push({ time: p.time, value: (capital * p.value) / base });
    }
    // 強制決済込みの最終値で次ウィンドウへ複利継続
    capital = (capital * w.testResult.finalEquity) / base;
    trades.push(...w.testResult.trades);
  }

  const stitched: BacktestResult = {
    strategyId: "walkForward",
    instrument,
    timeframe,
    config,
    equity,
    trades,
    finalEquity: capital,
  };
  return computeMetrics(stitched);
}
