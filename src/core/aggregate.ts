import { TF_MS, type BidAskCandle, type Timeframe } from "./candle.ts";

/**
 * M1足から上位足への集計。バックテスト(Dukascopy M1)と本番(OANDA M1)が
 * 同一のこの実装を使うことで、プロバイダ側の足の切り方の差異を
 * パリティ検証から排除する (パリティ原則)。
 *
 * - バケットはUTCエポックからの固定境界 (floor(time / TF_MS))
 * - 欠損バーがあってもバケットは存在するM1からのみ作られる (週末ギャップ対応)
 * - 入力はtime昇順であること (アサートする)
 */
export function aggregateCandles(m1: BidAskCandle[], tf: Timeframe): BidAskCandle[] {
  if (tf === "M1") return m1;
  const bucketMs = TF_MS[tf];
  const out: BidAskCandle[] = [];
  let current: BidAskCandle | null = null;
  let currentBucket = -1;
  let prevTime = -Infinity;

  for (const c of m1) {
    if (c.time <= prevTime) {
      throw new Error(`M1が時刻昇順ではありません: ${c.time} <= ${prevTime}`);
    }
    prevTime = c.time;

    const bucket = Math.floor(c.time / bucketMs);
    if (bucket !== currentBucket) {
      if (current) out.push(current);
      currentBucket = bucket;
      current = {
        time: bucket * bucketMs,
        bid: { ...c.bid },
        ask: { ...c.ask },
        volume: c.volume,
      };
    } else if (current) {
      current.bid.h = Math.max(current.bid.h, c.bid.h);
      current.bid.l = Math.min(current.bid.l, c.bid.l);
      current.bid.c = c.bid.c;
      current.ask.h = Math.max(current.ask.h, c.ask.h);
      current.ask.l = Math.min(current.ask.l, c.ask.l);
      current.ask.c = c.ask.c;
      current.volume += c.volume;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * 「確定した」上位足だけを返す集計。
 * 最後のバケットは、そのバケットの最終M1 (bucketEnd - 1分の足) が含まれている
 * 場合のみ確定とみなす。本番でM1確定足列から上位足を作るときに使う。
 */
export function aggregateClosed(m1: BidAskCandle[], tf: Timeframe): BidAskCandle[] {
  const all = aggregateCandles(m1, tf);
  if (tf === "M1" || all.length === 0) return all;
  const bucketMs = TF_MS[tf];
  const last = all[all.length - 1]!;
  const lastM1 = m1[m1.length - 1]!;
  // 最後のM1がバケット末尾の1分でなければ、そのバケットは未確定
  if (lastM1.time + TF_MS.M1 < last.time + bucketMs) return all.slice(0, -1);
  return all;
}
