/**
 * pip換算ユーティリティ。
 * インストルメントはOANDA形式 "BASE_QUOTE" (例: "USD_JPY", "EUR_USD")。
 */

/** 1pipの価格単位。JPYクォートは0.01、それ以外は0.0001 */
export function pipSize(instrument: string): number {
  return quoteCurrency(instrument) === "JPY" ? 0.01 : 0.0001;
}

export function quoteCurrency(instrument: string): string {
  const parts = instrument.split("_");
  if (parts.length !== 2 || !parts[1]) {
    throw new Error(`インストルメント名が不正です: ${instrument}`);
  }
  return parts[1];
}

export function priceToPips(instrument: string, priceDiff: number): number {
  return priceDiff / pipSize(instrument);
}

export function pipsToPrice(instrument: string, pips: number): number {
  return pips * pipSize(instrument);
}

/**
 * 1通貨単位・1pipあたりの価値をJPYで返す (JPY建て口座のサイジング用)。
 * - クォートがJPY (USD_JPY等): pipSize がそのままJPY
 * - クォートがUSD (EUR_USD等): pipSize USD × USD/JPYレート
 * それ以外のクォート通貨は未対応 (対応ペアを増やすときに拡張する)。
 */
export function pipValueJpyPerUnit(instrument: string, usdJpyRate?: number): number {
  const quote = quoteCurrency(instrument);
  if (quote === "JPY") return pipSize(instrument);
  if (quote === "USD") {
    if (usdJpyRate === undefined || !(usdJpyRate > 0)) {
      throw new Error(`${instrument} のpip価値換算にはUSD/JPYレートが必要です`);
    }
    return pipSize(instrument) * usdJpyRate;
  }
  throw new Error(`クォート通貨 ${quote} のpip価値換算は未対応です`);
}
