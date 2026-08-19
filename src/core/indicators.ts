import type { OHLC } from "./candle.ts";

/**
 * テクニカル指標。gmo-coin/src/backtest/indicators.ts から移植・拡張。
 * すべて入力と同じ長さの配列を返し、計算に必要な期間が揃わない
 * インデックスはNaNになる (NaNパディング規約)。
 *
 * 価格系列は仲値(mid)のcloseやOHLCを渡す想定。FXではスプレッドのノイズを
 * 指標に混ぜないため、Bid/Askではなく仲値で計算するのが原則。
 */

export function smaSeries(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function emaSeries(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (n + 1);
  let ema = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === n - 1) {
      // 最初のEMAはSMAで初期化
      let sum = 0;
      for (let j = 0; j < n; j++) sum += values[j]!;
      ema = sum / n;
    } else if (i >= n) {
      ema = values[i]! * k + ema * (1 - k);
    }
    if (i >= n - 1) out[i] = ema;
  }
  return out;
}

/** RSI (Wilder方式)。0〜100 */
export function rsiSeries(values: number[], n: number): number[] {
  const len = values.length;
  const out = new Array<number>(len).fill(NaN);
  if (len < n + 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < len; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= n) {
      avgGain += gain;
      avgLoss += loss;
      if (i < n) continue;
      avgGain /= n;
      avgLoss /= n;
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
    }
    out[i] = avgGain + avgLoss === 0 ? 50 : (100 * avgGain) / (avgGain + avgLoss);
  }
  return out;
}

export interface BollingerBands {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function bollingerSeries(values: number[], n: number, sigma: number): BollingerBands {
  const len = values.length;
  const upper = new Array<number>(len).fill(NaN);
  const middle = new Array<number>(len).fill(NaN);
  const lower = new Array<number>(len).fill(NaN);
  for (let i = n - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += values[j]!;
    const mean = sum / n;
    let variance = 0;
    for (let j = i - n + 1; j <= i; j++) variance += (values[j]! - mean) ** 2;
    const std = Math.sqrt(variance / n);
    middle[i] = mean;
    upper[i] = mean + sigma * std;
    lower[i] = mean - sigma * std;
  }
  return { upper, middle, lower };
}

/** ATR (Wilder方式)。価格単位で返す (pips換算は呼び出し側でpipSizeを使う) */
export function atrSeries(ohlc: OHLC[], n: number): number[] {
  const len = ohlc.length;
  const out = new Array<number>(len).fill(NaN);
  let atr = 0;
  for (let i = 1; i < len; i++) {
    const c = ohlc[i]!;
    const p = ohlc[i - 1]!;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    if (i <= n) {
      atr += tr;
      if (i === n) atr /= n;
      else continue;
    } else {
      atr = (atr * (n - 1) + tr) / n;
    }
    out[i] = atr;
  }
  return out;
}

export interface DonchianChannel {
  /** 直近n本 (現在の足を含む) の最高値 */
  upper: number[];
  /** 直近n本 (現在の足を含む) の最安値 */
  lower: number[];
}

/**
 * ドンチャンチャネル。ブレイク判定では「現在の足を含まない」チャネルと
 * 比較したいことが多いため、戦略側は upper[i-1] を参照する。
 */
export function donchianSeries(ohlc: OHLC[], n: number): DonchianChannel {
  const len = ohlc.length;
  const upper = new Array<number>(len).fill(NaN);
  const lower = new Array<number>(len).fill(NaN);
  for (let i = n - 1; i < len; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, ohlc[j]!.h);
      lo = Math.min(lo, ohlc[j]!.l);
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** ADX (Wilder方式, 平均方向性指数)。トレンドの強さを示す */
export function adxSeries(ohlc: OHLC[], n: number): number[] {
  const len = ohlc.length;
  const out = new Array<number>(len).fill(NaN);
  if (len < n * 2 + 1) return out;

  const tr = new Array<number>(len).fill(NaN);
  const plusDM = new Array<number>(len).fill(NaN);
  const minusDM = new Array<number>(len).fill(NaN);
  for (let i = 1; i < len; i++) {
    const c = ohlc[i]!;
    const p = ohlc[i - 1]!;
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    const up = c.h - p.h;
    const down = p.l - c.l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  // Wilder平滑化
  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  const dx = new Array<number>(len).fill(NaN);
  for (let i = 1; i < len; i++) {
    if (i <= n) {
      trS += tr[i]!;
      plusS += plusDM[i]!;
      minusS += minusDM[i]!;
      if (i < n) continue;
    } else {
      trS = trS - trS / n + tr[i]!;
      plusS = plusS - plusS / n + plusDM[i]!;
      minusS = minusS - minusS / n + minusDM[i]!;
    }
    if (trS === 0) {
      dx[i] = 0;
      continue;
    }
    const plusDI = (100 * plusS) / trS;
    const minusDI = (100 * minusS) / trS;
    dx[i] = plusDI + minusDI === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI);
  }

  let adx = NaN;
  let count = 0;
  let sum = 0;
  for (let i = n; i < len; i++) {
    if (Number.isNaN(dx[i]!)) continue;
    count += 1;
    if (count <= n) {
      sum += dx[i]!;
      if (count === n) adx = sum / n;
    } else {
      adx = (adx * (n - 1) + dx[i]!) / n;
    }
    if (count >= n) out[i] = adx;
  }
  return out;
}

/** ボリンジャーバンド幅 (Upper-Lower)/Middle。ボラの圧縮・拡大を示す */
export function bbwSeries(values: number[], n: number, sigma: number): number[] {
  const { upper, middle, lower } = bollingerSeries(values, n, sigma);
  return values.map((_, i) => {
    const m = middle[i]!;
    if (Number.isNaN(m) || m === 0) return NaN;
    return (upper[i]! - lower[i]!) / m;
  });
}

/** 系列の各点について、直近window個の中でのパーセンタイル(0-1)を返す */
export function rollingPercentile(values: number[], window: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) continue;
    let count = 0;
    let below = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const u = values[j]!;
      if (Number.isNaN(u)) continue;
      count += 1;
      if (u <= v) below += 1;
    }
    if (count >= window * 0.8) out[i] = below / count;
  }
  return out;
}
