import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BidAskCandle } from "../src/core/candle.ts";
import type { StrategyContext } from "../src/core/strategy.ts";
import { makeDonchian } from "../src/strategies/donchian.ts";

/**
 * Donchianのエントリーフィルタ (R2-B: EMA方向 / R2-C: ADX閾値) の検証。
 * フィルタは新規エントリーのみをブロックし、決済は常に有効であること。
 */

const M15 = 900_000;

/** 単調系列からテスト用ローソク足を作る (spread 0.4pips) */
function candlesFrom(closes: number[]): BidAskCandle[] {
  return closes.map((c, i) => ({
    time: i * M15,
    bid: { o: c - 0.01, h: c + 0.05, l: c - 0.05, c },
    ask: { o: c - 0.006, h: c + 0.054, l: c - 0.046, c: c + 0.004 },
    volume: 10,
  }));
}

function ctx(candles: BidAskCandle[], position: -1 | 0 | 1): StrategyContext {
  return { instrument: "USD_JPY", candles, index: candles.length - 1, htf: {}, htfIndex: {}, position };
}

// 下降トレンドの後に直近チャネルを上抜ける形: 上抜けブレイクだが長期EMAは下向き
function downtrendThenBreak(): BidAskCandle[] {
  const closes: number[] = [];
  let p = 160;
  for (let i = 0; i < 60; i++) {
    p -= 0.1; // 長期下降 (EMA50はcloseより上に残る)
    closes.push(p);
  }
  for (let i = 0; i < 6; i++) {
    p += 0.12; // 直近だけ反発して10期間チャネルを上抜け
    closes.push(p);
  }
  return candlesFrom(closes);
}

describe("makeDonchian エントリーフィルタ", () => {
  it("フィルタなし: 直近チャネル上抜けでロングする (前提確認)", () => {
    const plain = makeDonchian({
      timeframe: "M15",
      entryPeriod: 10,
      exitPeriod: 5,
      atrPeriod: 14,
      slAtrMult: 2,
    });
    const d = plain.decide(ctx(downtrendThenBreak(), 0));
    assert.equal(d.target, 1);
  });

  it("R2-B: EMA方向フィルタは逆行方向のエントリーをブロックする", () => {
    const filtered = makeDonchian({
      timeframe: "M15",
      entryPeriod: 10,
      exitPeriod: 5,
      atrPeriod: 14,
      slAtrMult: 2,
      trendEmaPeriod: 50, // 長期下降中なので close < EMA50 → ロング禁止
    });
    const d = filtered.decide(ctx(downtrendThenBreak(), 0));
    assert.equal(d.target, 0);
  });

  it("R2-B: EMA順方向のエントリーは通る", () => {
    // 一貫した上昇トレンド → close > EMA50 かつ上抜け
    const closes = Array.from({ length: 70 }, (_, i) => 150 + i * 0.1);
    const filtered = makeDonchian({
      timeframe: "M15",
      entryPeriod: 10,
      exitPeriod: 5,
      atrPeriod: 14,
      slAtrMult: 2,
      trendEmaPeriod: 50,
    });
    const d = filtered.decide(ctx(candlesFrom(closes), 0));
    assert.equal(d.target, 1);
  });

  it("R2-C: ADXが閾値未満ならエントリーしない", () => {
    // ほぼ横ばい (ADX低) の最後に1本だけ上抜け
    const closes = Array.from({ length: 60 }, (_, i) => 150 + (i % 2 === 0 ? 0.02 : -0.02));
    closes.push(150.5);
    const filtered = makeDonchian({
      timeframe: "M15",
      entryPeriod: 10,
      exitPeriod: 5,
      atrPeriod: 14,
      slAtrMult: 2,
      adxPeriod: 14,
      adxMin: 20,
    });
    const d = filtered.decide(ctx(candlesFrom(closes), 0));
    assert.equal(d.target, 0);
  });

  it("フィルタは決済をブロックしない: ロング中の逆側ブレイクはドテンせず手仕舞いになる", () => {
    const filtered = makeDonchian({
      timeframe: "M15",
      entryPeriod: 10,
      exitPeriod: 5,
      atrPeriod: 14,
      slAtrMult: 2,
      trendEmaPeriod: 50,
    });
    // 上昇の後に急落して10期間チャネルを下抜け: close > EMA が僅かに残る形は作りにくいので
    // 「ショートがEMAフィルタで禁止される局面 (close > EMA)」を直接確認する:
    // 長期上昇 → 直近だけ急落で下抜け (EMA50はまだ下、close > EMA50)
    const closes: number[] = [];
    let p = 150;
    for (let i = 0; i < 60; i++) {
      p += 0.1;
      closes.push(p);
    }
    for (let i = 0; i < 4; i++) {
      p -= 0.18; // 直近チャネル(10)を下抜けるがEMA50より上
      closes.push(p);
    }
    const d = filtered.decide(ctx(candlesFrom(closes), 1));
    // ドテン(-1)は禁止されるが、手仕舞い(0)は必ず実行される
    assert.equal(d.target, 0);
    assert.equal(d.reason, "exit-opposite-break");
  });

  it("adxPeriodだけ指定してadxMinを省略するとエラー", () => {
    assert.throws(() =>
      makeDonchian({
        timeframe: "M15",
        entryPeriod: 10,
        exitPeriod: 5,
        atrPeriod: 14,
        slAtrMult: 2,
        adxPeriod: 14,
      }),
    );
  });
});
