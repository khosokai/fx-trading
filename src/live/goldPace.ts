/**
 * Goldステータス維持ペースの判定 (純粋関数)。
 *
 * OANDA JP確認済み (2026-08-20):
 * - 月間50万USD (新規+決済合算) 未達の月があると翌月3日頃にシルバー降格
 * - 降格するとAPIトークンが本番・デモとも無効化 → Bot完全停止
 * - 残高維持だけではAPI継続不可。毎月の実取引が必須
 *
 * ⚠️ この警告は情報提供のみ。ノルマ消化のための発注は人間が判断して
 * 手動で行う (自動発注のトリガーにしない — ゲージと同じ規律)。
 */

export const GOLD_REQUIREMENT_USD = 500_000;

export interface GoldPaceInput {
  /** 当月のUSD建て取引量 (新規+決済合算) */
  usdNotional: number;
  nowMs: number;
  /** 警告を開始する日 (デフォルト20日) */
  warnFromDay?: number;
  /** 期待進捗に対するこの割合を下回ったら警告 (デフォルト0.8) */
  paceThreshold?: number;
}

/** 警告すべきならメッセージを、問題なければnullを返す */
export function goldPaceWarning(input: GoldPaceInput): string | null {
  const { usdNotional, nowMs } = input;
  const warnFromDay = input.warnFromDay ?? 20;
  const paceThreshold = input.paceThreshold ?? 0.8;

  const now = new Date(nowMs);
  const day = now.getUTCDate();
  if (day < warnFromDay) return null;

  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const expected = GOLD_REQUIREMENT_USD * (day / daysInMonth);
  if (usdNotional >= expected * paceThreshold) return null;

  const shortfall = GOLD_REQUIREMENT_USD - usdNotional;
  const remainingDays = daysInMonth - day;
  return (
    `Gold維持ペース未達: 今月 $${Math.round(usdNotional).toLocaleString()} / $${GOLD_REQUIREMENT_USD.toLocaleString()} ` +
    `(残り${remainingDays}日で $${Math.round(shortfall).toLocaleString()} 不足)。` +
    `未達のまま月を越すと翌月3日頃に降格しAPIが停止します。` +
    `ノルマ消化する場合は手動で判断してください (1万通貨25往復 ≈ スプレッドコスト1,000円程度)`
  );
}

/** 警告の重複抑止キー (1日1回) */
export function goldPaceWarnDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
