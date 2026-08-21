import type { TradeRecord } from "./engine.ts";

/**
 * 観察フェーズ (Phase 3クローズ後) の判定ロジック。
 * docs/research.md 2026-08-21「観察名簿」の昇格/失格条件を機械判定する。
 * 条件の数値はここではなく呼び出し側 (scripts/observeForward.ts) が
 * research.mdの凍結値を渡す — このモジュールは純粋関数のみ。
 */

export interface PromotionCriteria {
  /** 観察開始からの最低経過月数 (30.44日/月換算) */
  minMonths: number;
  /** 最低成立トレード数 */
  minTrades: number;
  /** 累積期待値の下限 (pips/トレード) */
  minCumulativeExpectancyPips: number;
  /** 30件ローリング期待値がこの値を下回ったら即時失格 (pips) */
  rolling30KillPips: number;
}

export interface ObservationStatus {
  trades: number;
  elapsedMonths: number;
  cumulativeExpectancyPips: number | null;
  /** 30件ローリング期待値の最小値 (30件未満ならnull) */
  worstRolling30: number | null;
  latestRolling30: number | null;
  /** 失格条件に抵触したか */
  killed: boolean;
  /** 昇格条件をすべて満たしたか (killed時は常にfalse) */
  promotable: boolean;
  /** 満たしていない条件の説明 (観察継続の理由) */
  pending: string[];
}

const MONTH_MS = 30.44 * 86_400_000;

export function evaluateObservation(
  tradePips: readonly number[],
  obsStartMs: number,
  nowMs: number,
  c: PromotionCriteria,
): ObservationStatus {
  const n = tradePips.length;
  const elapsedMonths = Math.max(0, (nowMs - obsStartMs) / MONTH_MS);
  const cumulative = n > 0 ? tradePips.reduce((s, x) => s + x, 0) / n : null;

  let worstRolling30: number | null = null;
  let latestRolling30: number | null = null;
  for (let i = 29; i < n; i++) {
    let sum = 0;
    for (let j = i - 29; j <= i; j++) sum += tradePips[j]!;
    const avg = sum / 30;
    if (worstRolling30 === null || avg < worstRolling30) worstRolling30 = avg;
    latestRolling30 = avg;
  }

  const killed = worstRolling30 !== null && worstRolling30 < c.rolling30KillPips;

  const pending: string[] = [];
  if (elapsedMonths < c.minMonths) {
    pending.push(`経過 ${elapsedMonths.toFixed(1)}ヶ月 < ${c.minMonths}ヶ月`);
  }
  if (n < c.minTrades) pending.push(`トレード ${n}件 < ${c.minTrades}件`);
  if (cumulative === null || cumulative < c.minCumulativeExpectancyPips) {
    pending.push(
      `累積期待値 ${cumulative === null ? "—" : cumulative.toFixed(2) + "p"} < +${c.minCumulativeExpectancyPips}p/件`,
    );
  }

  return {
    trades: n,
    elapsedMonths,
    cumulativeExpectancyPips: cumulative,
    worstRolling30,
    latestRolling30,
    killed,
    promotable: !killed && pending.length === 0,
    pending,
  };
}

/** 判定ログの1エントリ (再現性検証のために保存する最小情報) */
export interface TradeLogEntry {
  entryTime: number;
  exitTime: number;
  direction: 1 | -1;
  plPips: number;
}

export function toLogEntry(t: TradeRecord): TradeLogEntry {
  return { entryTime: t.entryTime, exitTime: t.exitTime, direction: t.direction, plPips: t.plPips };
}

export interface AppendOnlyResult {
  ok: boolean;
  /** 不一致の説明 (ok=false時) */
  error?: string;
  /** storedに対して新規追加されたエントリ */
  appended: TradeLogEntry[];
}

/**
 * 再現性検証 (昇格条件4の観察フェーズ読み替え):
 * 保存済みログが再計算結果の先頭部分と完全一致することを要求する。
 * 一致しない場合はDukascopyの事後データ改訂などの混入であり、観察の
 * 前提が壊れているため呼び出し側は処理を停止して人間に報告すること。
 */
export function verifyAppendOnly(
  stored: readonly TradeLogEntry[],
  recomputed: readonly TradeLogEntry[],
): AppendOnlyResult {
  if (stored.length > recomputed.length) {
    return {
      ok: false,
      error: `保存済み${stored.length}件 > 再計算${recomputed.length}件 (トレードが消失。データ改訂の疑い)`,
      appended: [],
    };
  }
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i]!;
    const r = recomputed[i]!;
    if (
      s.entryTime !== r.entryTime ||
      s.exitTime !== r.exitTime ||
      s.direction !== r.direction ||
      Math.abs(s.plPips - r.plPips) > 1e-9
    ) {
      return {
        ok: false,
        error:
          `${i}番目のトレードが不一致 (保存: ${new Date(s.entryTime).toISOString()} ${s.plPips}p / ` +
          `再計算: ${new Date(r.entryTime).toISOString()} ${r.plPips}p)。データ改訂の疑い`,
        appended: [],
      };
    }
  }
  return { ok: true, appended: recomputed.slice(stored.length) };
}
