import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { OHLC } from "../src/core/candle.ts";
import {
  adxSeries,
  atrSeries,
  bollingerSeries,
  donchianSeries,
  emaSeries,
  rsiSeries,
  smaSeries,
} from "../src/core/indicators.ts";

/**
 * 手計算のゴールデン値による検証。
 * 移植・改修時のサイレント破損 (指標がわずかに違う値を返す) が
 * このプロジェクト最大の品質リスクのため、既知の値で恒久固定する。
 */

function assertCloseArray(actual: number[], expected: number[], eps = 1e-9): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!;
    const a = actual[i]!;
    if (Number.isNaN(e)) {
      assert.ok(Number.isNaN(a), `index ${i}: NaNを期待したが ${a}`);
    } else {
      assert.ok(Math.abs(a - e) < eps, `index ${i}: ${a} !== ${e}`);
    }
  }
}

function ohlcFromCloses(closes: number[]): OHLC[] {
  return closes.map((c) => ({ o: c, h: c, l: c, c }));
}

describe("smaSeries", () => {
  it("手計算と一致する", () => {
    assertCloseArray(smaSeries([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
  });
});

describe("emaSeries", () => {
  it("SMA初期化 + 逐次計算 (n=3, k=0.5)", () => {
    // 初期EMA = SMA(1,2,3) = 2; 次: 4*0.5 + 2*0.5 = 3; 次: 5*0.5 + 3*0.5 = 4
    assertCloseArray(emaSeries([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
  });

  it("変動データでの逐次計算", () => {
    // n=2, k=2/3。初期EMA = SMA(10,20) = 15
    // i=2: 10*(2/3) + 15*(1/3) = 35/3
    // i=3: 30*(2/3) + (35/3)*(1/3) = 20 + 35/9 = 215/9
    assertCloseArray(emaSeries([10, 20, 10, 30], 2), [NaN, 15, 35 / 3, 215 / 9]);
  });
});

describe("rsiSeries", () => {
  it("全上昇なら100、全下落なら0", () => {
    const up = rsiSeries([1, 2, 3, 4, 5, 6], 3);
    assert.equal(up[5], 100);
    const down = rsiSeries([6, 5, 4, 3, 2, 1], 3);
    assert.equal(down[5], 0);
  });

  it("手計算と一致する (n=3)", () => {
    // 値: 10, 11, 10, 12 → diff: +1, -1, +2
    // avgGain = (1+0+2)/3 = 1, avgLoss = (0+1+0)/3 = 1/3
    // RSI = 100 * 1 / (1 + 1/3) = 75
    const rsi = rsiSeries([10, 11, 10, 12], 3);
    assert.ok(Math.abs(rsi[3]! - 75) < 1e-9);
    assert.ok(Number.isNaN(rsi[2]!));
  });
});

describe("bollingerSeries", () => {
  it("手計算と一致する (n=3, sigma=2)", () => {
    // 値 [2,4,6]: mean=4, 母標準偏差 = sqrt(((2-4)^2+(0)^2+(2)^2)/3) = sqrt(8/3)
    const { upper, middle, lower } = bollingerSeries([2, 4, 6], 3, 2);
    const std = Math.sqrt(8 / 3);
    assert.ok(Math.abs(middle[2]! - 4) < 1e-9);
    assert.ok(Math.abs(upper[2]! - (4 + 2 * std)) < 1e-9);
    assert.ok(Math.abs(lower[2]! - (4 - 2 * std)) < 1e-9);
  });
});

describe("atrSeries", () => {
  it("TRの単純平均で初期化される (n=2)", () => {
    const ohlc: OHLC[] = [
      { o: 10, h: 11, l: 9, c: 10 },
      { o: 10, h: 12, l: 10, c: 11 }, // TR = max(2, |12-10|, |10-10|) = 2
      { o: 11, h: 11, l: 10, c: 10.5 }, // TR = max(1, 0, 1) = 1
      { o: 10.5, h: 13, l: 10.5, c: 12 }, // TR = max(2.5, 2.5, 0) = 2.5
    ];
    const atr = atrSeries(ohlc, 2);
    assert.ok(Number.isNaN(atr[1]!));
    assert.ok(Math.abs(atr[2]! - 1.5) < 1e-9); // (2+1)/2
    assert.ok(Math.abs(atr[3]! - (1.5 * 1 + 2.5) / 2) < 1e-9); // Wilder: (1.5*(n-1)+2.5)/n
  });
});

describe("donchianSeries", () => {
  it("直近n本の最高値・最安値 (現在の足を含む)", () => {
    const ohlc: OHLC[] = [
      { o: 0, h: 10, l: 5, c: 7 },
      { o: 0, h: 12, l: 6, c: 8 },
      { o: 0, h: 9, l: 4, c: 6 },
      { o: 0, h: 11, l: 7, c: 9 },
    ];
    const { upper, lower } = donchianSeries(ohlc, 3);
    assert.ok(Number.isNaN(upper[1]!));
    assert.equal(upper[2], 12); // max(10,12,9)
    assert.equal(lower[2], 4); // min(5,6,4)
    assert.equal(upper[3], 12); // max(12,9,11)
    assert.equal(lower[3], 4); // min(6,4,7)
  });
});

describe("adxSeries", () => {
  it("一方向トレンドでADXが高くなり、値域は0-100", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const ohlc: OHLC[] = closes.map((c) => ({ o: c - 0.5, h: c + 1, l: c - 1, c }));
    const adx = adxSeries(ohlc, 14);
    const last = adx[adx.length - 1]!;
    assert.ok(!Number.isNaN(last));
    assert.ok(last > 50, `一方向トレンドでADXが低すぎる: ${last}`);
    assert.ok(last <= 100);
  });

  it("データ不足ならすべてNaN", () => {
    const adx = adxSeries(ohlcFromCloses([1, 2, 3]), 14);
    assert.ok(adx.every((v) => Number.isNaN(v)));
  });
});
