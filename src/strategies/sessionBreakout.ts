import { mid, TF_MS, type BidAskCandle, type Timeframe } from "../core/candle.ts";
import { atrSeries } from "../core/indicators.ts";
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
 */
export interface SessionBreakoutParams {
  timeframe: Timeframe;
  /** レンジ幅がこのpips未満の日は見送り (ダマシの多い狭レンジ除外) */
  minRangePips: number;
  /** レンジ幅がこのpipsを超える日は見送り (荒れた日除外) */
  maxRangePips: number;
  /** SLのキャップ (pips) */
  maxSlPips: number;
  /** TP = SL幅 × tpR */
  tpR: number;
  /** ブレイク確認バッファ = ATR(14) × この係数 (省略時0 = v1挙動) */
  atrBufferMult?: number;
  /** エントリー許可の終端 (ロンドン現地の分。省略時はセッション終了まで) */
  entryEndLondonMin?: number;
  /** 強制フラット開始 (NY現地の分。省略時はセッション外判定のみ = v1挙動) */
  exitNyMin?: number;
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
  const tfMs = TF_MS[timeframe];
  // 取引日→東京レンジ のキャッシュ (candles配列ごと)
  const cache = new WeakMap<BidAskCandle[], Map<string, DayRange>>();
  const atrCache = new WeakMap<BidAskCandle[], number[]>();

  const atrOf = (candles: BidAskCandle[]): number[] => {
    let a = atrCache.get(candles);
    if (!a) {
      a = atrSeries(candles.map(mid), 14);
      atrCache.set(candles, a);
    }
    return a;
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
      if (inSession(c.time, "tokyo") && inSession(closeTime - 1, "tokyo")) {
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

  const v2Suffix =
    (atrBufferMult > 0 ? `_buf${atrBufferMult}` : "") +
    (entryEndLondonMin !== undefined ? `_ee${entryEndLondonMin}` : "") +
    (exitNyMin !== undefined ? `_xny${exitNyMin}` : "");

  return {
    id: `sessbrk_${timeframe}_r${minRangePips}-${maxRangePips}_sl${maxSlPips}_tp${tpR}${v2Suffix}`,
    name: `SessionBreakout ${timeframe}${v2Suffix}`,
    timeframe,
    // 東京セッション6時間 + ATR(14)分のマージンをカバーする本数
    warmup: Math.max(Math.ceil((8 * 3600_000) / tfMs), 15),
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
        const slPips = Math.min(priceToPips(ctx.instrument, close - range.low), maxSlPips);
        return {
          target: 1,
          stopLossPips: slPips,
          takeProfitPips: slPips * tpR,
          reason: `break>${upper.toFixed(3)} (range ${rangePips.toFixed(1)}p)`,
        };
      }
      if (close < lower && prevClose >= lower) {
        const slPips = Math.min(priceToPips(ctx.instrument, range.high - close), maxSlPips);
        return {
          target: -1,
          stopLossPips: slPips,
          takeProfitPips: slPips * tpR,
          reason: `break<${lower.toFixed(3)} (range ${rangePips.toFixed(1)}p)`,
        };
      }
      return { target: 0 };
    },
  };
}
