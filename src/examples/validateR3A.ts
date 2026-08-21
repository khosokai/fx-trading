import { aggregateCandles } from "../core/aggregate.ts";
import { DEFAULT_CONFIG, type BacktestConfig } from "../backtest/engine.ts";
import { formatMetrics, type Metrics } from "../backtest/metrics.ts";
import { walkForward } from "../backtest/walkForward.ts";
import { LocalChunkStore } from "../data/store.ts";
import { makeSessionBreakout } from "../strategies/sessionBreakout.ts";

/**
 * 第4ラウンド (2026-08-20 事前登録): R3-A設定の追加検証。
 * 【重要】これは検証であって最適化ではない。R3-Aのパラメータは完全固定であり、
 * この結果を見てパラメータを変更してはならない (変更したら新ラウンドとして
 * 事前登録からやり直し)。
 *
 * V1: GBP_USD (完全な追加OOS)
 * V2: WFA窓ロバストネス {180/60, 365/90, 540/135}日 × 3ペア
 */

const DATA_DIR = new URL("../../data/candles", import.meta.url).pathname;
const INSTRUMENTS = ["USD_JPY", "EUR_USD", "GBP_USD"];
const WINDOWS: { trainDays: number; testDays: number }[] = [
  { trainDays: 180, testDays: 60 },
  { trainDays: 365, testDays: 90 },
  { trainDays: 540, testDays: 135 },
];
const MARKUPS = [0, 0.2, 0.5];

/** R3-A設定 (固定。docs/research.md 第3ラウンド事前登録と同一) */
function r3aCandidates() {
  return [1.5, 2.5].map((tpR) =>
    makeSessionBreakout({
      timeframe: "M15",
      minRangePips: 20,
      maxRangePips: 80,
      maxSlPips: 40,
      tpR,
      atrBufferMult: 0.3,
      entryEndLondonMin: 12 * 60,
      exitNyMin: 12 * 60,
    }),
  );
}

/** 採択基準 (第1回から不変) の個別判定を短い文字列に */
function verdict(m: Metrics, markupResults: Map<number, Metrics>): string {
  const checks = [
    m.sharpe >= 0.5 ? "SR✓" : `SR✗(${m.sharpe.toFixed(2)})`,
    m.expectancyPips >= m.avgSpreadPips * 2
      ? "期待値✓"
      : `期待値✗(${m.expectancyPips.toFixed(2)}p/${(m.avgSpreadPips * 2).toFixed(2)}p)`,
    m.maxDrawdownPct <= 25 ? "DD✓" : `DD✗(${m.maxDrawdownPct.toFixed(1)}%)`,
  ];
  for (const markup of [0.2, 0.5]) {
    const mm = markupResults.get(markup);
    if (mm) checks.push(mm.expectancyPips > 0 ? `+${markup}✓` : `+${markup}✗`);
  }
  return checks.join(" ");
}

async function main(): Promise<void> {
  const store = new LocalChunkStore(DATA_DIR);
  const from = new Date("2021-01-01T00:00:00Z");
  const to = new Date();
  const usdJpyM1 = await store.load("USD_JPY", from, to);

  for (const instrument of INSTRUMENTS) {
    const m1 = await store.load(instrument, from, to);
    if (m1.length === 0) {
      console.log(`${instrument}: データなし (npm run data:download を先に)`);
      continue;
    }
    const candles = aggregateCandles(m1, "M15");
    console.log(`\n############ ${instrument} (M1 ${m1.length}本) ############`);

    for (const window of WINDOWS) {
      const markupResults = new Map<number, Metrics>();
      for (const markup of MARKUPS) {
        const config: BacktestConfig = {
          ...DEFAULT_CONFIG,
          spreadMarkupPips: markup,
          ...(instrument.endsWith("_JPY") ? {} : { pipValueJpyAt: makeUsdJpyLookup(usdJpyM1) }),
        };
        try {
          const wfa = walkForward(candles, r3aCandidates(), instrument, { ...window, config });
          markupResults.set(markup, wfa.aggregate);
        } catch (err) {
          console.log(`  ${window.trainDays}/${window.testDays} +${markup}: 失敗 (${err instanceof Error ? err.message : err})`);
        }
      }
      const base = markupResults.get(0);
      if (base) {
        console.log(`  窓 ${window.trainDays}/${window.testDays}日:`);
        console.log(`    +0.0: ${formatMetrics(base)}`);
        for (const markup of [0.2, 0.5]) {
          const m = markupResults.get(markup);
          if (m) console.log(`    +${markup}: SR ${m.sharpe.toFixed(2)} 期待値 ${m.expectancyPips.toFixed(2)}p`);
        }
        console.log(`    判定: ${verdict(base, markupResults)}`);
      }
    }
  }
}

function makeUsdJpyLookup(usdJpyM1: { time: number; bid: { c: number }; ask: { c: number } }[]) {
  const times = usdJpyM1.map((c) => c.time);
  return (ms: number): number => {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (times[mid]! <= ms) lo = mid;
      else hi = mid - 1;
    }
    const c = usdJpyM1[lo]!;
    return 0.0001 * ((c.bid.c + c.ask.c) / 2);
  };
}

await main();
