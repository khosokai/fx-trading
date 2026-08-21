import { mid, type BidAskCandle, type Timeframe } from "../core/candle.ts";
import { adxSeries, atrSeries, donchianSeries, emaSeries } from "../core/indicators.ts";
import { pipSize } from "../core/pips.ts";
import type { Decision, Strategy, StrategyContext } from "../core/strategy.ts";

/**
 * ドンチャンチャネル・ブレイクアウト (タートルズ系)。
 * gmo-coin研究で唯一WFAを通過した系統のFX版 (ロング/ショート対応)。
 *
 * - エントリー: 終値がentry期間チャネルを上抜け→ロング、下抜け→ショート
 * - エグジット: 終値がexit期間チャネルを逆側に抜けたら手仕舞い (+SL)
 * - SL: ATR × slAtrMult (pips換算)
 * - オプションのエントリーフィルタ (研究第2ラウンド R2-B/R2-C):
 *   trendEmaPeriod: 終値がEMAより上ならロングのみ・下ならショートのみ許可
 *   adxPeriod/adxMin: ADXが閾値以上のときだけ新規エントリー許可
 *   (フィルタは新規エントリーのみに効く。手仕舞い・ドテンの決済側は常に有効)
 */
export interface DonchianParams {
  timeframe: Timeframe;
  entryPeriod: number;
  exitPeriod: number;
  atrPeriod: number;
  slAtrMult: number;
  /** 設定時: EMA方向と一致する方向のみエントリー */
  trendEmaPeriod?: number;
  /** 設定時: ADX(adxPeriod) >= adxMin のときのみエントリー */
  adxPeriod?: number;
  adxMin?: number;
}

interface SeriesCache {
  entryUpper: number[];
  entryLower: number[];
  exitUpper: number[];
  exitLower: number[];
  atr: number[];
  ema: number[] | null;
  adx: number[] | null;
}

export function makeDonchian(params: DonchianParams): Strategy {
  const { timeframe, entryPeriod, exitPeriod, atrPeriod, slAtrMult } = params;
  const trendEmaPeriod = params.trendEmaPeriod;
  const adxPeriod = params.adxPeriod;
  const adxMin = params.adxMin;
  if ((adxPeriod === undefined) !== (adxMin === undefined)) {
    throw new Error("adxPeriodとadxMinは両方指定するか両方省略する");
  }
  const cache = new WeakMap<BidAskCandle[], SeriesCache>();

  const series = (candles: BidAskCandle[]): SeriesCache => {
    let s = cache.get(candles);
    if (!s) {
      const ohlc = candles.map(mid);
      const closes = ohlc.map((c) => c.c);
      const entry = donchianSeries(ohlc, entryPeriod);
      const exit = donchianSeries(ohlc, exitPeriod);
      s = {
        entryUpper: entry.upper,
        entryLower: entry.lower,
        exitUpper: exit.upper,
        exitLower: exit.lower,
        atr: atrSeries(ohlc, atrPeriod),
        ema: trendEmaPeriod !== undefined ? emaSeries(closes, trendEmaPeriod) : null,
        adx: adxPeriod !== undefined ? adxSeries(ohlc, adxPeriod) : null,
      };
      cache.set(candles, s);
    }
    return s;
  };

  const filterSuffix =
    (trendEmaPeriod !== undefined ? `_ema${trendEmaPeriod}` : "") +
    (adxPeriod !== undefined ? `_adx${adxPeriod}-${adxMin}` : "");

  return {
    id: `donchian_${timeframe}_${entryPeriod}_${exitPeriod}_atr${atrPeriod}x${slAtrMult}${filterSuffix}`,
    name: `Donchian(${entryPeriod},${exitPeriod}) ${timeframe}${filterSuffix}`,
    timeframe,
    warmup:
      Math.max(entryPeriod, exitPeriod, atrPeriod, trendEmaPeriod ?? 0, (adxPeriod ?? 0) * 2) + 1,
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

      // エントリーフィルタ (新規方向の許可判定。決済側には効かせない)
      const ema = s.ema?.[i];
      const adx = s.adx?.[i];
      const adxOk = adx === undefined || (!Number.isNaN(adx) && adx >= (adxMin ?? 0));
      const longAllowed = adxOk && (ema === undefined || (!Number.isNaN(ema) && close > ema));
      const shortAllowed = adxOk && (ema === undefined || (!Number.isNaN(ema) && close < ema));

      if (position === 0) {
        if (close > entryUpper && longAllowed) {
          return { target: 1, stopLossPips: slPips, reason: `close>${entryUpper.toFixed(3)}` };
        }
        if (close < entryLower && shortAllowed) {
          return { target: -1, stopLossPips: slPips, reason: `close<${entryLower.toFixed(3)}` };
        }
        return { target: 0 };
      }
      if (position === 1) {
        // ロング中: exit期間の安値割れで手仕舞い。逆側ブレイクはフィルタが許せばドテン、
        // 許さなければ手仕舞いのみ (決済は常に有効)
        if (close < entryLower) {
          return shortAllowed
            ? { target: -1, stopLossPips: slPips, reason: "reverse" }
            : { target: 0, reason: "exit-opposite-break" };
        }
        if (close < exitLower) return { target: 0, reason: "exit-channel" };
        return { target: 1 };
      }
      // ショート中
      if (close > entryUpper) {
        return longAllowed
          ? { target: 1, stopLossPips: slPips, reason: "reverse" }
          : { target: 0, reason: "exit-opposite-break" };
      }
      if (close > exitUpper) return { target: 0, reason: "exit-channel" };
      return { target: -1 };
    },
  };
}
