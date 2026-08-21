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
