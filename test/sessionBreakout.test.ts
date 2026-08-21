import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BidAskCandle } from "../src/core/candle.ts";
import type { StrategyContext } from "../src/core/strategy.ts";
import { makeSessionBreakout } from "../src/strategies/sessionBreakout.ts";

/**
 * sessionBreakout v2 (R3-A) の検証:
 * ATRバッファによるノイズ抜け排除 / ロンドン初動限定 / NY正午の強制フラット。
 */

const M15 = 900_000;

// 2026-07-15(水) 00:00Z開始 = JST 9:00 (東京セッション開始)。夏時間。
const TOKYO_OPEN = Date.parse("2026-07-15T00:00:00Z");

/** 東京レンジ (150.0-150.5) を作り、その後ロンドン時間の足を追加する */
function buildDay(afterTokyo: { time: number; close: number }[]): BidAskCandle[] {
  const candles: BidAskCandle[] = [];
  // 東京 9:00-15:00 JST = 0:00-6:00Z の24本: レンジ 150.0〜150.5
  for (let i = 0; i < 24; i++) {
    const c = 150.2 + (i % 2 === 0 ? 0.1 : -0.1);
    candles.push({
      time: TOKYO_OPEN + i * M15,
      bid: { o: c, h: Math.min(150.5, c + 0.25), l: Math.max(150.0, c - 0.15), c },
      ask: { o: c + 0.004, h: Math.min(150.5, c + 0.25) + 0.004, l: Math.max(150.0, c - 0.15) + 0.004, c: c + 0.004 },
      volume: 10,
    });
  }
  // 6:00Z以降 (欧州前〜ロンドン) の足: closeを指定どおりに
  for (const spec of afterTokyo) {
    candles.push({
      time: spec.time,
      bid: { o: spec.close, h: spec.close + 0.05, l: spec.close - 0.05, c: spec.close },
      ask: {
        o: spec.close + 0.004,
        h: spec.close + 0.054,
        l: spec.close - 0.046,
        c: spec.close + 0.004,
      },
      volume: 10,
    });
  }
  return candles;
}

/** TOKYO_OPENからロンドン序盤 (夏時間 7:00Z=8:00 BST) までを埋めて最後の足だけ指定closeにする */
function dayWithLondonClose(lastClose: number, lastTimeZ: string): BidAskCandle[] {
  const lastTime = Date.parse(lastTimeZ);
  const fills: { time: number; close: number }[] = [];
  for (let t = TOKYO_OPEN + 24 * M15; t < lastTime; t += M15) {
    fills.push({ time: t, close: 150.3 }); // レンジ内で待機
  }
  fills.push({ time: lastTime, close: lastClose });
  return buildDay(fills);
}

function ctx(candles: BidAskCandle[], position: -1 | 0 | 1): StrategyContext {
  return { instrument: "USD_JPY", candles, index: candles.length - 1, htf: {}, htfIndex: {}, position };
}

const V2 = {
  timeframe: "M15" as const,
  minRangePips: 20,
  maxRangePips: 80,
  maxSlPips: 40,
  tpR: 1.5,
  atrBufferMult: 0.3,
  entryEndLondonMin: 12 * 60,
  exitNyMin: 12 * 60,
};

describe("sessionBreakout v2", () => {
  it("v1 (バッファなし): レンジ上抜けクロスでロング", () => {
    const v1 = makeSessionBreakout({ ...V2, atrBufferMult: 0 });
    // 8:00 BST = 7:00Z にレンジ高値150.5を僅かに上抜け
    const d = v1.decide(ctx(dayWithLondonClose(150.55, "2026-07-15T07:00:00Z"), 0));
    assert.equal(d.target, 1);
    assert.ok((d.stopLossPips ?? 0) > 0);
    assert.ok((d.takeProfitPips ?? 0) > 0);
  });

  it("R3-A: ATRバッファ内の弱い上抜けはエントリーしない (ノイズ排除)", () => {
    const v2 = makeSessionBreakout(V2);
    // ATR≈0.14前後 → バッファ≈0.04超。150.52はバッファ内
    const d = v2.decide(ctx(dayWithLondonClose(150.52, "2026-07-15T07:00:00Z"), 0));
    assert.equal(d.target, 0);
  });

  it("R3-A: バッファを明確に超えるブレイクはエントリーする", () => {
    const v2 = makeSessionBreakout(V2);
    const d = v2.decide(ctx(dayWithLondonClose(150.75, "2026-07-15T07:00:00Z"), 0));
    assert.equal(d.target, 1);
  });

  it("R3-A: ロンドン12:00現地以降はエントリーしない (初動限定)", () => {
    const v2 = makeSessionBreakout(V2);
    // 12:30 BST = 11:30Z の強いブレイクでも見送り
    const d = v2.decide(ctx(dayWithLondonClose(150.75, "2026-07-15T11:30:00Z"), 0));
    assert.equal(d.target, 0);
  });

  it("R3-A: NY12:00現地以降はポジションを強制フラット", () => {
    const v2 = makeSessionBreakout(V2);
    // 16:15Z = NY 12:15 EDT (ロンドン17:15 BSTでまだLondonセッション中でも決済)
    const candles = dayWithLondonClose(150.75, "2026-07-15T16:15:00Z");
    const d = v2.decide(ctx(candles, 1));
    assert.equal(d.target, 0);
    assert.equal(d.reason, "time-exit-ny");
  });

  it("NY正午前はポジション維持", () => {
    const v2 = makeSessionBreakout(V2);
    // 14:00Z = NY 10:00 EDT
    const candles = dayWithLondonClose(150.75, "2026-07-15T14:00:00Z");
    const d = v2.decide(ctx(candles, 1));
    assert.equal(d.target, 1);
  });
});

/** 指定レンジの東京セッション24本 (0:00-6:00Z = 9:00-15:00 JST) を生成 */
function tokyoBars(openZ: string, high: number, low: number): BidAskCandle[] {
  const open = Date.parse(openZ);
  const mid = (high + low) / 2;
  const amp = (high - low) / 2;
  const out: BidAskCandle[] = [];
  for (let i = 0; i < 24; i++) {
    const c = mid + (i % 2 === 0 ? amp / 2 : -amp / 2);
    out.push({
      time: open + i * M15,
      bid: { o: c, h: Math.min(high, c + amp), l: Math.max(low, c - amp), c },
      ask: { o: c + 0.004, h: Math.min(high, c + amp) + 0.004, l: Math.max(low, c - amp) + 0.004, c: c + 0.004 },
      volume: 10,
    });
  }
  return out;
}

describe("sessionBreakout v3 (R5事前登録フィルタ)", () => {
  // 過去2日 + 当日 (レンジ150.0-150.5 = 50pips) + ロンドン序盤の上ブレイク
  function threeDays(day1Range: [number, number], day2Range: [number, number]): BidAskCandle[] {
    const candles = [
      ...tokyoBars("2026-07-13T00:00:00Z", day1Range[0], day1Range[1]),
      ...tokyoBars("2026-07-14T00:00:00Z", day2Range[0], day2Range[1]),
      ...dayWithLondonClose(150.75, "2026-07-15T07:00:00Z"),
    ];
    return candles;
  }
  const R5A = { ...V2, atrBufferMult: 0, rangePercentileMin: 50, rangePercentileLookback: 2 };

  it("R5-A: 当日レンジが過去比で広ければエントリーする", () => {
    // 過去レンジ {30p, 70p} → p50閾値=30p、当日50p ≥ 30p
    const s = makeSessionBreakout(R5A);
    const d = s.decide(ctx(threeDays([150.4, 150.1], [150.6, 149.9]), 0));
    assert.equal(d.target, 1);
  });

  it("R5-A: 当日レンジが過去比で狭ければ見送る", () => {
    // 過去レンジ {60p, 70p} → p50閾値=60p、当日50p < 60p
    const s = makeSessionBreakout(R5A);
    const d = s.decide(ctx(threeDays([150.7, 150.1], [150.6, 149.9]), 0));
    assert.equal(d.target, 0);
  });

  it("R5-A: 参照日数が揃うまでは見送る", () => {
    // 過去1日ぶんしかない (lookback=2に不足)
    const s = makeSessionBreakout(R5A);
    const candles = [
      ...tokyoBars("2026-07-14T00:00:00Z", 150.4, 150.1),
      ...dayWithLondonClose(150.75, "2026-07-15T07:00:00Z"),
    ];
    assert.equal(s.decide(ctx(candles, 0)).target, 0);
  });

  it("R5-B: EMAより下への上ブレイクはエントリーしない (逆行ロング禁止)", () => {
    // ロンドン前を151.5で埋めてEMAを151付近に置き、150.75への上ブレイクを逆行にする
    const fills: { time: number; close: number }[] = [];
    for (let t = TOKYO_OPEN + 24 * M15; t < Date.parse("2026-07-15T07:00:00Z") - M15; t += M15) {
      fills.push({ time: t, close: 151.5 });
    }
    fills.push({ time: Date.parse("2026-07-15T07:00:00Z") - M15, close: 150.3 }); // 前足はレンジ内
    fills.push({ time: Date.parse("2026-07-15T07:00:00Z"), close: 150.75 });
    const candles = buildDay(fills);
    const withEma = makeSessionBreakout({ ...V2, atrBufferMult: 0, trendEmaPeriod: 8 });
    const without = makeSessionBreakout({ ...V2, atrBufferMult: 0 });
    assert.equal(without.decide(ctx(candles, 0)).target, 1); // フィルタなしなら入る
    assert.equal(withEma.decide(ctx(candles, 0)).target, 0); // EMA(8)≈151.2 > 150.75
  });

  it("R5-B: EMA方向と一致する上ブレイクはエントリーする", () => {
    const s = makeSessionBreakout({ ...V2, atrBufferMult: 0, trendEmaPeriod: 8 });
    // 通常の上昇ブレイク: EMA(8)はレンジ内の値 < 150.75
    const d = s.decide(ctx(dayWithLondonClose(150.75, "2026-07-15T07:00:00Z"), 0));
    assert.equal(d.target, 1);
  });

  it("R5-B: EMA未収束ならエントリーしない", () => {
    const s = makeSessionBreakout({ ...V2, atrBufferMult: 0, trendEmaPeriod: 5000 });
    const d = s.decide(ctx(dayWithLondonClose(150.75, "2026-07-15T07:00:00Z"), 0));
    assert.equal(d.target, 0);
  });
});

describe("sessionBreakout v4 (R6事前登録)", () => {
  /**
   * 東京前半 (0:00-4:00Z) は広いレンジ150.0-150.5、ロンドン直前窓
   * (5:00-8:00現地 = 夏時間4:00-7:00Z) は狭い箱150.2-150.3、
   * ロンドン寄付き (7:00Z) に150.38へ上抜けする日
   */
  function boxDay(): BidAskCandle[] {
    const bars = (openZ: string, count: number, high: number, low: number): BidAskCandle[] => {
      const open = Date.parse(openZ);
      const m = (high + low) / 2;
      const amp = (high - low) / 2;
      const out: BidAskCandle[] = [];
      for (let i = 0; i < count; i++) {
        const c = m + (i % 2 === 0 ? amp / 2 : -amp / 2);
        out.push({
          time: open + i * M15,
          bid: { o: c, h: Math.min(high, c + amp), l: Math.max(low, c - amp), c },
          ask: { o: c + 0.004, h: Math.min(high, c + amp) + 0.004, l: Math.max(low, c - amp) + 0.004, c: c + 0.004 },
          volume: 10,
        });
      }
      return out;
    };
    return [
      ...bars("2026-07-15T00:00:00Z", 16, 150.5, 150.0), // 東京前半: 広い
      ...bars("2026-07-15T04:00:00Z", 12, 150.3, 150.2), // ロンドン直前3時間: 狭い箱
      ...bars("2026-07-15T07:00:00Z", 1, 150.4, 150.35), // 寄付きで箱上抜け (close≈150.375)
    ];
  }
  const R6A = {
    ...V2,
    atrBufferMult: 0,
    minRangePips: 10,
    maxRangePips: 60,
    rangeStartLondonMin: 5 * 60,
    rangeEndLondonMin: 8 * 60,
  };

  it("R6-A: 箱をロンドン直前窓で取ると、東京レンジ内でも箱の上抜けでロングする", () => {
    const box = makeSessionBreakout(R6A);
    const tokyo = makeSessionBreakout({ ...V2, atrBufferMult: 0 });
    const candles = boxDay();
    assert.equal(box.decide(ctx(candles, 0)).target, 1); // 箱高値150.3を上抜け
    assert.equal(tokyo.decide(ctx(candles, 0)).target, 0); // 東京レンジ150.5の内側
  });

  it("R6-B: tpR省略時はTPなし (SLのみ) の注文になる", () => {
    const { tpR: _tpR, ...noTp } = V2;
    const s = makeSessionBreakout({ ...noTp, atrBufferMult: 0 });
    const d = s.decide(ctx(dayWithLondonClose(150.75, "2026-07-15T07:00:00Z"), 0));
    assert.equal(d.target, 1);
    assert.ok((d.stopLossPips ?? 0) > 0);
    assert.equal(d.takeProfitPips, undefined);
  });

  it("R6-B: exitNy=16:00はNY午後もポジションを保持し、16:00以降に決済する", () => {
    const s = makeSessionBreakout({ ...V2, exitNyMin: 16 * 60 });
    // 19:00Z = NY 15:00 EDT → 保持
    const hold = s.decide(ctx(dayWithLondonClose(150.75, "2026-07-15T19:00:00Z"), 1));
    assert.equal(hold.target, 1);
    // 20:15Z = NY 16:15 EDT → 強制フラット
    const exit = s.decide(ctx(dayWithLondonClose(150.75, "2026-07-15T20:15:00Z"), 1));
    assert.equal(exit.target, 0);
    assert.equal(exit.reason, "time-exit-ny");
  });
});
