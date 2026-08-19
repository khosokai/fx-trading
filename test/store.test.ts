import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { BidAskCandle } from "../src/core/candle.ts";
import { findGaps, mergeBidAsk, type DukascopyBar } from "../src/data/dukascopy.ts";
import { LocalChunkStore, decodeChunk, encodeChunk, monthRange } from "../src/data/store.ts";

const M1 = 60_000;

function candle(timeMs: number, price: number): BidAskCandle {
  return {
    time: timeMs,
    bid: { o: price, h: price + 0.1, l: price - 0.1, c: price },
    ask: { o: price + 0.02, h: price + 0.12, l: price - 0.08, c: price + 0.02 },
    volume: 10,
  };
}

describe("monthRange", () => {
  it("年をまたぐ月キーを列挙する", () => {
    assert.deepEqual(monthRange(Date.parse("2023-11-15"), Date.parse("2024-02-01")), [
      "2023-11",
      "2023-12",
      "2024-01",
      "2024-02",
    ]);
  });
});

describe("encodeChunk / decodeChunk", () => {
  it("ラウンドトリップで完全一致する", () => {
    const candles = [candle(0, 150), candle(M1, 150.5)];
    const decoded = decodeChunk(encodeChunk("USD_JPY", "1970-01", candles));
    assert.deepEqual(decoded, candles);
  });
});

describe("LocalChunkStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "fx-store-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("save→loadのラウンドトリップ (月境界を跨ぐ)", async () => {
    const store = new LocalChunkStore(dir);
    const jan31 = Date.parse("2024-01-31T23:58:00Z");
    const candles = [
      candle(jan31, 148),
      candle(jan31 + M1, 148.1),
      candle(jan31 + 2 * M1, 148.2), // 2024-02-01 00:00
      candle(jan31 + 3 * M1, 148.3),
    ];
    await store.save("USD_JPY", candles);
    assert.deepEqual(await store.listMonths("USD_JPY"), ["2024-01", "2024-02"]);

    const loaded = await store.load(
      "USD_JPY",
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-03-01T00:00:00Z"),
    );
    assert.deepEqual(loaded, candles);
  });

  it("範囲フィルタ [from, to) が効く", async () => {
    const store = new LocalChunkStore(dir);
    const from = new Date("2024-02-01T00:00:00Z");
    const to = new Date("2024-02-01T00:01:00Z");
    const loaded = await store.load("USD_JPY", from, to);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.time, from.getTime());
  });

  it("存在しないインストルメントは空配列", async () => {
    const store = new LocalChunkStore(dir);
    assert.deepEqual(await store.load("XXX_YYY", new Date(0), new Date(M1)), []);
    assert.deepEqual(await store.listMonths("XXX_YYY"), []);
  });
});

describe("mergeBidAsk", () => {
  const bar = (t: number, p: number): DukascopyBar => ({
    timestamp: t,
    open: p,
    high: p + 1,
    low: p - 1,
    close: p,
    volume: 5,
  });

  it("タイムスタンプ一致でマージし、片側欠損は捨てて数える", () => {
    const bids = [bar(0, 100), bar(M1, 101), bar(2 * M1, 102)];
    const asks = [bar(0, 100.02), bar(2 * M1, 102.02), bar(3 * M1, 103.02)];
    const { candles, droppedBidOnly, droppedAskOnly } = mergeBidAsk(bids, asks);
    assert.equal(candles.length, 2);
    assert.equal(droppedBidOnly, 1); // t=M1
    assert.equal(droppedAskOnly, 1); // t=3*M1
    assert.equal(candles[0]!.bid.o, 100);
    assert.equal(candles[0]!.ask.o, 100.02);
  });
});

describe("findGaps", () => {
  it("平日の欠損を検出する", () => {
    const base = Date.parse("2026-07-15T14:00:00Z"); // 水曜
    const candles: BidAskCandle[] = [
      candle(base, 150),
      candle(base + M1, 150),
      candle(base + 12 * M1, 150), // 10本欠損
    ];
    const gaps = findGaps(candles);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.missingBars, 10);
  });

  it("週末クローズ (金17:00 NY〜日17:00 NY) のギャップは正常として除外する", () => {
    const candles: BidAskCandle[] = [
      candle(Date.parse("2026-07-17T20:58:00Z"), 150),
      candle(Date.parse("2026-07-17T20:59:00Z"), 150),
      candle(Date.parse("2026-07-19T21:01:00Z"), 150), // 週末明け
      candle(Date.parse("2026-07-19T21:02:00Z"), 150),
    ];
    assert.equal(findGaps(candles).length, 0);
  });
});
