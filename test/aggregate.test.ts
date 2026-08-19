import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { aggregateCandles, aggregateClosed } from "../src/core/aggregate.ts";
import type { BidAskCandle } from "../src/core/candle.ts";

const M1 = 60_000;

/** テスト用M1足。bid=価格, ask=価格+スプレッド0.02 で機械的に生成 */
function m1(timeMin: number, o: number, h: number, l: number, c: number, volume = 1): BidAskCandle {
  const spread = 0.02;
  return {
    time: timeMin * M1,
    bid: { o, h, l, c },
    ask: { o: o + spread, h: h + spread, l: l + spread, c: c + spread },
    volume,
  };
}

describe("aggregateCandles", () => {
  it("M1→M5: OHLCの合成・出来高合算・バケット開始時刻", () => {
    const candles = [
      m1(0, 100, 101, 99, 100.5, 2),
      m1(1, 100.5, 102, 100, 101, 3),
      m1(2, 101, 101.5, 98, 99, 1),
      m1(3, 99, 100, 98.5, 99.5, 4),
      m1(4, 99.5, 103, 99, 102, 5),
      m1(5, 102, 104, 101, 103, 2), // 次のバケット
    ];
    const m5 = aggregateCandles(candles, "M5");
    assert.equal(m5.length, 2);
    const first = m5[0]!;
    assert.equal(first.time, 0);
    assert.equal(first.bid.o, 100);
    assert.equal(first.bid.h, 103);
    assert.equal(first.bid.l, 98);
    assert.equal(first.bid.c, 102);
    assert.ok(Math.abs(first.ask.h - 103.02) < 1e-9);
    assert.equal(first.volume, 15);
    assert.equal(m5[1]!.time, 5 * M1);
  });

  it("週末ギャップ: 存在するM1からのみバケットを作る", () => {
    const candles = [
      m1(0, 100, 100, 100, 100),
      m1(1, 100, 100, 100, 100),
      // 大きなギャップ (週末相当)
      m1(3000, 105, 105, 105, 105),
    ];
    const m5 = aggregateCandles(candles, "M5");
    assert.equal(m5.length, 2);
    assert.equal(m5[0]!.time, 0);
    assert.equal(m5[1]!.time, 3000 * M1);
  });

  it("バケット途中からのデータ開始 (部分バケット) も1本として扱う", () => {
    const candles = [m1(3, 100, 101, 99, 100), m1(4, 100, 102, 100, 101)];
    const m5 = aggregateCandles(candles, "M5");
    assert.equal(m5.length, 1);
    assert.equal(m5[0]!.time, 0); // バケット境界に整列
    assert.equal(m5[0]!.bid.h, 102);
  });

  it("時刻が昇順でなければ例外", () => {
    assert.throws(() => aggregateCandles([m1(5, 1, 1, 1, 1), m1(4, 1, 1, 1, 1)], "M5"));
  });

  it("M1指定はそのまま返す", () => {
    const candles = [m1(0, 1, 1, 1, 1)];
    assert.equal(aggregateCandles(candles, "M1"), candles);
  });
});

describe("aggregateClosed", () => {
  it("最終バケットが未確定なら落とす", () => {
    const candles = [
      m1(0, 1, 1, 1, 1),
      m1(1, 1, 1, 1, 1),
      m1(2, 1, 1, 1, 1),
      m1(3, 1, 1, 1, 1),
      m1(4, 1, 1, 1, 1), // 1本目のM5確定
      m1(5, 1, 1, 1, 1), // 2本目のM5は未確定 (5〜9分のうち5分のみ)
    ];
    const closed = aggregateClosed(candles, "M5");
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.time, 0);
  });

  it("最終バケットの末尾M1まで揃っていれば確定として返す", () => {
    const candles = Array.from({ length: 10 }, (_, i) => m1(i, 1, 1, 1, 1));
    const closed = aggregateClosed(candles, "M5");
    assert.equal(closed.length, 2);
  });

  it("欠損バーでバケット末尾M1が無い場合は未確定として落とす (保守的)", () => {
    // 5〜9分のバケットで9分の足が欠損 → 未確定扱い
    const candles = [
      ...Array.from({ length: 5 }, (_, i) => m1(i, 1, 1, 1, 1)),
      m1(5, 1, 1, 1, 1),
      m1(6, 1, 1, 1, 1),
      m1(7, 1, 1, 1, 1),
      m1(8, 1, 1, 1, 1),
    ];
    const closed = aggregateClosed(candles, "M5");
    assert.equal(closed.length, 1);
  });
});
