import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { pipSize, pipValueJpyPerUnit, pipsToPrice, priceToPips } from "../src/core/pips.ts";

describe("pipSize", () => {
  it("JPYクォートは0.01、USDクォートは0.0001", () => {
    assert.equal(pipSize("USD_JPY"), 0.01);
    assert.equal(pipSize("EUR_JPY"), 0.01);
    assert.equal(pipSize("EUR_USD"), 0.0001);
  });

  it("不正なインストルメント名は例外", () => {
    assert.throws(() => pipSize("USDJPY"));
  });
});

describe("priceToPips / pipsToPrice", () => {
  it("USD/JPY: 0.15円 = 15pips", () => {
    assert.ok(Math.abs(priceToPips("USD_JPY", 0.15) - 15) < 1e-9);
    assert.ok(Math.abs(pipsToPrice("USD_JPY", 15) - 0.15) < 1e-9);
  });

  it("EUR/USD: 0.0015ドル = 15pips", () => {
    assert.ok(Math.abs(priceToPips("EUR_USD", 0.0015) - 15) < 1e-9);
  });
});

describe("pipValueJpyPerUnit", () => {
  it("USD/JPY: 1unitあたり1pip = 0.01円", () => {
    assert.equal(pipValueJpyPerUnit("USD_JPY"), 0.01);
  });

  it("EUR/USD: USD/JPYレートで換算する (150円なら 0.0001*150 = 0.015円)", () => {
    assert.ok(Math.abs(pipValueJpyPerUnit("EUR_USD", 150) - 0.015) < 1e-9);
  });

  it("EUR/USDでUSD/JPYレートが無ければ例外 (サイジング事故防止)", () => {
    assert.throws(() => pipValueJpyPerUnit("EUR_USD"));
  });

  it("未対応クォート通貨は例外", () => {
    assert.throws(() => pipValueJpyPerUnit("EUR_GBP", 150));
  });
});
