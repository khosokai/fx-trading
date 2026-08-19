import { mid, TF_MS, type BidAskCandle, type Timeframe } from "../core/candle.ts";
import { pipSize, priceToPips } from "../core/pips.ts";
import { inSession, tradingDay } from "../core/sessions.ts";
import type { Decision, Strategy, StrategyContext } from "../core/strategy.ts";

/**
 * 東京レンジ・ロンドンブレイクアウト。
 * 東京セッション (9:00-15:00 JST) の高値安値レンジを、ロンドンセッション中に
 * 終値がクロスして抜けたらその方向にエントリーする定番のデイトレ戦略。
 *
 * - エントリー: ロンドンセッション中、前の足がレンジ内・今の足の終値がレンジ外
 * - SL: レンジ逆側 (maxSlPipsでキャップ)、TP: SL幅 × tpR
 * - 手仕舞い: ロンドン/NYセッションが両方終わったらクローズ (オーバーナイトしない)
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
}

interface DayRange {
  high: number;
  low: number;
  bars: number;
}

export function makeSessionBreakout(params: SessionBreakoutParams): Strategy {
  const { timeframe, minRangePips, maxRangePips, maxSlPips, tpR } = params;
  const tfMs = TF_MS[timeframe];
  // 取引日→東京レンジ のキャッシュ (candles配列ごと)
  const cache = new WeakMap<BidAskCandle[], Map<string, DayRange>>();

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

  return {
    id: `sessbrk_${timeframe}_r${minRangePips}-${maxRangePips}_sl${maxSlPips}_tp${tpR}`,
    name: `SessionBreakout ${timeframe}`,
    timeframe,
    // 東京セッション6時間 + マージンをカバーする本数
    warmup: Math.ceil((8 * 3600_000) / tfMs),
    decide(ctx: StrategyContext): Decision {
      const { candles, index: i, position } = ctx;
      const bar = candles[i]!;
      const closeTime = bar.time + tfMs;
      const inLondon = inSession(bar.time, "london");
      const inNy = inSession(bar.time, "newyork");

      // セッション外では常にフラット (オーバーナイトしない)
      if (position !== 0 && !inLondon && !inNy) {
        return { target: 0, reason: "session-end" };
      }
      if (position !== 0) return { target: position };
      if (!inLondon) return { target: 0 };

      const day = tradingDay(closeTime - 1);
      const range = tokyoRange(candles, i, day);
      if (!range) return { target: 0 };

      const pip = pipSize(ctx.instrument);
      const rangePips = priceToPips(ctx.instrument, range.high - range.low);
      if (rangePips < minRangePips || rangePips > maxRangePips) return { target: 0 };

      const close = mid(bar).c;
      const prevClose = i > 0 ? mid(candles[i - 1]!).c : close;

      // クロス条件: 前の足はレンジ内 (再エントリー暴発防止)
      if (close > range.high && prevClose <= range.high) {
        const slPips = Math.min(priceToPips(ctx.instrument, close - range.low), maxSlPips);
        return {
          target: 1,
          stopLossPips: slPips,
          takeProfitPips: slPips * tpR,
          reason: `break>${range.high.toFixed(3)} (range ${rangePips.toFixed(1)}p)`,
        };
      }
      if (close < range.low && prevClose >= range.low) {
        const slPips = Math.min(priceToPips(ctx.instrument, range.high - close), maxSlPips);
        return {
          target: -1,
          stopLossPips: slPips,
          takeProfitPips: slPips * tpR,
          reason: `break<${range.low.toFixed(3)} (range ${rangePips.toFixed(1)}p)`,
        };
      }
      return { target: 0 };
    },
  };
}
