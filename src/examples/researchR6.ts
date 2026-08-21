import { aggregateCandles } from "../core/aggregate.ts";
import { DEFAULT_CONFIG, type BacktestConfig } from "../backtest/engine.ts";
import { formatMetrics, type Metrics } from "../backtest/metrics.ts";
import { walkForward } from "../backtest/walkForward.ts";
import type { Strategy } from "../core/strategy.ts";
import type { BidAskCandle } from "../core/candle.ts";
import { LocalChunkStore } from "../data/store.ts";
import { makeSessionBreakout } from "../strategies/sessionBreakout.ts";

/**
 * 研究第6ラウンド実行ランナー (事前登録: docs/research.md 2026-08-21、
 * コミット b85bab6。実装はこの事前登録の後)。
 * セッション構造の再設計: R6-A 欧州オープニングレンジ / R6-B 出口で利益を伸ばす。
 *
 * 【事前固定の判定 — 変更禁止】
 * - 主評価: WFA 365/90、ACCEPTANCE (2026-08-19版) 不変
 * - メカニズムペア群 = EUR/USD + GBP/USD の両方で合格が必要。USD/JPYは対照のみ
 * - EUR/USD合格 = ACCEPTANCE全項目
 * - GBP/USD合格 = SR≥0.5・期待値>0・+0.5生存・
 *   (期待値≥GBPスプレッド×2 または EUR/USD同セット期待値の50%以上)
 * - 両ペア合格セットのみ窓ロバストネス {180/60, 540/135} に進み、
 *   3窓すべてで上記を満たして採択候補
 * - 結果を見た後のグリッド拡張・セット追加は禁止
 */

const ACCEPTANCE = {
  minOosSharpe: 0.5,
  expectancyToSpreadRatio: 2,
  maxDrawdownPct: 25,
  markupsToSurvive: [0.2, 0.5],
};

const PRIMARY_WFA = { trainDays: 365, testDays: 90 };
const ROBUSTNESS_WFA = [
  { trainDays: 180, testDays: 60 },
  { trainDays: 540, testDays: 135 },
];
const DATA_DIR = new URL("../../data/candles", import.meta.url).pathname;

/** R3-A凍結値をベースにしたR6候補セット (グリッドは事前登録どおり) */
const BASE = {
  timeframe: "M15" as const,
  minRangePips: 20,
  maxRangePips: 80,
  maxSlPips: 40,
  atrBufferMult: 0.3,
  entryEndLondonMin: 12 * 60,
  exitNyMin: 12 * 60,
};

interface CandidateSet {
  name: string;
  candidates: Strategy[];
}

function candidateSets(): CandidateSet[] {
  return [
    {
      // レンジ箱をロンドン現地5:00-8:00へ。3時間箱に合わせ minRange 10 / maxRange 60 (固定)
      name: "R6-A_sessbrk_euOpenRange",
      candidates: [1.5, 2.5].map((tpR) =>
        makeSessionBreakout({
          ...BASE,
          tpR,
          minRangePips: 10,
          maxRangePips: 60,
          rangeStartLondonMin: 5 * 60,
          rangeEndLondonMin: 8 * 60,
        }),
      ),
    },
    {
      // 出口で利益を伸ばす: tp {2.5, なし} × exitNy {12:00, 16:00}
      name: "R6-B_sessbrk_letWinnersRun",
      candidates: [720, 960].flatMap((exitNyMin) => [
        makeSessionBreakout({ ...BASE, tpR: 2.5, exitNyMin }),
        makeSessionBreakout({ ...BASE, exitNyMin }), // tpRなし = TPなし
      ]),
    },
  ];
}

interface PairResult {
  oos: Metrics;
  markups: Map<number, Metrics>;
}

/** EUR/USD: ACCEPTANCE全項目 */
function judgeEur(r: PairResult): string[] {
  const reasons: string[] = [];
  const oos = r.oos;
  if (oos.sharpe < ACCEPTANCE.minOosSharpe) reasons.push(`SR ${oos.sharpe.toFixed(2)} < 0.5`);
  if (oos.expectancyPips < oos.avgSpreadPips * ACCEPTANCE.expectancyToSpreadRatio) {
    reasons.push(`期待値 ${oos.expectancyPips.toFixed(2)}p < スプレッド×2 (${(oos.avgSpreadPips * 2).toFixed(2)}p)`);
  }
  if (oos.maxDrawdownPct > ACCEPTANCE.maxDrawdownPct) reasons.push(`DD ${oos.maxDrawdownPct.toFixed(1)}% > 25%`);
  for (const m of ACCEPTANCE.markupsToSurvive) {
    const mm = r.markups.get(m);
    if (mm && mm.expectancyPips <= 0) reasons.push(`+${m}で期待値消滅 (${mm.expectancyPips.toFixed(2)}p)`);
  }
  return reasons;
}

/** GBP/USD: R4二値化条件と同形 (eurExpectancyPips = EUR/USD同セット・同窓の+0.0期待値) */
function judgeGbp(r: PairResult, eurExpectancyPips: number): string[] {
  const reasons: string[] = [];
  const oos = r.oos;
  if (oos.sharpe < ACCEPTANCE.minOosSharpe) reasons.push(`SR ${oos.sharpe.toFixed(2)} < 0.5`);
  if (oos.expectancyPips <= 0) reasons.push(`期待値 ${oos.expectancyPips.toFixed(2)}p ≤ 0`);
  const p05 = r.markups.get(0.5);
  if (p05 && p05.expectancyPips <= 0) reasons.push(`+0.5で期待値消滅 (${p05.expectancyPips.toFixed(2)}p)`);
  const costOk = oos.expectancyPips >= oos.avgSpreadPips * ACCEPTANCE.expectancyToSpreadRatio;
  const eurHalfOk = oos.expectancyPips >= eurExpectancyPips * 0.5;
  if (!costOk && !eurHalfOk) {
    reasons.push(
      `期待値 ${oos.expectancyPips.toFixed(2)}p がスプレッド×2 (${(oos.avgSpreadPips * 2).toFixed(2)}p) にも` +
        `EUR同セット50% (${(eurExpectancyPips * 0.5).toFixed(2)}p) にも未達`,
    );
  }
  return reasons;
}

async function runPair(
  candlesM15: BidAskCandle[],
  set: CandidateSet,
  instrument: string,
  wfaOpts: { trainDays: number; testDays: number },
  pipValueJpyAt: ((ms: number) => number) | undefined,
  label: string,
): Promise<PairResult | null> {
  const markups = new Map<number, Metrics>();
  let oos: Metrics | null = null;
  for (const markup of [0, ...ACCEPTANCE.markupsToSurvive]) {
    const config: BacktestConfig = {
      ...DEFAULT_CONFIG,
      spreadMarkupPips: markup,
      ...(pipValueJpyAt ? { pipValueJpyAt } : {}),
    };
    try {
      const wfa = walkForward(candlesM15, set.candidates, instrument, { ...wfaOpts, config });
      markups.set(markup, wfa.aggregate);
      if (markup === 0) {
        oos = wfa.aggregate;
        console.log(`  ${label} +0.0: ${formatMetrics(wfa.aggregate)}`);
      } else {
        console.log(`  ${label} +${markup}: SR ${wfa.aggregate.sharpe.toFixed(2)} 期待値 ${wfa.aggregate.expectancyPips.toFixed(2)}p`);
      }
    } catch (err) {
      console.log(`  ${label} +${markup}: 失敗 (${err instanceof Error ? err.message : err})`);
      return null;
    }
  }
  return oos ? { oos, markups } : null;
}

async function main(): Promise<void> {
  const store = new LocalChunkStore(DATA_DIR);
  const from = new Date("2021-01-01T00:00:00Z");
  const to = new Date();

  const usdJpyM1 = await store.load("USD_JPY", from, to);
  const lookup = makeUsdJpyLookup(usdJpyM1);
  const m15 = new Map<string, BidAskCandle[]>();
  m15.set("USD_JPY", aggregateCandles(usdJpyM1, "M15"));
  for (const inst of ["EUR_USD", "GBP_USD"]) {
    m15.set(inst, aggregateCandles(await store.load(inst, from, to), "M15"));
  }

  for (const set of candidateSets()) {
    console.log(`\n############ ${set.name} (${set.candidates.length}候補) ############`);
    console.log(`--- 主評価 WFA ${PRIMARY_WFA.trainDays}/${PRIMARY_WFA.testDays}日 ---`);

    const eur = await runPair(m15.get("EUR_USD")!, set, "EUR_USD", PRIMARY_WFA, lookup, "EUR_USD");
    const gbp = await runPair(m15.get("GBP_USD")!, set, "GBP_USD", PRIMARY_WFA, lookup, "GBP_USD");
    // 対照 (合否に使わない)
    const jpy = await runPair(m15.get("USD_JPY")!, set, "USD_JPY", PRIMARY_WFA, undefined, "USD_JPY(対照)");
    void jpy;

    if (!eur || !gbp) {
      console.log("  → ❌ 不採択 (WFA実行不能)");
      continue;
    }
    const eurReasons = judgeEur(eur);
    const gbpReasons = judgeGbp(gbp, eur.oos.expectancyPips);
    console.log(`  EUR/USD: ${eurReasons.length === 0 ? "✅" : `❌ ${eurReasons.join(" / ")}`}`);
    console.log(`  GBP/USD: ${gbpReasons.length === 0 ? "✅" : `❌ ${gbpReasons.join(" / ")}`}`);
    if (eurReasons.length > 0 || gbpReasons.length > 0) {
      console.log("  → ❌ 不採択 (主評価でメカニズムペア群を通過せず)");
      continue;
    }

    console.log("--- 窓ロバストネス (事前固定: 3窓すべてで合格が必要) ---");
    let robustOk = true;
    for (const w of ROBUSTNESS_WFA) {
      console.log(`  窓 ${w.trainDays}/${w.testDays}日:`);
      const eurW = await runPair(m15.get("EUR_USD")!, set, "EUR_USD", w, lookup, "EUR_USD");
      const gbpW = await runPair(m15.get("GBP_USD")!, set, "GBP_USD", w, lookup, "GBP_USD");
      if (!eurW || !gbpW) {
        robustOk = false;
        break;
      }
      const er = judgeEur(eurW);
      const gr = judgeGbp(gbpW, eurW.oos.expectancyPips);
      console.log(`    EUR: ${er.length === 0 ? "✅" : `❌ ${er.join(" / ")}`}`);
      console.log(`    GBP: ${gr.length === 0 ? "✅" : `❌ ${gr.join(" / ")}`}`);
      if (er.length > 0 || gr.length > 0) robustOk = false;
    }
    console.log(robustOk ? "  → ✅ 採択候補 (3窓×両ペア通過)" : "  → ❌ 不採択 (窓ロバストネスで脱落)");
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
