import { aggregateCandles } from "../core/aggregate.ts";
import type { Timeframe } from "../core/candle.ts";
import { DEFAULT_CONFIG, type BacktestConfig } from "../backtest/engine.ts";
import { formatMetrics, type Metrics } from "../backtest/metrics.ts";
import { walkForward } from "../backtest/walkForward.ts";
import type { Strategy } from "../core/strategy.ts";
import { LocalChunkStore } from "../data/store.ts";
import { makeBbRsiReversion } from "../strategies/bbRsiReversion.ts";
import { makeDonchian } from "../strategies/donchian.ts";
import { makeSessionBreakout } from "../strategies/sessionBreakout.ts";

/**
 * R1〜R3の完全データ再検証 (2026-08-21、docs/research.md)。
 *
 * 【目的】第1〜4ラウンドはEUR/USDが57/68ヶ月 (+2024-12に部分欠損) の
 * 不完全データで走っていたことが判明した。棄却済み結論の維持/変化を
 * 完全データで一度だけ確認し、研究ログの整合性ループを閉じる。
 *
 * 【禁止事項】これは再検証であって新ラウンドではない。
 * - グリッド・パラメータ・採択基準は各ラウンドの事前登録と完全同一
 *   (R1: 7badd0c / R2: 6873759 / R3: 9776bfa から機械的に復元)
 * - 結果を見てグリッドを広げる・セットを追加することは禁止
 *   (それをやるなら第5ラウンドとして事前登録からやり直す)
 */

// ===== 採択基準 (第1回から不変。research.ts と同一) =====
const ACCEPTANCE = {
  minOosSharpe: 0.5,
  expectancyToSpreadRatio: 2,
  maxDrawdownPct: 25,
  markupsToSurvive: [0.2, 0.5],
};

const WFA = { trainDays: 365, testDays: 90 };
const INSTRUMENTS = ["USD_JPY", "EUR_USD"];
const DATA_DIR = new URL("../../data/candles", import.meta.url).pathname;

interface CandidateSet {
  name: string;
  timeframe: Timeframe;
  candidates: Strategy[];
  configOverrides?: Partial<BacktestConfig>;
}

const DONCHIAN_PERIODS: [number, number][] = [
  [20, 10],
  [40, 20],
  [80, 40],
];

function donchianSet(
  name: string,
  timeframe: Timeframe,
  extra: Partial<Parameters<typeof makeDonchian>[0]> = {},
): CandidateSet {
  return {
    name,
    timeframe,
    candidates: DONCHIAN_PERIODS.map(([e, x]) =>
      makeDonchian({
        timeframe,
        entryPeriod: e,
        exitPeriod: x,
        atrPeriod: 14,
        slAtrMult: 2,
        ...extra,
      }),
    ),
  };
}

const BB_RSI_GRID: [number, number, number][] = [
  [2, 30, 70],
  [2.5, 25, 75],
];

function bbRsiCandidates(): Strategy[] {
  return BB_RSI_GRID.map(([sigma, lo, hi]) =>
    makeBbRsiReversion({
      timeframe: "M15",
      bbPeriod: 20,
      bbSigma: sigma,
      rsiPeriod: 14,
      rsiLower: lo,
      rsiUpper: hi,
      atrPeriod: 14,
      slAtrMult: 1.5,
    }),
  );
}

/** 全ラウンドのセット (事前登録時の定義を復元。変更禁止) */
function candidateSets(): CandidateSet[] {
  return [
    // ===== R1 (7badd0c) =====
    donchianSet("R1_donchian_M15", "M15"),
    {
      name: "R1_sessionBreakout_M15",
      timeframe: "M15",
      candidates: [1.0, 1.5, 2.0].map((tpR) =>
        makeSessionBreakout({ timeframe: "M15", minRangePips: 20, maxRangePips: 80, maxSlPips: 40, tpR }),
      ),
    },
    { name: "R1_bbRsi_M15", timeframe: "M15", candidates: bbRsiCandidates() },
    // ===== R2 (6873759) =====
    donchianSet("R2-A_donchian_H1", "H1"),
    donchianSet("R2-B_donchian_H1_ema200", "H1", { trendEmaPeriod: 200 }),
    donchianSet("R2-B_donchian_M15_ema200", "M15", { trendEmaPeriod: 200 }),
    donchianSet("R2-C_donchian_H1_adx", "H1", { adxPeriod: 14, adxMin: 20 }),
    donchianSet("R2-C_donchian_M15_adx", "M15", { adxPeriod: 14, adxMin: 20 }),
    {
      name: "R2-D_bbRsi_M15_tokyo",
      timeframe: "M15",
      configOverrides: { sessionFilter: ["tokyo"] },
      candidates: bbRsiCandidates(),
    },
    // ===== R3 (9776bfa) =====
    {
      name: "R3-A_sessbrk_v2_M15",
      timeframe: "M15",
      candidates: [1.5, 2.5].map((tpR) =>
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
      ),
    },
    donchianSet("R3-B_donchian_H4", "H4"),
  ];
}

function judge(oos: Metrics, markupResults: Map<number, Metrics>): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (oos.sharpe < ACCEPTANCE.minOosSharpe) {
    reasons.push(`OOSシャープ ${oos.sharpe.toFixed(2)} < ${ACCEPTANCE.minOosSharpe}`);
  }
  if (oos.expectancyPips < oos.avgSpreadPips * ACCEPTANCE.expectancyToSpreadRatio) {
    reasons.push(
      `期待値 ${oos.expectancyPips.toFixed(2)}p < スプレッド${oos.avgSpreadPips.toFixed(2)}p × ${ACCEPTANCE.expectancyToSpreadRatio}`,
    );
  }
  if (oos.maxDrawdownPct > ACCEPTANCE.maxDrawdownPct) {
    reasons.push(`最大DD ${oos.maxDrawdownPct.toFixed(1)}% > ${ACCEPTANCE.maxDrawdownPct}%`);
  }
  for (const markup of ACCEPTANCE.markupsToSurvive) {
    const m = markupResults.get(markup);
    if (m && m.expectancyPips <= 0) {
      reasons.push(`+${markup}pips上乗せで期待値が消滅 (${m.expectancyPips.toFixed(2)}p)`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

async function main(): Promise<void> {
  const store = new LocalChunkStore(DATA_DIR);
  const from = new Date("2021-01-01T00:00:00Z");
  const to = new Date();

  const verdicts: { set: string; instrument: string; pass: boolean; reasons: string[] }[] = [];

  for (const instrument of INSTRUMENTS) {
    console.log(`\n############ ${instrument} ############`);
    const m1 = await store.load(instrument, from, to);
    if (m1.length === 0) {
      console.log("データなし (npm run data:download を先に実行)");
      continue;
    }
    const usdJpyM1 = instrument.endsWith("_JPY") ? null : await store.load("USD_JPY", from, to);

    for (const set of candidateSets()) {
      const candles = aggregateCandles(m1, set.timeframe);
      console.log(`\n=== ${set.name} (${set.candidates.length}候補, WFA ${WFA.trainDays}/${WFA.testDays}日) ===`);
      const markupMetrics = new Map<number, Metrics>();
      let oos: Metrics | null = null;
      for (const markup of [0, ...ACCEPTANCE.markupsToSurvive]) {
        const config: BacktestConfig = {
          ...DEFAULT_CONFIG,
          ...(set.configOverrides ?? {}),
          spreadMarkupPips: markup,
          ...(usdJpyM1 ? { pipValueJpyAt: makeUsdJpyLookup(usdJpyM1) } : {}),
        };
        try {
          const wfa = walkForward(candles, set.candidates, instrument, { ...WFA, config });
          markupMetrics.set(markup, wfa.aggregate);
          if (markup === 0) {
            oos = wfa.aggregate;
            console.log(`  OOS +0.0: ${formatMetrics(wfa.aggregate)}`);
          } else {
            console.log(`  OOS +${markup}: SR ${wfa.aggregate.sharpe.toFixed(2)} 期待値 ${wfa.aggregate.expectancyPips.toFixed(2)}p`);
          }
        } catch (err) {
          console.log(`  +${markup}: 失敗 (${err instanceof Error ? err.message : err})`);
        }
      }
      if (oos) {
        const verdict = judge(oos, markupMetrics);
        verdicts.push({ set: set.name, instrument, ...verdict });
        console.log(
          verdict.pass ? "  → ✅ 採択基準クリア" : `  → ❌ 不採択: ${verdict.reasons.join(" / ")}`,
        );
      }
    }
  }

  console.log("\n############ 総合 (再検証: 両ペア通過のみ採択候補) ############");
  const bySets = new Map<string, typeof verdicts>();
  for (const v of verdicts) {
    const list = bySets.get(v.set) ?? [];
    list.push(v);
    bySets.set(v.set, list);
  }
  for (const [set, list] of bySets) {
    const pass = list.length >= 2 && list.every((v) => v.pass);
    console.log(`${pass ? "✅" : "❌"} ${set}: ${list.map((v) => `${v.instrument}=${v.pass ? "○" : "×"}`).join(" ")}`);
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
