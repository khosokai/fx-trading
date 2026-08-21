import { mid, TF_MS, type BidAskCandle, type Timeframe } from "../core/candle.ts";
import { atrSeries, emaSeries } from "../core/indicators.ts";
import { priceToPips } from "../core/pips.ts";
import { inSession, tradingDay, zonedTime } from "../core/sessions.ts";
import type { Decision, Strategy, StrategyContext } from "../core/strategy.ts";

/**
 * 東京レンジ・ロンドンブレイクアウト。
 * 東京セッション (9:00-15:00 JST) の高値安値レンジを、ロンドンセッション中に
 * 終値がクロスして抜けたらその方向にエントリーする定番のデイトレ戦略。
 *
 * - エントリー: ロンドンセッション中、前の足がレンジ内・今の足の終値がレンジ外
 * - SL: レンジ逆側 (maxSlPipsでキャップ)、TP: SL幅 × tpR
 * - 手仕舞い: ロンドン/NYセッションが両方終わったらクローズ (オーバーナイトしない)
 *
 * v2オプション (研究第3ラウンド R3-A):
 * - atrBufferMult: レンジ端 + ATR(14)×係数 を超えて初めてブレイクとみなす (ノイズ抜け排除)
 * - entryEndLondonMin: エントリーをロンドン現地この分まで限定 (初動限定)
 * - exitNyMin: NY現地この分以降は強制フラット (早い時間切れ決済)
 *
 * v3オプション (研究第5ラウンド、事前登録 2026-08-21):
 * - rangePercentileMin/rangePercentileLookback (R5-A): 当日レンジ幅が過去N取引日の
 *   pパーセンタイル以上の日のみエントリー (ボラティリティレジームフィルタ)
 * - trendEmaPeriod (R5-B): 終値EMA方向と一致するブレイクのみエントリー
 *
 * v4オプション (研究第6ラウンド、事前登録 2026-08-21):
 * - rangeStartLondonMin/rangeEndLondonMin (R6-A): レンジ箱をロンドン現地の
 *   時間窓で集計 (欧州オープニングレンジ)。省略時は東京セッション全体
 * - tpR省略 (R6-B): TPなし。SLと時間切れのみで決済し利益を伸ばす
 */
export interface SessionBreakoutParams {
  timeframe: Timeframe;
  /** レンジ幅がこのpips未満の日は見送り (ダマシの多い狭レンジ除外) */
  minRangePips: number;
  /** レンジ幅がこのpipsを超える日は見送り (荒れた日除外) */
  maxRangePips: number;
  /** SLのキャップ (pips) */
  maxSlPips: number;
  /** TP = SL幅 × tpR。省略時はTPなし (SLと時間切れのみで決済。R6-B) */
  tpR?: number;
  /** ブレイク確認バッファ = ATR(14) × この係数 (省略時0 = v1挙動) */
  atrBufferMult?: number;
  /** エントリー許可の終端 (ロンドン現地の分。省略時はセッション終了まで) */
  entryEndLondonMin?: number;
  /** 強制フラット開始 (NY現地の分。省略時はセッション外判定のみ = v1挙動) */
  exitNyMin?: number;
  /**
   * v3 R5-A: ボラティリティレジームフィルタ。当日の東京レンジ幅が
   * 「過去rangePercentileLookback取引日のレンジ幅のこのパーセンタイル」以上の
   * 日のみエントリー許可 (0-100。省略時は無効)
   */
  rangePercentileMin?: number;
  /** レンジ幅パーセンタイルの参照日数 (デフォルト20取引日) */
  rangePercentileLookback?: number;
  /**
   * v3 R5-B: 長期トレンドフィルタ。M15終値EMA(この期間)に対し、
   * ロングは close > EMA、ショートは close < EMA の時のみ許可 (省略時は無効)
   */
  trendEmaPeriod?: number;
  /**
   * v4 R6-A: レンジ箱をロンドン現地 [start, end) 分の窓で集計する
   * (欧州オープニングレンジ)。両方省略時は東京セッション全体 (従来挙動)
   */
  rangeStartLondonMin?: number;
  rangeEndLondonMin?: number;
}

interface DayRange {
  high: number;
  low: number;
  bars: number;
}

export function makeSessionBreakout(params: SessionBreakoutParams): Strategy {
  const { timeframe, minRangePips, maxRangePips, maxSlPips, tpR } = params;
  const atrBufferMult = params.atrBufferMult ?? 0;
  const entryEndLondonMin = params.entryEndLondonMin;
  const exitNyMin = params.exitNyMin;
  const rangePercentileMin = params.rangePercentileMin;
  const rangePercentileLookback = params.rangePercentileLookback ?? 20;
  const trendEmaPeriod = params.trendEmaPeriod;
  const rangeStartLondonMin = params.rangeStartLondonMin;
  const rangeEndLondonMin = params.rangeEndLondonMin;
  const tfMs = TF_MS[timeframe];

  /** レンジ箱に含めるバーか (open/close両端が窓内)。R6-A窓が優先、なければ東京 */
  const inRangeBox = (openMs: number, closeMs: number): boolean => {
    if (rangeStartLondonMin !== undefined && rangeEndLondonMin !== undefined) {
      const o = zonedTime(openMs, "Europe/London");
      if (o.weekday === 0 || o.weekday === 6) return false;
      const c = zonedTime(closeMs, "Europe/London");
      const om = o.hour * 60 + o.minute;
      const cm = c.hour * 60 + c.minute;
      return om >= rangeStartLondonMin && cm < rangeEndLondonMin;
    }
    return inSession(openMs, "tokyo") && inSession(closeMs, "tokyo");
  };
  // 取引日→東京レンジ のキャッシュ (candles配列ごと)
  const cache = new WeakMap<BidAskCandle[], Map<string, DayRange>>();
  const atrCache = new WeakMap<BidAskCandle[], number[]>();
  const emaCache = new WeakMap<BidAskCandle[], number[]>();
  // 取引日→「過去lookback日のレンジ幅リスト」のキャッシュ (R5-A)
  const pastRangesCache = new WeakMap<BidAskCandle[], Map<string, number[]>>();

  const atrOf = (candles: BidAskCandle[]): number[] => {
    let a = atrCache.get(candles);
    if (!a) {
      a = atrSeries(candles.map(mid), 14);
      atrCache.set(candles, a);
    }
    return a;
  };

  const emaOf = (candles: BidAskCandle[]): number[] => {
    let e = emaCache.get(candles);
    if (!e) {
      e = emaSeries(candles.map((c) => mid(c).c), trendEmaPeriod!);
      emaCache.set(candles, e);
    }
    return e;
  };

  const tokyoRange = (candles: BidAskCandle[], upTo: number, day: string): DayRange | null => {
    let byDay = cache.get(candles);
    if (!byDay) {
      byDay = new Map();
      cache.set(candles, byDay);
    }
    const cached = byDay.get(day);
    if (cached) return cached;
    // upToから過去に向かって同じ取引日の東京セッション足を集める
    let high = -Infinity;
    let low = Infinity;
    let bars = 0;
    for (let j = upTo; j >= 0; j--) {
      const c = candles[j]!;
      const closeTime = c.time + tfMs;
      if (tradingDay(c.time) !== day) break;
      if (inRangeBox(c.time, closeTime - 1)) {
        const m = mid(c);
        high = Math.max(high, m.h);
        low = Math.min(low, m.l);
        bars += 1;
      }
    }
    if (bars === 0) return null;
    const range = { high, low, bars };
    byDay.set(day, range);
    return range;
  };

  /**
   * 過去rangePercentileLookback取引日ぶんの東京レンジ幅pips (R5-A)。
   * upToの属する取引日 (day) 自身は含めない。取引日ごとにキャッシュ。
   */
  const pastRangePips = (
    candles: BidAskCandle[],
    upTo: number,
    day: string,
    instrument: string,
  ): number[] => {
    let byDay = pastRangesCache.get(candles);
    if (!byDay) {
      byDay = new Map();
      pastRangesCache.set(candles, byDay);
    }
    const cached = byDay.get(day);
    if (cached) return cached;
    const list: number[] = [];
    let j = upTo;
    // 当日の足を読み飛ばす
    while (j >= 0 && tradingDay(candles[j]!.time) === day) j--;
    while (j >= 0 && list.length < rangePercentileLookback) {
      const d = tradingDay(candles[j]!.time);
      const r = tokyoRange(candles, j, d);
      if (r) list.push(priceToPips(instrument, r.high - r.low));
      while (j >= 0 && tradingDay(candles[j]!.time) === d) j--;
    }
    byDay.set(day, list);
    return list;
  };

  const v2Suffix =
    (atrBufferMult > 0 ? `_buf${atrBufferMult}` : "") +
    (entryEndLondonMin !== undefined ? `_ee${entryEndLondonMin}` : "") +
    (exitNyMin !== undefined ? `_xny${exitNyMin}` : "") +
    (rangePercentileMin !== undefined ? `_volp${rangePercentileMin}` : "") +
    (trendEmaPeriod !== undefined ? `_tema${trendEmaPeriod}` : "") +
    (rangeStartLondonMin !== undefined ? `_box${rangeStartLondonMin}-${rangeEndLondonMin}` : "");

  return {
    id: `sessbrk_${timeframe}_r${minRangePips}-${maxRangePips}_sl${maxSlPips}_tp${tpR ?? "none"}${v2Suffix}`,
    name: `SessionBreakout ${timeframe}${v2Suffix}`,
    timeframe,
    // 東京セッション6時間 + ATR(14)分のマージン。R5-Aはレンジ参照日数、
    // R5-BはEMA収束分 (2×期間) まで助走を広げる
    warmup: Math.max(
      Math.ceil((8 * 3600_000) / tfMs),
      15,
      rangePercentileMin !== undefined
        ? Math.ceil((rangePercentileLookback * 1.5 * 86_400_000) / tfMs)
        : 0,
      trendEmaPeriod !== undefined ? trendEmaPeriod * 2 : 0,
    ),
    decide(ctx: StrategyContext): Decision {
      const { candles, index: i, position } = ctx;
      const bar = candles[i]!;
      const closeTime = bar.time + tfMs;
      const inLondon = inSession(bar.time, "london");
      const inNy = inSession(bar.time, "newyork");

      if (position !== 0) {
        // v2: NY現地のexitNyMin以降は強制フラット (早い時間切れ決済)
        if (exitNyMin !== undefined) {
          const ny = zonedTime(bar.time, "America/New_York");
          if (ny.hour * 60 + ny.minute >= exitNyMin) {
            return { target: 0, reason: "time-exit-ny" };
          }
        }
        // セッション外では常にフラット (オーバーナイトしない)
        if (!inLondon && !inNy) return { target: 0, reason: "session-end" };
        return { target: position };
      }
      if (!inLondon) return { target: 0 };
      // v2: エントリーはロンドン初動のみ
      if (entryEndLondonMin !== undefined) {
        const lon = zonedTime(bar.time, "Europe/London");
        if (lon.hour * 60 + lon.minute >= entryEndLondonMin) return { target: 0 };
      }

      const day = tradingDay(closeTime - 1);
      const range = tokyoRange(candles, i, day);
      if (!range) return { target: 0 };

      const rangePips = priceToPips(ctx.instrument, range.high - range.low);
      if (rangePips < minRangePips || rangePips > maxRangePips) return { target: 0 };

      // v3 R5-A: 過去比で広いレンジの日のみ許可 (参照日数が揃うまでは見送り)
      if (rangePercentileMin !== undefined) {
        const past = pastRangePips(candles, i, day, ctx.instrument);
        if (past.length < rangePercentileLookback) return { target: 0 };
        const sorted = [...past].sort((a, b) => a - b);
        const threshold = sorted[Math.floor((rangePercentileMin / 100) * (sorted.length - 1))]!;
        if (rangePips < threshold) return { target: 0 };
      }

      // v3 R5-B: 長期トレンド方向の取得 (未収束なら見送り)
      let trendEma: number | null = null;
      if (trendEmaPeriod !== undefined) {
        trendEma = emaOf(candles)[i]!;
        if (Number.isNaN(trendEma)) return { target: 0 };
      }

      // v2: ATRバッファでノイズ抜けを排除
      let buffer = 0;
      if (atrBufferMult > 0) {
        const atr = atrOf(candles)[i]!;
        if (Number.isNaN(atr)) return { target: 0 };
        buffer = atr * atrBufferMult;
      }
      const upper = range.high + buffer;
      const lower = range.low - buffer;

      const close = mid(bar).c;
      const prevClose = i > 0 ? mid(candles[i - 1]!).c : close;

      // クロス条件: 前の足は閾値内 (再エントリー暴発防止)
      if (close > upper && prevClose <= upper) {
        if (trendEma !== null && close <= trendEma) return { target: 0 }; // R5-B: 逆行ロング禁止
        const slPips = Math.min(priceToPips(ctx.instrument, close - range.low), maxSlPips);
        return {
          target: 1,
          stopLossPips: slPips,
          ...(tpR !== undefined ? { takeProfitPips: slPips * tpR } : {}), // R6-B: TPなし可
          reason: `break>${upper.toFixed(3)} (range ${rangePips.toFixed(1)}p)`,
        };
      }
      if (close < lower && prevClose >= lower) {
        if (trendEma !== null && close >= trendEma) return { target: 0 }; // R5-B: 逆行ショート禁止
        const slPips = Math.min(priceToPips(ctx.instrument, range.high - close), maxSlPips);
        return {
          target: -1,
          stopLossPips: slPips,
          ...(tpR !== undefined ? { takeProfitPips: slPips * tpR } : {}),
          reason: `break<${lower.toFixed(3)} (range ${rangePips.toFixed(1)}p)`,
        };
      }
      return { target: 0 };
    },
  };
}
