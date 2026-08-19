import type { BidAskCandle } from "../core/candle.ts";
import { TF_MS } from "../core/candle.ts";
import { isWeekendClosed } from "../core/sessions.ts";

/**
 * Dukascopyデータの変換ロジック (fs非依存の純粋関数)。
 * ダウンロード自体は scripts/downloadDukascopy.ts が dukascopy-node で行う。
 */

/** dukascopy-node の JsonItem (bid/ask 片側のM1足) */
export interface DukascopyBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface MergeResult {
  candles: BidAskCandle[];
  /** bidのみ・askのみで片側が欠けて捨てたバー数 */
  droppedBidOnly: number;
  droppedAskOnly: number;
}

/**
 * bid系列とask系列をタイムスタンプでマージしてBidAskCandleにする。
 * 片側しか存在しないバーは捨てる (数は報告する)。
 */
export function mergeBidAsk(bids: DukascopyBar[], asks: DukascopyBar[]): MergeResult {
  const askByTime = new Map<number, DukascopyBar>();
  for (const a of asks) askByTime.set(a.timestamp, a);

  const candles: BidAskCandle[] = [];
  let droppedBidOnly = 0;
  for (const b of bids) {
    const a = askByTime.get(b.timestamp);
    if (!a) {
      droppedBidOnly += 1;
      continue;
    }
    askByTime.delete(b.timestamp);
    candles.push({
      time: b.timestamp,
      bid: { o: b.open, h: b.high, l: b.low, c: b.close },
      ask: { o: a.open, h: a.high, l: a.low, c: a.close },
      volume: b.volume ?? 0,
    });
  }
  candles.sort((x, y) => x.time - y.time);
  return { candles, droppedBidOnly, droppedAskOnly: askByTime.size };
}

export interface Gap {
  fromMs: number;
  toMs: number;
  missingBars: number;
}

/**
 * M1系列の欠損ギャップを検出する。週末クローズ (金17:00 NY〜日17:00 NY) に
 * 完全に含まれるギャップは正常として除外する。
 */
export function findGaps(candles: BidAskCandle[], minMissingBars = 5): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    const gapMs = cur.time - prev.time - TF_MS.M1;
    if (gapMs < minMissingBars * TF_MS.M1) continue;
    // ギャップの中央が週末クローズ中なら正常な休場とみなす
    const midpoint = prev.time + TF_MS.M1 + gapMs / 2;
    if (isWeekendClosed(midpoint)) continue;
    gaps.push({
      fromMs: prev.time + TF_MS.M1,
      toMs: cur.time,
      missingBars: Math.round(gapMs / TF_MS.M1),
    });
  }
  return gaps;
}

export function formatGapReport(instrument: string, candles: BidAskCandle[], gaps: Gap[]): string {
  const lines = [
    `${instrument}: ${candles.length}本 (${iso(candles[0]?.time)} 〜 ${iso(candles[candles.length - 1]?.time)})`,
    `平日ギャップ (5本以上の欠損): ${gaps.length}箇所`,
  ];
  for (const g of gaps.slice(0, 20)) {
    lines.push(`  ${iso(g.fromMs)} 〜 ${iso(g.toMs)} (${g.missingBars}本)`);
  }
  if (gaps.length > 20) lines.push(`  ... 他${gaps.length - 20}箇所`);
  return lines.join("\n");
}

function iso(ms: number | undefined): string {
  return ms === undefined ? "?" : new Date(ms).toISOString();
}
