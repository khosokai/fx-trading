/**
 * ローソク足の基本型。FXはBid/Askのスプレッドが損益に直結するため、
 * 仲値(Mid)ではなくBid/Ask両方のOHLCを一級市民として持つ。
 */

export interface OHLC {
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface BidAskCandle {
  /** 足の開始時刻 (ms, UTC) */
  time: number;
  bid: OHLC;
  ask: OHLC;
  /** ティック数ベースの出来高 */
  volume: number;
}

export type Timeframe = "M1" | "M5" | "M15" | "H1";

export const TF_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
};

/** 仲値OHLC。指標計算はスプレッドのノイズを避けるため原則Midで行う */
export function mid(c: BidAskCandle): OHLC {
  return {
    o: (c.bid.o + c.ask.o) / 2,
    h: (c.bid.h + c.ask.h) / 2,
    l: (c.bid.l + c.ask.l) / 2,
    c: (c.bid.c + c.ask.c) / 2,
  };
}

/** 足の終値時点のスプレッド (価格単位) */
export function closeSpread(c: BidAskCandle): number {
  return c.ask.c - c.bid.c;
}
