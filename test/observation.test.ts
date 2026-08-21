import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  evaluateObservation,
  verifyAppendOnly,
  type PromotionCriteria,
  type TradeLogEntry,
} from "../src/backtest/observation.ts";

/**
 * 観察フェーズ判定ロジックのテスト (docs/research.md 2026-08-21 観察名簿)。
 * 昇格・失格・観察継続の3状態と、append-only再現性検証を固定する。
 */

const CRITERIA: PromotionCriteria = {
  minMonths: 4,
  minTrades: 30,
  minCumulativeExpectancyPips: 0.82,
  rolling30KillPips: -10.98,
};

const MONTH = 30.44 * 86_400_000;
const T0 = Date.parse("2026-08-22T00:00:00Z");

describe("evaluateObservation", () => {
  it("開始直後は観察継続 (全条件が未充足として列挙される)", () => {
    const s = evaluateObservation([], T0, T0 + 1, CRITERIA);
    assert.equal(s.promotable, false);
    assert.equal(s.killed, false);
    assert.equal(s.pending.length, 3);
  });

  it("全条件充足で昇格可能", () => {
    const pips = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 5 : -3)); // 平均+1.0p
    const s = evaluateObservation(pips, T0, T0 + 5 * MONTH, CRITERIA);
    assert.equal(s.killed, false);
    assert.equal(s.promotable, true);
    assert.ok((s.cumulativeExpectancyPips ?? 0) > 0.82);
  });

  it("期間・件数を満たしても累積期待値不足なら観察継続", () => {
    const pips = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 3 : -2.5)); // 平均+0.25p
    const s = evaluateObservation(pips, T0, T0 + 5 * MONTH, CRITERIA);
    assert.equal(s.promotable, false);
    assert.ok(s.pending.some((p) => p.includes("累積期待値")));
  });

  it("30件ローリングが失格線を割ったら即時失格 (その後回復しても)", () => {
    // 最初の30件が大負け (-15p平均) → その後大勝ちで回復
    const pips = [...Array.from({ length: 30 }, () => -15), ...Array.from({ length: 30 }, () => 20)];
    const s = evaluateObservation(pips, T0, T0 + 6 * MONTH, CRITERIA);
    assert.equal(s.killed, true);
    assert.equal(s.promotable, false);
    assert.ok((s.worstRolling30 ?? 0) < -10.98);
  });

  it("30件未満では失格判定しない", () => {
    const pips = Array.from({ length: 29 }, () => -20);
    const s = evaluateObservation(pips, T0, T0 + MONTH, CRITERIA);
    assert.equal(s.killed, false);
    assert.equal(s.worstRolling30, null);
  });
});

describe("verifyAppendOnly", () => {
  const t = (i: number, pl: number): TradeLogEntry => ({
    entryTime: T0 + i * 3_600_000,
    exitTime: T0 + i * 3_600_000 + 1_800_000,
    direction: 1,
    plPips: pl,
  });

  it("保存済みが再計算の先頭部分と一致すれば新規分を返す", () => {
    const stored = [t(1, 2), t(2, -1)];
    const recomputed = [t(1, 2), t(2, -1), t(3, 4)];
    const r = verifyAppendOnly(stored, recomputed);
    assert.equal(r.ok, true);
    assert.deepEqual(r.appended, [t(3, 4)]);
  });

  it("保存済みトレードの損益が変わっていたらエラー (データ改訂の検出)", () => {
    const r = verifyAppendOnly([t(1, 2)], [t(1, 2.5)]);
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes("不一致"));
  });

  it("保存済みトレードが再計算から消えたらエラー", () => {
    const r = verifyAppendOnly([t(1, 2), t(2, -1)], [t(1, 2)]);
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes("消失"));
  });
});
