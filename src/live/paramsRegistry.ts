import type { Timeframe } from "../core/candle.ts";
import type { Strategy } from "../core/strategy.ts";
import { makeBbRsiReversion } from "../strategies/bbRsiReversion.ts";
import { makeDonchian } from "../strategies/donchian.ts";
import { makeSessionBreakout } from "../strategies/sessionBreakout.ts";
import type { ParamsDoc, StrategyParamsEntry } from "./ports.ts";

/**
 * D1のparams(JSON)から戦略インスタンスを構築するレジストリ。
 * GUIのパラメータ保存時もここのバリデーションを通す (worker/api.ts)。
 * 安全限界(リスク上限等)はここでは扱わない — SafetyConfigの領分。
 */

interface NumSpec {
  min: number;
  max: number;
}

interface StrategyDef {
  build(params: Record<string, number | string>): Strategy;
  /** GUI保存時のサーバー側バリデーション仕様 */
  schema: Record<string, NumSpec | "timeframe">;
}

const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M15", "H1"];

function num(params: Record<string, number | string>, key: string, spec: NumSpec): number {
  const v = Number(params[key]);
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
    throw new Error(`パラメータ ${key} が不正です: ${params[key]} (範囲 ${spec.min}〜${spec.max})`);
  }
  return v;
}

function tf(params: Record<string, number | string>, key = "timeframe"): Timeframe {
  const v = params[key];
  if (!TIMEFRAMES.includes(v as Timeframe)) {
    throw new Error(`パラメータ ${key} が不正です: ${v} (M1|M5|M15|H1)`);
  }
  return v as Timeframe;
}

export const STRATEGY_REGISTRY: Record<string, StrategyDef> = {
  donchian: {
    schema: {
      timeframe: "timeframe",
      entryPeriod: { min: 5, max: 200 },
      exitPeriod: { min: 3, max: 100 },
      atrPeriod: { min: 5, max: 50 },
      slAtrMult: { min: 0.5, max: 5 },
      // 任意のエントリーフィルタ (省略可)
      trendEmaPeriod: { min: 10, max: 500 },
      adxPeriod: { min: 5, max: 50 },
      adxMin: { min: 5, max: 50 },
    },
    build: (p) =>
      makeDonchian({
        timeframe: tf(p),
        entryPeriod: num(p, "entryPeriod", { min: 5, max: 200 }),
        exitPeriod: num(p, "exitPeriod", { min: 3, max: 100 }),
        atrPeriod: num(p, "atrPeriod", { min: 5, max: 50 }),
        slAtrMult: num(p, "slAtrMult", { min: 0.5, max: 5 }),
        ...(p["trendEmaPeriod"] !== undefined
          ? { trendEmaPeriod: num(p, "trendEmaPeriod", { min: 10, max: 500 }) }
          : {}),
        ...(p["adxPeriod"] !== undefined
          ? {
              adxPeriod: num(p, "adxPeriod", { min: 5, max: 50 }),
              adxMin: num(p, "adxMin", { min: 5, max: 50 }),
            }
          : {}),
      }),
  },
  sessionBreakout: {
    schema: {
      timeframe: "timeframe",
      minRangePips: { min: 0, max: 200 },
      maxRangePips: { min: 10, max: 500 },
      maxSlPips: { min: 5, max: 200 },
      tpR: { min: 0.5, max: 10 },
    },
    build: (p) =>
      makeSessionBreakout({
        timeframe: tf(p),
        minRangePips: num(p, "minRangePips", { min: 0, max: 200 }),
        maxRangePips: num(p, "maxRangePips", { min: 10, max: 500 }),
        maxSlPips: num(p, "maxSlPips", { min: 5, max: 200 }),
        tpR: num(p, "tpR", { min: 0.5, max: 10 }),
      }),
  },
  bbRsi: {
    schema: {
      timeframe: "timeframe",
      bbPeriod: { min: 5, max: 100 },
      bbSigma: { min: 1, max: 4 },
      rsiPeriod: { min: 2, max: 50 },
      rsiLower: { min: 5, max: 45 },
      rsiUpper: { min: 55, max: 95 },
      atrPeriod: { min: 5, max: 50 },
      slAtrMult: { min: 0.5, max: 5 },
    },
    build: (p) =>
      makeBbRsiReversion({
        timeframe: tf(p),
        bbPeriod: num(p, "bbPeriod", { min: 5, max: 100 }),
        bbSigma: num(p, "bbSigma", { min: 1, max: 4 }),
        rsiPeriod: num(p, "rsiPeriod", { min: 2, max: 50 }),
        rsiLower: num(p, "rsiLower", { min: 5, max: 45 }),
        rsiUpper: num(p, "rsiUpper", { min: 55, max: 95 }),
        atrPeriod: num(p, "atrPeriod", { min: 5, max: 50 }),
        slAtrMult: num(p, "slAtrMult", { min: 0.5, max: 5 }),
      }),
  },
};

export interface ActiveStrategy {
  strategy: Strategy;
  entry: StrategyParamsEntry;
}

/** paramsドキュメントを検証しつつ、有効な戦略を構築する */
export function buildActiveStrategies(doc: ParamsDoc): ActiveStrategy[] {
  const out: ActiveStrategy[] = [];
  for (const entry of doc.strategies) {
    const def = STRATEGY_REGISTRY[entry.type];
    if (!def) throw new Error(`未知の戦略タイプ: ${entry.type}`);
    if (!Number.isFinite(entry.riskPct) || entry.riskPct <= 0 || entry.riskPct > 5) {
      throw new Error(`riskPctが不正です: ${entry.riskPct}`);
    }
    if (!/^[A-Z]{3}_[A-Z]{3}$/.test(entry.instrument)) {
      throw new Error(`instrumentが不正です: ${entry.instrument}`);
    }
    if (!entry.enabled) continue;
    out.push({ strategy: def.build(entry.params), entry });
  }
  return out;
}

/** GUI保存時のバリデーション (無効な戦略も含めて全エントリを検査する) */
export function validateParamsDoc(doc: unknown): ParamsDoc {
  if (typeof doc !== "object" || doc === null || !Array.isArray((doc as ParamsDoc).strategies)) {
    throw new Error("paramsはstrategies配列を持つオブジェクトである必要があります");
  }
  const typed = doc as ParamsDoc;
  for (const entry of typed.strategies) {
    const def = STRATEGY_REGISTRY[entry.type];
    if (!def) throw new Error(`未知の戦略タイプ: ${entry.type}`);
    if (!/^[A-Z]{3}_[A-Z]{3}$/.test(entry.instrument)) {
      throw new Error(`instrumentが不正です: ${entry.instrument}`);
    }
    if (!Number.isFinite(entry.riskPct) || entry.riskPct <= 0 || entry.riskPct > 5) {
      throw new Error(`riskPctが不正です: ${entry.riskPct} (0〜5%)`);
    }
    def.build(entry.params); // スキーマ範囲チェックを兼ねる (構築が通れば正当)
  }
  return typed;
}
