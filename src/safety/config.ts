/**
 * 安全装置のハードリミット設定。
 *
 * 【設計判断】ハードリミットは環境変数(Workers Secrets/Vars)とコード定数
 * だけで決まり、D1のparams(GUI編集可能な戦略パラメータ)からは一切変更
 * できない。管理画面のタイプミス一発で口座が吹き飛ぶ経路を作らないため。
 * GUIで編集できるのは戦略パラメータ(期間・閾値等)のみ。
 */
export interface SafetyConfig {
  /** 1注文あたりのユニット数上限 (基軸通貨単位, 例: 10000 = 1万通貨) */
  maxUnitsPerOrder: number;
  /** 全ポジション合計のユニット数上限 */
  maxTotalUnits: number;
  /** リスク割合の上限 (1トレードでequityの何%までリスクを取れるか) */
  maxRiskPct: number;
  /** 証拠金使用率の上限 (%) */
  maxMarginUsedPct: number;
  /** 日次損失の上限 (取引日開始時資産に対する%)。超えたらキルスイッチ */
  dailyLossLimitPct: number;
  /** 過去最高資産からの最大ドローダウン(%)。超えたらキルスイッチ */
  maxDrawdownPct: number;
  /** 1時間あたりの発注回数上限 (暴走ループ対策) */
  maxOrdersPerHour: number;
  /** 参照価格からの乖離上限(%)。誤発注(桁間違い等)対策 */
  maxPriceDeviationPct: number;
  /** スプレッドがこのpipsを超えていたら新規エントリーを見送る */
  maxSpreadPips: number;
  /** キルスイッチ時に全ポジションも成行クローズするか */
  flattenOnKill: boolean;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`環境変数 ${name} が不正です: ${raw}`);
  return n;
}

export function loadSafetyConfig(): SafetyConfig {
  return {
    maxUnitsPerOrder: envNum("SAFETY_MAX_UNITS_PER_ORDER", 10_000),
    maxTotalUnits: envNum("SAFETY_MAX_TOTAL_UNITS", 20_000),
    maxRiskPct: envNum("SAFETY_MAX_RISK_PCT", 1),
    maxMarginUsedPct: envNum("SAFETY_MAX_MARGIN_USED_PCT", 40),
    dailyLossLimitPct: envNum("SAFETY_DAILY_LOSS_LIMIT_PCT", 3),
    maxDrawdownPct: envNum("SAFETY_MAX_DRAWDOWN_PCT", 15),
    maxOrdersPerHour: envNum("SAFETY_MAX_ORDERS_PER_HOUR", 20),
    maxPriceDeviationPct: envNum("SAFETY_MAX_PRICE_DEVIATION_PCT", 1),
    maxSpreadPips: envNum("SAFETY_MAX_SPREAD_PIPS", 2),
    flattenOnKill: process.env["SAFETY_FLATTEN_ON_KILL"] === "true",
  };
}
