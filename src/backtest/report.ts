import type { BacktestResult, EquityPoint } from "./engine.ts";
import { computeMetrics, type Metrics } from "./metrics.ts";
import type { WalkForwardResult } from "./walkForward.ts";

/**
 * バックテスト結果のJSONレポート出力 (Node専用)。
 * reports/viewer.html および将来の管理画面がこの形式を読む。
 */

export interface StrategyReport {
  version: 1;
  generatedAt: string;
  strategyId: string;
  instrument: string;
  timeframe: string;
  /** スプレッド感度: markup pips → メトリクス */
  metricsByMarkup: Record<string, Metrics>;
  /** markup=0 のエクイティカーブ (最大2000点にダウンサンプル) */
  equity: EquityPoint[];
  /** markup=0 のトレード (最新500件) */
  trades: BacktestResult["trades"];
  walkForward?: {
    aggregate: Metrics;
    windows: {
      testFrom: number;
      testTo: number;
      bestId: string;
      trainSharpe: number;
      testSharpe: number;
      testReturnPct: number;
    }[];
  };
}

export function buildReport(
  resultsByMarkup: Map<number, BacktestResult>,
  wfa?: WalkForwardResult,
): StrategyReport {
  const baseline = resultsByMarkup.get(0) ?? [...resultsByMarkup.values()][0];
  if (!baseline) throw new Error("結果が空です");

  const metricsByMarkup: Record<string, Metrics> = {};
  for (const [markup, result] of resultsByMarkup) {
    metricsByMarkup[`+${markup.toFixed(1)}`] = computeMetrics(result);
  }

  const report: StrategyReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    strategyId: baseline.strategyId,
    instrument: baseline.instrument,
    timeframe: baseline.timeframe,
    metricsByMarkup,
    equity: downsample(baseline.equity, 2000),
    trades: baseline.trades.slice(-500),
  };
  if (wfa) {
    report.walkForward = {
      aggregate: wfa.aggregate,
      windows: wfa.windows.map((w) => ({
        testFrom: w.testFrom,
        testTo: w.testTo,
        bestId: w.bestId,
        trainSharpe: w.trainMetrics.sharpe,
        testSharpe: w.testMetrics.sharpe,
        testReturnPct: w.testMetrics.totalReturnPct,
      })),
    };
  }
  return report;
}

export async function writeReport(report: StrategyReport, dir?: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const baseDir = dir ?? new URL("../../reports", import.meta.url).pathname;
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-").slice(0, 19);
  const path = `${baseDir}/${stamp}_${report.strategyId}_${report.instrument}.json`;
  await fs.writeFile(path, JSON.stringify(report, null, 1));
  return path;
}

export function downsample(points: EquityPoint[], maxPoints: number): EquityPoint[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: EquityPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.floor(i * step)]!);
  }
  const last = points[points.length - 1]!;
  if (out[out.length - 1]!.time !== last.time) out.push(last);
  return out;
}
