import { TF_MS, type Timeframe } from "../core/candle.ts";
import { isWeekendClosed } from "../core/sessions.ts";
import { monthKey } from "./store.ts";

/**
 * データ完全性チェック。
 *
 * 背景 (2026-08-21, docs/research.md): EUR/USDに11ヶ月の欠損があるまま研究
 * 第1〜4ラウンドが走っていた。Phase 1の「ギャップレポートを人間が読む」運用は
 * 破られることが実証されたため、WFAランナー自体が不完全データでの実行を拒否する。
 * 「不完全データでの検証結果が存在し得ない」ことを構造で保証する
 * (safety_stateのkey-value化と同じ思想)。
 *
 * 期待本数は週末クローズ (金17:00 NY〜日17:00 NY、IANAタイムゾーン計算) を
 * 除いたバースロット数。祝日・薄商い時間のflat足は正常な欠損として
 * 閾値マージンで吸収する (実測: 12月でも欠損率は1割未満)。
 */

export interface MonthCompleteness {
  /** "YYYY-MM" (UTC) */
  month: string;
  /** 週末を除いた期待バー数 (シリーズ範囲内にクリップ) */
  expected: number;
  actual: number;
  /** 1 - actual/expected (expected=0の月は0) */
  missingRate: number;
}

/**
 * 月ごとの欠損率を計算する。期待値はシリーズの [先頭バー, 末尾バー] に
 * クリップして数える (研究者が選んだ期間の内部の完全性を検査するのが目的で、
 * 期間の端をどこに置くかは検査対象ではない)。
 */
export function checkCompleteness(
  candles: readonly { time: number }[],
  timeframe: Timeframe,
): MonthCompleteness[] {
  if (candles.length === 0) return [];
  const tfMs = TF_MS[timeframe];
  const start = candles[0]!.time;
  const end = candles[candles.length - 1]!.time;

  // 実測本数を月ごとに集計
  const actualByMonth = new Map<string, number>();
  for (const c of candles) {
    const key = monthKey(c.time);
    actualByMonth.set(key, (actualByMonth.get(key) ?? 0) + 1);
  }

  // 期待本数: 週末クローズ外のバースロットを数える
  const expectedByMonth = new Map<string, number>();
  for (let t = Math.ceil(start / tfMs) * tfMs; t <= end; t += tfMs) {
    if (isWeekendClosed(t)) continue;
    const key = monthKey(t);
    expectedByMonth.set(key, (expectedByMonth.get(key) ?? 0) + 1);
  }

  const out: MonthCompleteness[] = [];
  for (const [month, expected] of expectedByMonth) {
    const actual = actualByMonth.get(month) ?? 0;
    out.push({
      month,
      expected,
      actual,
      missingRate: expected === 0 ? 0 : Math.max(0, 1 - actual / expected),
    });
  }
  out.sort((a, b) => (a.month < b.month ? -1 : 1));
  return out;
}

export class IncompleteDataError extends Error {
  readonly violations: MonthCompleteness[];

  constructor(message: string, violations: MonthCompleteness[]) {
    super(message);
    this.name = "IncompleteDataError";
    this.violations = violations;
  }
}

/**
 * 欠損率が閾値を超える月があれば IncompleteDataError を投げる。
 * デフォルト閾値 0.2 の根拠: 完全データ3ペア×68ヶ月の実測で正常月の最大欠損率は
 * 1割未満 (12月の年末休場を含む)。0.2は「取引週1週間分の欠落」(約23%) を検知しつつ
 * 祝日を誤検知しない位置。
 */
export function assertCompleteness(
  candles: readonly { time: number }[],
  timeframe: Timeframe,
  maxMissingRate = 0.2,
): void {
  const months = checkCompleteness(candles, timeframe);
  const violations = months.filter((m) => m.missingRate > maxMissingRate);
  if (violations.length > 0) {
    const detail = violations
      .slice(0, 12)
      .map((v) => `${v.month}: ${(v.missingRate * 100).toFixed(1)}%欠損 (${v.actual}/${v.expected}本)`)
      .join(", ");
    const more = violations.length > 12 ? ` 他${violations.length - 12}ヶ月` : "";
    throw new IncompleteDataError(
      `データ欠損率が閾値${maxMissingRate * 100}%を超える月があります — ` +
        `不完全データでの検証は禁止 (docs/research.md 2026-08-21): ${detail}${more}`,
      violations,
    );
  }
}
