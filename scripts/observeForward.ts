import { mkdir, readFile, writeFile } from "node:fs/promises";
import { aggregateCandles } from "../src/core/aggregate.ts";
import { DEFAULT_CONFIG, type BacktestConfig } from "../src/backtest/engine.ts";
import {
  evaluateObservation,
  toLogEntry,
  verifyAppendOnly,
  type PromotionCriteria,
  type TradeLogEntry,
} from "../src/backtest/observation.ts";
import { walkForward } from "../src/backtest/walkForward.ts";
import type { Strategy } from "../src/core/strategy.ts";
import { LocalChunkStore } from "../src/data/store.ts";
import { makeSessionBreakout } from "../src/strategies/sessionBreakout.ts";

/**
 * 観察フェーズの週次ランナー (docs/research.md 2026-08-21「観察名簿」)。
 *   npm run observe   (= 当月データ更新 → 本スクリプト)
 *
 * やること:
 * 1. 名簿の各候補についてWFA (365/90) を全期間再計算し、
 *    観察開始 (2026-08-22 00:00Z) 以降にエントリーしたOOSトレードを抽出
 * 2. 保存済み判定ログとの再現性検証 (append-only。不一致 = データ改訂の混入
 *    としてエラー停止し人間に報告)
 * 3. 事前固定の昇格/失格条件と突合してレポート
 *
 * 【名簿は閉じたリスト。候補の追加・条件の変更はresearch.mdの改定なしに行わない】
 * 【実行後、更新された reports/observation/*.json をコミットすること —
 *   git履歴が判定ログの監査証跡であり、データ改訂検出の基準でもある】
 */

const OBS_START_MS = Date.parse("2026-08-22T00:00:00Z");
const LOG_DIR = new URL("../reports/observation", import.meta.url).pathname;
const DATA_DIR = new URL("../data/candles", import.meta.url).pathname;

const R3A_BASE = {
  timeframe: "M15" as const,
  minRangePips: 20,
  maxRangePips: 80,
  maxSlPips: 40,
  atrBufferMult: 0.3,
  entryEndLondonMin: 12 * 60,
};

interface RosterEntry {
  key: string;
  label: string;
  instrument: string;
  candidates: Strategy[];
  criteria: PromotionCriteria;
}

/** 観察名簿 (research.md 2026-08-21の凍結値) */
const ROSTER: RosterEntry[] = [
  {
    key: "r3a_eurusd",
    label: "主候補: R3-A × EUR/USD",
    instrument: "EUR_USD",
    candidates: [1.5, 2.5].map((tpR) =>
      makeSessionBreakout({ ...R3A_BASE, tpR, exitNyMin: 12 * 60 }),
    ),
    criteria: {
      minMonths: 4,
      minTrades: 30,
      minCumulativeExpectancyPips: 0.82,
      rolling30KillPips: -10.98,
    },
  },
  {
    key: "r6b_usdjpy",
    label: "副候補: R6-B × USD/JPY (in-sample由来のため厳格化)",
    instrument: "USD_JPY",
    candidates: [720, 960].flatMap((exitNyMin) => [
      makeSessionBreakout({ ...R3A_BASE, tpR: 2.5, exitNyMin }),
      makeSessionBreakout({ ...R3A_BASE, exitNyMin }),
    ]),
    criteria: {
      minMonths: 6,
      minTrades: 45,
      minCumulativeExpectancyPips: 1.44,
      rolling30KillPips: -9.83,
    },
  },
];

async function loadLog(key: string): Promise<TradeLogEntry[]> {
  const path = `${LOG_DIR}/${key}.json`;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // 初回のみ正常
    throw err;
  }
  try {
    return JSON.parse(raw) as TradeLogEntry[];
  } catch (err) {
    // 破損を「ログなし」扱いにすると次回書き込みで再現性検証の基準が静かに
    // リセットされる。必ず停止して人間が確認する (git履歴から復元可能)
    throw new Error(`判定ログが破損しています: ${path} — 上書きせず停止。git履歴から復元すること (${err})`);
  }
}

async function main(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  const store = new LocalChunkStore(DATA_DIR);
  const from = new Date("2021-01-01T00:00:00Z");
  const to = new Date();
  const nowMs = Date.now();

  const usdJpyM1 = await store.load("USD_JPY", from, to);
  const lookup = makeUsdJpyLookup(usdJpyM1);

  let anyError = false;
  console.log(`観察レポート ${new Date().toISOString()} (観察開始: 2026-08-22)`);

  for (const entry of ROSTER) {
    console.log(`\n===== ${entry.label} =====`);
    const m1 =
      entry.instrument === "USD_JPY" ? usdJpyM1 : await store.load(entry.instrument, from, to);
    const dataEndMs = m1[m1.length - 1]!.time;
    const config: BacktestConfig = {
      ...DEFAULT_CONFIG,
      ...(entry.instrument.endsWith("_JPY") ? {} : { pipValueJpyAt: lookup }),
    };
    // 完全性ゲートはwalkForward内で自動適用される
    const wfa = walkForward(aggregateCandles(m1, "M15"), entry.candidates, entry.instrument, {
      trainDays: 365,
      testDays: 90,
      config,
    });
    // 観察開始以降のOOSトレード。データ末尾で強制クローズされた建玉 (closeReason
    // "end") は次回実行で決済が変わるため確定扱いにしない
    const forward = wfa.windows
      .flatMap((w) => w.testResult.trades)
      .sort((a, b) => a.entryTime - b.entryTime)
      .filter((t) => t.entryTime >= OBS_START_MS && t.closeReason !== "end")
      .map(toLogEntry);

    const stored = await loadLog(entry.key);
    const check = verifyAppendOnly(stored, forward);
    if (!check.ok) {
      console.error(`  ❌ 再現性検証エラー: ${check.error}`);
      console.error("  観察の前提が壊れています。原因を特定するまで判定を停止してください。");
      anyError = true;
      continue;
    }
    if (check.appended.length > 0) {
      await writeFile(`${LOG_DIR}/${entry.key}.json`, JSON.stringify(forward, null, 1));
    }

    const status = evaluateObservation(
      forward.map((t) => t.plPips),
      OBS_START_MS,
      nowMs,
      entry.criteria,
    );
    // WFAの最終窓は検証期間が半分経過するまで出現しないため、OOSカバー末尾は
    // データ末尾より最大45日遅れる。「トレードなし」と「未カバー」の区別用に両方出す
    const uncoveredDays = Math.max(0, Math.round((dataEndMs - wfa.oosTo) / 86_400_000));
    console.log(
      `  データ末尾: ${new Date(dataEndMs).toISOString()}  OOSカバー末尾: ${new Date(wfa.oosTo).toISOString()}` +
        (uncoveredDays > 0 ? ` (未カバー ${uncoveredDays}日)` : ""),
    );
    console.log(`  新規確定: ${check.appended.length}件  累計: ${status.trades}件`);
    console.log(
      `  累積期待値: ${status.cumulativeExpectancyPips?.toFixed(2) ?? "—"}p/件  ` +
        `30件ローリング: 最新 ${status.latestRolling30?.toFixed(2) ?? "—"}p / 最悪 ${status.worstRolling30?.toFixed(2) ?? "—"}p ` +
        `(失格線 ${entry.criteria.rolling30KillPips}p)`,
    );
    if (status.killed) {
      console.log("  → ❌ 失格条件に抵触。観察打ち切り (research.mdに記録すること)");
    } else if (status.promotable) {
      console.log("  → ✅ 昇格条件をすべて充足。採択議論を再開できる (research.mdに記録すること)");
    } else {
      console.log(`  → 観察継続: ${status.pending.join(" / ")}`);
    }
  }

  if (anyError) process.exitCode = 1;
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
