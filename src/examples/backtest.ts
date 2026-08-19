import { aggregateCandles } from "../core/aggregate.ts";
import type { Timeframe } from "../core/candle.ts";
import { runBacktest, DEFAULT_CONFIG, type BacktestConfig } from "../backtest/engine.ts";
import { computeMetrics, formatMetrics } from "../backtest/metrics.ts";
import { buildReport, writeReport } from "../backtest/report.ts";
import type { Strategy } from "../core/strategy.ts";
import { LocalChunkStore } from "../data/store.ts";
import { makeBbRsiReversion } from "../strategies/bbRsiReversion.ts";
import { makeDonchian } from "../strategies/donchian.ts";
import { makeSessionBreakout } from "../strategies/sessionBreakout.ts";

/**
 * 単発バックテストの実行例。
 *   npm run backtest                      # デフォルト: 全戦略 × USD_JPY 全期間
 *   node src/examples/backtest.ts USD_JPY 2023-01-01 2026-01-01
 *
 * スプレッド感度 (+0.2 / +0.5 pips) を常に併記する。
 * Dukascopyより本番スプレッドが広い可能性を織り込むため、
 * 上乗せで期待値が消える戦略はこの時点で棄却する。
 */

const DATA_DIR = new URL("../../data/candles", import.meta.url).pathname;
const MARKUPS = [0, 0.2, 0.5];

function defaultStrategies(): Strategy[] {
  return [
    makeDonchian({ timeframe: "M15", entryPeriod: 40, exitPeriod: 20, atrPeriod: 14, slAtrMult: 2 }),
    makeSessionBreakout({ timeframe: "M15", minRangePips: 20, maxRangePips: 80, maxSlPips: 40, tpR: 1.5 }),
    makeBbRsiReversion({
      timeframe: "M15",
      bbPeriod: 20,
      bbSigma: 2,
      rsiPeriod: 14,
      rsiLower: 30,
      rsiUpper: 70,
      atrPeriod: 14,
      slAtrMult: 1.5,
    }),
  ];
}

async function main(): Promise<void> {
  const [instrumentArg, fromArg, toArg] = process.argv.slice(2);
  const instrument = instrumentArg ?? "USD_JPY";
  const from = new Date(fromArg ?? "2021-01-01T00:00:00Z");
  const to = new Date(toArg ?? Date.now());

  const store = new LocalChunkStore(DATA_DIR);
  console.log(`${instrument} M1をロード中 (${from.toISOString().slice(0, 10)} 〜 ${to.toISOString().slice(0, 10)})...`);
  const m1 = await store.load(instrument, from, to);
  if (m1.length === 0) {
    throw new Error("データがありません。先に npm run data:download を実行してください");
  }
  console.log(`${m1.length}本のM1をロードしました`);

  // USD/JPYレート参照 (非JPYクォート用)
  const usdJpyM1 = instrument.endsWith("_JPY") ? null : await store.load("USD_JPY", from, to);

  for (const strategy of defaultStrategies()) {
    const candles = aggregateCandles(m1, strategy.timeframe);
    const results = new Map<number, ReturnType<typeof runBacktest>>();
    console.log(`\n=== ${strategy.name} (${strategy.id}) ${instrument} ===`);
    for (const markup of MARKUPS) {
      const config: BacktestConfig = {
        ...DEFAULT_CONFIG,
        spreadMarkupPips: markup,
        ...(usdJpyM1 ? { pipValueJpyAt: makeUsdJpyLookup(usdJpyM1, strategy.timeframe) } : {}),
      };
      const result = runBacktest(candles, strategy, instrument, config);
      results.set(markup, result);
      console.log(`  +${markup.toFixed(1)}pips: ${formatMetrics(computeMetrics(result))}`);
    }
    const path = await writeReport(buildReport(results));
    console.log(`  レポート: ${path}`);
  }
}

/** USD/JPYのM1終値からpip価値(JPY/unit/pip)のルックアップを作る */
function makeUsdJpyLookup(
  usdJpyM1: { time: number; bid: { c: number }; ask: { c: number } }[],
  timeframe: Timeframe,
): (ms: number) => number {
  const agg = aggregateCandles(usdJpyM1 as never, timeframe);
  const times = agg.map((c) => c.time);
  return (ms: number): number => {
    // 二分探索で直近の確定レートを引く
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (times[mid]! <= ms) lo = mid;
      else hi = mid - 1;
    }
    const c = agg[lo]!;
    const rate = (c.bid.c + c.ask.c) / 2;
    return 0.0001 * rate; // EUR_USD等 (pip=0.0001) × USDJPY
  };
}

await main();
