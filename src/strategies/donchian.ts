import { mid, type BidAskCandle, type Timeframe } from "../core/candle.ts";
import { atrSeries, donchianSeries } from "../core/indicators.ts";
import { pipSize } from "../core/pips.ts";
import type { Decision, Strategy, StrategyContext } from "../core/strategy.ts";

/**
 * ドンチャンチャネル・ブレイクアウト (タートルズ系)。
 * gmo-coin研究で唯一WFAを通過した系統のFX版 (ロング/ショート対応)。
 *
 * - エントリー: 終値がentry期間チャネルを上抜け→ロング、下抜け→ショート
 * - エグジット: 終値がexit期間チャネルを逆側に抜けたら手仕舞い (+SL)
 * - SL: ATR × slAtrMult (pips換算)
 */
export interface DonchianParams {
  timeframe: Timeframe;
  entryPeriod: number;
  exitPeriod: number;
  atrPeriod: number;
  slAtrMult: number;
}

interface SeriesCache {
  entryUpper: number[];
  entryLower: number[];
  exitUpper: number[];
  exitLower: number[];
  atr: number[];
}

export function makeDonchian(params: DonchianParams): Strategy {
  const { timeframe, entryPeriod, exitPeriod, atrPeriod, slAtrMult } = params;
  const cache = new WeakMap<BidAskCandle[], SeriesCache>();

  const series = (candles: BidAskCandle[]): SeriesCache => {
    let s = cache.get(candles);
    if (!s) {
      const ohlc = candles.map(mid);
      const entry = donchianSeries(ohlc, entryPeriod);
      const exit = donchianSeries(ohlc, exitPeriod);
      s = {
        entryUpper: entry.upper,
        entryLower: entry.lower,
        exitUpper: exit.upper,
        exitLower: exit.lower,
        atr: atrSeries(ohlc, atrPeriod),
      };
      cache.set(candles, s);
    }
    return s;
  };

  return {
    id: `donchian_${timeframe}_${entryPeriod}_${exitPeriod}_atr${atrPeriod}x${slAtrMult}`,
    name: `Donchian(${entryPeriod},${exitPeriod}) ${timeframe}`,
    timeframe,
    warmup: Math.max(entryPeriod, exitPeriod, atrPeriod) + 1,
    decide(ctx: StrategyContext): Decision {
      const { candles, index: i, position } = ctx;
      const s = series(candles);
      const close = mid(candles[i]!).c;
      // ブレイク判定は「現在の足を含まない」チャネル (i-1まで) と比較する
      const entryUpper = s.entryUpper[i - 1]!;
      const entryLower = s.entryLower[i - 1]!;
      const exitUpper = s.exitUpper[i - 1]!;
      const exitLower = s.exitLower[i - 1]!;
      const atr = s.atr[i]!;
      if (
        Number.isNaN(entryUpper) ||
        Number.isNaN(exitUpper) ||
        Number.isNaN(atr) ||
        atr <= 0
      ) {
        return { target: position };
      }
      const slPips = (atr * slAtrMult) / pipSize(ctx.instrument);

      if (position === 0) {
        if (close > entryUpper) {
          return { target: 1, stopLossPips: slPips, reason: `close>${entryUpper.toFixed(3)}` };
        }
        if (close < entryLower) {
          return { target: -1, stopLossPips: slPips, reason: `close<${entryLower.toFixed(3)}` };
        }
        return { target: 0 };
      }
      if (position === 1) {
        // ロング中: exit期間の安値割れで手仕舞い。ドテンは直接反転
        if (close < entryLower) return { target: -1, stopLossPips: slPips, reason: "reverse" };
        if (close < exitLower) return { target: 0, reason: "exit-channel" };
        return { target: 1 };
      }
      // ショート中
      if (close > entryUpper) return { target: 1, stopLossPips: slPips, reason: "reverse" };
      if (close > exitUpper) return { target: 0, reason: "exit-channel" };
      return { target: -1 };
    },
  };
}
