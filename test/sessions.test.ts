import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  inSession,
  isRolloverBlackout,
  isWeekendClosed,
  nextRollover,
  rolloverFinancingDays,
  tradingDay,
  tzOffsetMs,
} from "../src/core/sessions.ts";

/**
 * DST(夏時間)の境界を跨ぐフィクスチャで検証する。
 * - 冬時間(EST): NY 17:00 = 22:00 UTC (例: 2026-01-15 木曜)
 * - 夏時間(EDT): NY 17:00 = 21:00 UTC (例: 2026-07-15 水曜)
 * - 2026年のDST切替: 3/8 (spring forward), 11/1 (fall back)
 */

const T = (s: string) => Date.parse(s);

describe("tzOffsetMs", () => {
  it("NYの冬時間はUTC-5、夏時間はUTC-4", () => {
    assert.equal(tzOffsetMs(T("2026-01-15T12:00:00Z"), "America/New_York"), -5 * 3600_000);
    assert.equal(tzOffsetMs(T("2026-07-15T12:00:00Z"), "America/New_York"), -4 * 3600_000);
  });

  it("DST切替日(3/8, 11/1)の前後でオフセットが変わる", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT (07:00 UTC)
    assert.equal(tzOffsetMs(T("2026-03-08T06:30:00Z"), "America/New_York"), -5 * 3600_000);
    assert.equal(tzOffsetMs(T("2026-03-08T07:30:00Z"), "America/New_York"), -4 * 3600_000);
    // 2026-11-01 02:00 EDT → 01:00 EST (06:00 UTC)
    assert.equal(tzOffsetMs(T("2026-11-01T05:30:00Z"), "America/New_York"), -4 * 3600_000);
    assert.equal(tzOffsetMs(T("2026-11-01T06:30:00Z"), "America/New_York"), -5 * 3600_000);
  });
});

describe("tradingDay (NY 17:00区切り)", () => {
  it("冬時間: 22:00 UTC が取引日境界", () => {
    assert.equal(tradingDay(T("2026-01-15T21:59:00Z")), "2026-01-15");
    assert.equal(tradingDay(T("2026-01-15T22:01:00Z")), "2026-01-16");
  });

  it("夏時間: 21:00 UTC が取引日境界", () => {
    assert.equal(tradingDay(T("2026-07-15T20:59:00Z")), "2026-07-15");
    assert.equal(tradingDay(T("2026-07-15T21:01:00Z")), "2026-07-16");
  });
});

describe("isWeekendClosed (金17:00 NY 〜 日17:00 NY)", () => {
  it("夏時間の週末境界", () => {
    assert.equal(isWeekendClosed(T("2026-07-17T20:59:00Z")), false); // 金 16:59 NY
    assert.equal(isWeekendClosed(T("2026-07-17T21:01:00Z")), true); // 金 17:01 NY
    assert.equal(isWeekendClosed(T("2026-07-18T12:00:00Z")), true); // 土
    assert.equal(isWeekendClosed(T("2026-07-19T20:59:00Z")), true); // 日 16:59 NY
    assert.equal(isWeekendClosed(T("2026-07-19T21:01:00Z")), false); // 日 17:01 NY
  });

  it("冬時間の週末境界 (2026-01-16 金曜)", () => {
    assert.equal(isWeekendClosed(T("2026-01-16T21:59:00Z")), false); // 金 16:59 NY (EST)
    assert.equal(isWeekendClosed(T("2026-01-16T22:01:00Z")), true); // 金 17:01 NY
    assert.equal(isWeekendClosed(T("2026-01-18T22:01:00Z")), false); // 日 17:01 NY
  });
});

describe("isRolloverBlackout (NY 16:55〜17:10)", () => {
  it("冬時間: 21:55〜22:10 UTC", () => {
    assert.equal(isRolloverBlackout(T("2026-01-15T21:54:00Z")), false);
    assert.equal(isRolloverBlackout(T("2026-01-15T21:55:00Z")), true);
    assert.equal(isRolloverBlackout(T("2026-01-15T22:09:00Z")), true);
    assert.equal(isRolloverBlackout(T("2026-01-15T22:10:00Z")), false);
  });

  it("夏時間: 20:55〜21:10 UTC", () => {
    assert.equal(isRolloverBlackout(T("2026-07-15T20:54:00Z")), false);
    assert.equal(isRolloverBlackout(T("2026-07-15T20:55:00Z")), true);
    assert.equal(isRolloverBlackout(T("2026-07-15T21:09:00Z")), true);
    assert.equal(isRolloverBlackout(T("2026-07-15T21:10:00Z")), false);
  });
});

describe("inSession", () => {
  it("東京セッション (9:00-15:00 JST, DSTなし)", () => {
    assert.equal(inSession(T("2026-07-15T01:00:00Z"), "tokyo"), true); // JST 10:00
    assert.equal(inSession(T("2026-07-14T23:00:00Z"), "tokyo"), false); // JST 8:00
    assert.equal(inSession(T("2026-07-15T06:30:00Z"), "tokyo"), false); // JST 15:30
  });

  it("ロンドンセッション (8:00-16:30 現地) はDSTで UTC換算が1時間ずれる", () => {
    // 夏 (BST=UTC+1): 07:30Z = 8:30 現地 → セッション中
    assert.equal(inSession(T("2026-07-15T07:30:00Z"), "london"), true);
    // 冬 (GMT=UTC+0): 07:30Z = 7:30 現地 → セッション前
    assert.equal(inSession(T("2026-01-15T07:30:00Z"), "london"), false);
    assert.equal(inSession(T("2026-01-15T08:00:00Z"), "london"), true);
  });

  it("週末はどのセッションにも属さない", () => {
    assert.equal(inSession(T("2026-07-18T09:00:00Z"), "london"), false); // 土曜
  });
});

describe("nextRollover", () => {
  it("当日のNY17:00より前なら当日、後なら翌日を返す", () => {
    assert.equal(nextRollover(T("2026-07-15T10:00:00Z")), T("2026-07-15T21:00:00Z"));
    assert.equal(nextRollover(T("2026-07-15T21:00:00Z")), T("2026-07-16T21:00:00Z")); // exclusive
    assert.equal(nextRollover(T("2026-01-15T10:00:00Z")), T("2026-01-15T22:00:00Z"));
  });

  it("DST切替を跨いでも正しいUTC時刻を返す", () => {
    // 3/7(土) 22:00Z = NY 17:00 EST。次のロールオーバーは3/8(日)のNY17:00 = 21:00Z (EDT)
    assert.equal(nextRollover(T("2026-03-07T22:30:00Z")), T("2026-03-08T21:00:00Z"));
  });
});

describe("rolloverFinancingDays (水曜17:00 NYは3日分)", () => {
  it("水曜のロールオーバー跨ぎは3日、木曜は1日", () => {
    // 2026-07-15 は水曜
    assert.equal(
      rolloverFinancingDays(T("2026-07-15T20:00:00Z"), T("2026-07-15T22:00:00Z")),
      3,
    );
    // 木曜 (7/16) のロールオーバー
    assert.equal(
      rolloverFinancingDays(T("2026-07-16T20:00:00Z"), T("2026-07-16T22:00:00Z")),
      1,
    );
  });

  it("跨がなければ0、複数日跨げば合算", () => {
    assert.equal(rolloverFinancingDays(T("2026-07-15T10:00:00Z"), T("2026-07-15T20:00:00Z")), 0);
    // 火曜10:00Z→木曜10:00Z: 火(1) + 水(3) = 4
    assert.equal(
      rolloverFinancingDays(T("2026-07-14T10:00:00Z"), T("2026-07-16T10:00:00Z")),
      4,
    );
  });
});
