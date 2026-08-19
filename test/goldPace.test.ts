import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { goldPaceWarning } from "../src/live/goldPace.ts";

// 2026-08 は31日の月。20日時点の期待進捗 = 50万 × 20/31 ≈ $322,580
const DAY20 = Date.parse("2026-08-20T12:00:00Z");
const DAY10 = Date.parse("2026-08-10T12:00:00Z");

describe("goldPaceWarning", () => {
  it("20日より前は取引量ゼロでも警告しない", () => {
    assert.equal(goldPaceWarning({ usdNotional: 0, nowMs: DAY10 }), null);
  });

  it("20日以降、期待進捗の80%未満なら警告する", () => {
    const warning = goldPaceWarning({ usdNotional: 100_000, nowMs: DAY20 });
    assert.ok(warning !== null);
    assert.match(warning, /Gold維持ペース未達/);
    assert.match(warning, /手動で判断/); // 自動発注しない規律の明記
  });

  it("期待進捗の80%以上なら警告しない", () => {
    // 期待 $322,580 × 0.8 ≈ $258,064
    assert.equal(goldPaceWarning({ usdNotional: 260_000, nowMs: DAY20 }), null);
  });

  it("達成済みなら警告しない", () => {
    assert.equal(goldPaceWarning({ usdNotional: 500_000, nowMs: DAY20 }), null);
  });
});
