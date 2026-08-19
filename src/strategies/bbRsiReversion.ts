import { mid, type BidAskCandle, type Timeframe } from "../core/candle.ts";
import { atrSeries, bollingerSeries, rsiSeries } from "../core/indicators.ts";
import { pipSize } from "../core/pips.ts";
import type { Decision, Strategy, StrategyContext } from "../core/strategy.ts";

/**
 * ボリンジャーバンド + RSI の平均回帰 (逆張り)。
 * バンド外 + RSI過熱で逆張りエントリーし、ミドルバンド回帰で手仕舞い。
 * レンジ相場のアジア時間と相性が良い (セッション制限はエンジンのsessionFilterで)。
 */
export interface BbRsiParams {
  timeframe: Timeframe;
  bbPeriod: number;
  bbSigma: number;
  rsiPeriod: number;
  rsiLower: number; // 例: 30
  rsiUpper: number; // 例: 70
  atrPeriod: number;
  slAtrMult: number;
}

interface SeriesCache {
  upper: number[];
  middle: number[];
  lower: number[];
  rsi: number[];
  atr: number[];
}

export function makeBbRsiReversion(params: BbRsiParams): Strategy {
  const { timeframe, bbPeriod, bbSigma, rsiPeriod, rsiLower, rsiUpper, atrPeriod, slAtrMult } =
    params;
  const cache = new WeakMap<BidAskCandle[], SeriesCache>();

  const series = (candles: BidAskCandle[]): SeriesCache => {
    let s = cache.get(candles);
    if (!s) {
      const ohlc = candles.map(mid);
      const closes = ohlc.map((c) => c.c);
      const bb = bollingerSeries(closes, bbPeriod, bbSigma);
      s = {
        upper: bb.upper,
        middle: bb.middle,
        lower: bb.lower,
        rsi: rsiSeries(closes, rsiPeriod),
        atr: atrSeries(ohlc, atrPeriod),
      };
      cache.set(candles, s);
    }
    return s;
  };

  return {
    id: `bbrsi_${timeframe}_bb${bbPeriod}x${bbSigma}_rsi${rsiPeriod}_${rsiLower}-${rsiUpper}_atr${atrPeriod}x${slAtrMult}`,
    name: `BB+RSI Reversion ${timeframe}`,
    timeframe,
    warmup: Math.max(bbPeriod, rsiPeriod + 1, atrPeriod + 1),
    decide(ctx: StrategyContext): Decision {
      const { candles, index: i, position } = ctx;
      const s = series(candles);
      const close = mid(candles[i]!).c;
      const upper = s.upper[i]!;
      const middle = s.middle[i]!;
      const lower = s.lower[i]!;
      const rsi = s.rsi[i]!;
      const atr = s.atr[i]!;
      if (Number.isNaN(upper) || Number.isNaN(rsi) || Number.isNaN(atr) || atr <= 0) {
        return { target: position };
      }

      if (position === 1) {
        // ミドルバンド回帰で手仕舞い
        return close >= middle ? { target: 0, reason: "revert-mid" } : { target: 1 };
      }
      if (position === -1) {
        return close <= middle ? { target: 0, reason: "revert-mid" } : { target: -1 };
      }

      const slPips = (atr * slAtrMult) / pipSize(ctx.instrument);
      if (close < lower && rsi < rsiLower) {
        return { target: 1, stopLossPips: slPips, reason: `bb-low rsi=${rsi.toFixed(0)}` };
      }
      if (close > upper && rsi > rsiUpper) {
        return { target: -1, stopLossPips: slPips, reason: `bb-high rsi=${rsi.toFixed(0)}` };
      }
      return { target: 0 };
    },
  };
}
