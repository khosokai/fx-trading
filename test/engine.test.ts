import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BidAskCandle } from "../src/core/candle.ts";
import type { Decision, Strategy } from "../src/core/strategy.ts";
import { runBacktest, type BacktestConfig } from "../src/backtest/engine.ts";

/**
 * エンジンの保守的ルール (§4) をシナリオで恒久固定する。
 * これらのテストを変えるときは docs/architecture.md のルールも必ず更新すること。
 */

const M5 = 300_000;
const SPREAD = 0.004; // 0.4 pips (USD/JPY)
// 平日の通常時間帯: 2026-07-15(水) 10:00Z = NY 6:00 EDT
const BASE = Date.parse("2026-07-15T10:00:00Z");

function bar(i: number, o: number, h: number, l: number, c: number, base = BASE): BidAskCandle {
  return {
    time: base + i * M5,
    bid: { o, h, l, c },
    ask: { o: o + SPREAD, h: h + SPREAD, l: l + SPREAD, c: c + SPREAD },
    volume: 10,
  };
}

/** インデックス→判定 のスクリプト戦略。指定なしは現状維持 */
function scripted(decisions: Record<number, Decision>): Strategy {
  return {
    id: "scripted",
    name: "scripted",
    timeframe: "M5",
    warmup: 0,
    decide(ctx) {
      return decisions[ctx.index] ?? { target: ctx.position };
    },
  };
}

const CONFIG: BacktestConfig = {
  initialEquityJpy: 1_000_000,
  riskPct: 1,
  maxUnits: 100_000,
  leverage: 25,
  extraSlippagePips: 0,
  slSlippagePips: 0.3,
  spreadMarkupPips: 0,
  flattenBeforeWeekend: true,
};

describe("engine: 約定価格の基本", () => {
  it("ロングはAskでエントリー、Bidでエグジットする (シグナル決済)", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.05, 150.08, 150.03, 150.06),
      bar(3, 150.1, 150.12, 150.08, 150.11),
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 100 }, 2: { target: 0 } }),
      "USD_JPY",
      CONFIG,
    );
    assert.equal(result.trades.length, 1);
    const t = result.trades[0]!;
    assert.equal(t.direction, 1);
    assert.ok(Math.abs(t.entryPrice - 150.024) < 1e-9, `entry=${t.entryPrice}`); // ask.o = 150.02+0.004
    assert.ok(Math.abs(t.exitPrice - 150.1) < 1e-9); // bid.o of bar3
    assert.equal(t.closeReason, "signal");
    assert.ok(Math.abs(t.plPips - 7.6) < 1e-9);
    // サイジング: 1% × 100万 = 1万円リスク / (100pips × 0.01円) = 10,000units
    assert.equal(t.units, 10_000);
    assert.ok(Math.abs(t.plJpy - 760) < 1e-6);
    assert.ok(Math.abs(result.finalEquity - 1_000_760) < 1e-6);
  });

  it("ショートはBidでエントリー、Askでエグジットする", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.0, 150.02, 149.9, 149.95),
      bar(2, 149.9, 149.95, 149.85, 149.9),
      bar(3, 149.8, 149.85, 149.75, 149.8),
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: -1, stopLossPips: 100 }, 2: { target: 0 } }),
      "USD_JPY",
      CONFIG,
    );
    const t = result.trades[0]!;
    assert.equal(t.direction, -1);
    assert.ok(Math.abs(t.entryPrice - 150.0) < 1e-9); // bid.o of bar1
    assert.ok(Math.abs(t.exitPrice - 149.804) < 1e-9); // ask.o of bar3 = 149.8+0.004
    assert.ok(Math.abs(t.plPips - 19.6) < 1e-9); // (150.0-149.804)/0.01
  });
});

describe("engine: バー内SL/TPの保守的ルール", () => {
  const entryDecision: Decision = { target: 1, stopLossPips: 20, takeProfitPips: 20 };
  // entry at bar1 ask.o = 150.024 → SL 149.824, TP 150.224

  it("③ 同一バーでSL/TP両方タッチ → SL約定 (不利スリッページ付き)", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.0, 150.3, 149.8, 150.0), // bid: l=149.80 ≤ SL, h=150.30 ≥ TP
      bar(3, 150.0, 150.01, 149.99, 150.0),
    ];
    const result = runBacktest(candles, scripted({ 0: entryDecision }), "USD_JPY", CONFIG);
    const t = result.trades[0]!;
    assert.equal(t.closeReason, "sl");
    // SL 149.824 - スリッページ0.3pips = 149.821
    assert.ok(Math.abs(t.exitPrice - 149.821) < 1e-9, `exit=${t.exitPrice}`);
    assert.ok(Math.abs(t.plPips - -20.3) < 1e-9);
  });

  it("② 窓開けで始値がSLを超えていたら始値で約定 (スリッページ付き)", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 149.5, 149.6, 149.4, 149.5), // bid.o = 149.50 < SL 149.824
      bar(3, 149.5, 149.51, 149.49, 149.5),
    ];
    const result = runBacktest(candles, scripted({ 0: entryDecision }), "USD_JPY", CONFIG);
    const t = result.trades[0]!;
    assert.equal(t.closeReason, "sl");
    assert.ok(Math.abs(t.exitPrice - 149.497) < 1e-9); // 149.50 - 0.003
  });

  it("④ TPのみタッチなら指値どおり約定 (有利スリッページなし)", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.1, 150.3, 150.05, 150.2), // bid.h = 150.30 ≥ TP 150.224, l > SL
      bar(3, 150.2, 150.21, 150.19, 150.2),
    ];
    const result = runBacktest(candles, scripted({ 0: entryDecision }), "USD_JPY", CONFIG);
    const t = result.trades[0]!;
    assert.equal(t.closeReason, "tp");
    assert.ok(Math.abs(t.exitPrice - 150.224) < 1e-9);
    assert.ok(Math.abs(t.plPips - 20) < 1e-9);
  });

  it("ショートのSLはAsk側で判定される", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.0, 150.02, 149.98, 150.0), // short entry at bid.o = 150.0, SL 150.2 (ask)
      bar(2, 150.1, 150.21, 150.05, 150.15), // ask.h = 150.214 ≥ 150.2 → SL
      bar(3, 150.1, 150.11, 150.09, 150.1),
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: -1, stopLossPips: 20 } }),
      "USD_JPY",
      CONFIG,
    );
    const t = result.trades[0]!;
    assert.equal(t.closeReason, "sl");
    assert.ok(Math.abs(t.exitPrice - 150.203) < 1e-9); // 150.2 + 0.3pips
  });
});

describe("engine: ドテン (反転)", () => {
  it("ロング→ショートは同一バーの始値でクローズ+新規", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.05, 150.08, 150.03, 150.06),
      bar(3, 150.0, 150.02, 149.9, 149.95),
    ];
    const result = runBacktest(
      candles,
      scripted({
        0: { target: 1, stopLossPips: 100 },
        2: { target: -1, stopLossPips: 100 },
      }),
      "USD_JPY",
      CONFIG,
    );
    assert.equal(result.trades.length, 2);
    assert.equal(result.trades[0]!.closeReason, "signal");
    assert.equal(result.trades[0]!.exitTime, candles[3]!.time);
    const short = result.trades[1]!;
    assert.equal(short.direction, -1);
    assert.equal(short.entryTime, candles[3]!.time);
    assert.ok(Math.abs(short.entryPrice - 150.0) < 1e-9); // bar3 bid.o
    assert.equal(short.closeReason, "end"); // 最終足で強制決済
  });
});

describe("engine: サイジングとキャップ", () => {
  it("maxUnitsでキャップされる", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.05, 150.08, 150.03, 150.06),
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 20 } }),
      "USD_JPY",
      { ...CONFIG, maxUnits: 5_000 },
    );
    // リスクベースなら 1万円/(20pips×0.01) = 50,000units → maxUnits 5,000でキャップ
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0]!.units, 5_000);
  });

  it("riskFractionでリスク予算が縮む", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.05, 150.08, 150.03, 150.06),
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 20, riskFraction: 0.5 } }),
      "USD_JPY",
      CONFIG,
    );
    assert.equal(result.trades[0]!.units, 25_000); // 50,000 × 0.5
  });

  it("SLなしのエントリーはエンジンが拒否する (throw)", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.05, 150.08, 150.03, 150.06),
    ];
    assert.throws(() => runBacktest(candles, scripted({ 0: { target: 1 } }), "USD_JPY", CONFIG));
  });

  it("非JPYクォートペアはpipValueJpyAtがないとエラー", () => {
    const candles = [
      bar(0, 1.1, 1.101, 1.099, 1.1),
      bar(1, 1.1, 1.101, 1.099, 1.1),
    ];
    assert.throws(() => runBacktest(candles, scripted({}), "EUR_USD", CONFIG));
  });
});

describe("engine: 週末・セッション・スプレッド上乗せ", () => {
  it("週末クローズ前の最後の足で強制フラットする", () => {
    // 金曜 2026-07-17: 20:45Z, 20:50Z, 20:55Z (21:00Z = NY17:00で週末クローズ)
    const friday = Date.parse("2026-07-17T20:45:00Z");
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0, friday),
      bar(1, 150.0, 150.02, 149.98, 150.01, friday),
      bar(2, 150.01, 150.03, 149.99, 150.02, friday),
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 100 } }),
      "USD_JPY",
      CONFIG,
    );
    const t = result.trades[0]!;
    assert.equal(t.closeReason, "weekend");
    assert.equal(t.exitTime, candles[2]!.time);
    assert.ok(Math.abs(t.exitPrice - 150.02) < 1e-9); // bar2 bid.c
  });

  it("セッションフィルタ: セッション外の新規エントリーはスキップ", () => {
    // 10:00Z = JST 19:00 → 東京セッション(9:00-15:00 JST)外
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.05, 150.08, 150.03, 150.06),
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 100 } }),
      "USD_JPY",
      { ...CONFIG, sessionFilter: ["tokyo"] },
    );
    assert.equal(result.trades.length, 0);
  });

  it("spreadMarkupPipsで両側に半分ずつコストが乗る", () => {
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0),
      bar(1, 150.02, 150.05, 150.0, 150.04),
      bar(2, 150.05, 150.08, 150.03, 150.06),
      bar(3, 150.1, 150.12, 150.08, 150.11),
    ];
    const noMarkup = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 100 }, 2: { target: 0 } }),
      "USD_JPY",
      CONFIG,
    );
    const marked = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 100 }, 2: { target: 0 } }),
      "USD_JPY",
      { ...CONFIG, spreadMarkupPips: 0.5 },
    );
    // エントリー+0.25pips、エグジット-0.25pips → 往復0.5pips悪化
    assert.ok(Math.abs(noMarkup.trades[0]!.plPips - marked.trades[0]!.plPips - 0.5) < 1e-9);
    assert.ok(
      Math.abs(marked.trades[0]!.entrySpreadPips - (noMarkup.trades[0]!.entrySpreadPips + 0.5)) <
        1e-9,
    );
  });
});

describe("engine: スワップ近似", () => {
  it("水曜17:00 NYを跨いだ保有には3日分のスワップが乗る", () => {
    // 2026-07-15(水): 20:00Z開始、21:00Z (NY17:00) を跨ぐ
    const base = Date.parse("2026-07-15T20:00:00Z");
    const candles = [
      bar(0, 150.0, 150.01, 149.99, 150.0, base), // 20:00
      bar(1, 150.0, 150.02, 149.98, 150.0, base), // 20:05 エントリー
      ...Array.from({ length: 14 }, (_, k) => bar(2 + k, 150.0, 150.02, 149.98, 150.0, base)),
      // bar15 = 21:15Z までロールオーバー(21:00Z)を跨いで保有
    ];
    const result = runBacktest(
      candles,
      scripted({ 0: { target: 1, stopLossPips: 100 } }),
      "USD_JPY",
      { ...CONFIG, swapPipsPerDay: { long: -1, short: 0 } },
    );
    const t = result.trades[0]!;
    // units = 1万円/(100pips×0.01) = 10,000 → スワップ = 3日 × -1pip × 0.01円 × 10,000
    assert.equal(t.units, 10_000);
    assert.ok(Math.abs(t.swapJpy - -300) < 1e-6, `swap=${t.swapJpy}`);
  });
});
