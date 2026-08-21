import { aggregateCandles } from "../core/aggregate.ts";
import type { Timeframe } from "../core/candle.ts";
import { DEFAULT_CONFIG, type BacktestConfig } from "../backtest/engine.ts";
import { formatMetrics, type Metrics } from "../backtest/metrics.ts";
import { walkForward } from "../backtest/walkForward.ts";
import type { Strategy } from "../core/strategy.ts";
import { LocalChunkStore } from "../data/store.ts";
import { makeDonchian } from "../strategies/donchian.ts";
import { makeSessionBreakout } from "../strategies/sessionBreakout.ts";

/**
 * 戦略研究ランナー: WFA (ウォークフォワード分析) を両ペアで実行する。
 *   npm run research
 *
 * 【研究の規律 — docs/research.md より。実行前に読むこと】
 * 1. 採択基準は実行前に固定する (下のACCEPTANCE)。結果を見てから動かさない
 * 2. USD/JPY と EUR/USD の両方で通らない戦略はデータマイニングとして棄却
 * 3. +0.2/+0.5pipsのスプレッド上乗せでも生き残ること
 * 4. 全戦略不採択 → liveを見送る (正式なno-go分岐)。締切を理由に緩めない
 */

// ===== 採択基準 (事前固定。変更する場合はdocs/research.mdに理由を記録) =====
const ACCEPTANCE = {
  /** OOS連結シャープレシオの下限 */
  minOosSharpe: 0.5,
  /** コスト控除後期待値 ≥ 平均スプレッドコスト × この倍率 */
  expectancyToSpreadRatio: 2,
  /** 最大DDの上限 (%) */
  maxDrawdownPct: 25,
  /** スプレッド上乗せ後もOOS期待値が正であること */
  markupsToSurvive: [0.2, 0.5],
};

const WFA = { trainDays: 365, testDays: 90 };
const INSTRUMENTS = ["USD_JPY", "EUR_USD"];
const DATA_DIR = new URL("../../data/candles", import.meta.url).pathname;

interface CandidateSet {
  name: string;
  timeframe: Timeframe;
  candidates: Strategy[];
  /** セット固有のエンジン設定 (セッション限定等)。markupとは合成される */
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

/**
 * WFAの候補セット (学習期間でこの中からシャープ最良が選ばれる)。
 * 第3ラウンド (2026-08-20 事前登録、docs/research.md):
 * R3-A: sessionBreakout v2 — ATRバッファ0.3 / ロンドン初動(8:00-12:00現地)限定 /
 *        NY12:00現地で強制フラット。tpR {1.5, 2.5} のみ候補
 * R3-B: Donchian H4 (フィルタなし) — コスト比の決定的改善を検証
 * 過去ラウンドのセットは docs/research.md の検証ログを参照。
 */
function candidateSets(): CandidateSet[] {
  return [
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
          ...(usdJpyM1
            ? { pipValueJpyAt: makeUsdJpyLookup(usdJpyM1) }
            : {}),
        };
        try {
          const wfa = walkForward(candles, set.candidates, instrument, { ...WFA, config });
          markupMetrics.set(markup, wfa.aggregate);
          if (markup === 0) {
            oos = wfa.aggregate;
            console.log(`  OOS +0.0: ${formatMetrics(wfa.aggregate)}`);
            for (const w of wfa.windows) {
              console.log(
                `    ${iso(w.testFrom)}〜: ${w.bestId} 学習SR=${w.trainMetrics.sharpe.toFixed(2)} 検証SR=${w.testMetrics.sharpe.toFixed(2)}`,
              );
            }
          } else {
            console.log(`  OOS +${markup}: ${formatMetrics(wfa.aggregate)}`);
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

  // 総合判定: 両ペアで通った戦略のみ採択候補
  console.log("\n############ 総合判定 (両ペア通過のみ採択候補) ############");
  const bySets = new Map<string, typeof verdicts>();
  for (const v of verdicts) {
    const list = bySets.get(v.set) ?? [];
    list.push(v);
    bySets.set(v.set, list);
  }
  let anyPass = false;
  for (const [set, list] of bySets) {
    const pass = list.length >= 2 && list.every((v) => v.pass);
    if (pass) anyPass = true;
    console.log(`${pass ? "✅" : "❌"} ${set}: ${list.map((v) => `${v.instrument}=${v.pass ? "○" : "×"}`).join(" ")}`);
  }
  if (!anyPass) {
    console.log(
      "\n⚠️ 全戦略不採択。これは正式なno-go分岐です — 締切を理由に基準を緩めず、" +
        "パラメータ空間・時間軸・フィルタの仮説を立て直すこと (docs/research.mdに記録)。",
    );
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

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

await main();
