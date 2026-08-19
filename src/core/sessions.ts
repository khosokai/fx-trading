/**
 * FX市場の時間構造。すべてIANAタイムゾーンで計算する。
 * NYロールオーバー(17:00 America/New_York)・週末境界・各セッションは
 * 夏時間で UTCオフセットが動くため、固定オフセット実装は禁止
 * (バックテストが3月/11月で半年分歪む古典的バグの原因)。
 *
 * Intl.DateTimeFormat は Node / Cloudflare Workers 両対応。
 * オフセットは時単位でキャッシュする (DST切替は時境界で起こるため安全)。
 */

const NY = "America/New_York";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const offsetCache = new Map<string, number>();

/** timeZoneのUTCオフセット (ms)。local = utc + offset */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const hourKey = `${timeZone}:${Math.floor(ms / 3_600_000)}`;
  const cached = offsetCache.get(hourKey);
  if (cached !== undefined) return cached;

  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`formatToPartsに${type}がありません`);
    return Number(p.value);
  };
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = asUtc - Math.floor(ms / 1000) * 1000;
  offsetCache.set(hourKey, offset);
  return offset;
}

export interface ZonedTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0=日曜 〜 6=土曜 (そのタイムゾーンでの曜日) */
  weekday: number;
}

export function zonedTime(ms: number, timeZone: string): ZonedTime {
  const local = new Date(ms + tzOffsetMs(ms, timeZone));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  };
}

/**
 * FXの取引日キー (NY 17:00区切り)。
 * 例: NY 8/18 16:59 → "2026-08-18", NY 8/18 17:01 → "2026-08-19"
 * 日次損失リセットや日次サマリの単位に使う。
 */
export function tradingDay(ms: number): string {
  const nyLocal = ms + tzOffsetMs(ms, NY);
  // 17:00開始の取引日は「翌日」の日付を名乗る → 7時間先送りして日付を取る
  return new Date(nyLocal + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** 週末クローズ中か (金 17:00 NY 〜 日 17:00 NY) */
export function isWeekendClosed(ms: number): boolean {
  const t = zonedTime(ms, NY);
  if (t.weekday === 6) return true; // 土曜
  if (t.weekday === 5 && t.hour >= 17) return true; // 金曜17時以降
  if (t.weekday === 0 && t.hour < 17) return true; // 日曜17時前
  return false;
}

/**
 * ロールオーバー帯の新規発注ブラックアウト (NY 16:55〜17:10)。
 * スプレッド拡大・スワップ確定処理・流動性低下が重なる時間帯。
 */
export function isRolloverBlackout(ms: number): boolean {
  const t = zonedTime(ms, NY);
  return (t.hour === 16 && t.minute >= 55) || (t.hour === 17 && t.minute < 10);
}

export type SessionName = "tokyo" | "london" | "newyork";

interface SessionDef {
  timeZone: string;
  /** セッション開始 (現地時間の分) */
  startMin: number;
  /** セッション終了 (現地時間の分, exclusive) */
  endMin: number;
}

export const SESSIONS: Record<SessionName, SessionDef> = {
  tokyo: { timeZone: "Asia/Tokyo", startMin: 9 * 60, endMin: 15 * 60 },
  london: { timeZone: "Europe/London", startMin: 8 * 60, endMin: 16 * 60 + 30 },
  newyork: { timeZone: NY, startMin: 8 * 60, endMin: 17 * 60 },
};

export function inSession(ms: number, session: SessionName): boolean {
  const def = SESSIONS[session];
  const t = zonedTime(ms, def.timeZone);
  if (t.weekday === 0 || t.weekday === 6) return false;
  const min = t.hour * 60 + t.minute;
  return min >= def.startMin && min < def.endMin;
}

/**
 * (fromMs, toMs] の間に跨いだロールオーバーのスワップ付与日数。
 * FXスポットのT+2慣行により、水曜17:00 NYのロールオーバーは3日分。
 * ポジション保有中のスワップ近似に使う。
 */
export function rolloverFinancingDays(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  let days = 0;
  let cursor = nextRollover(fromMs);
  while (cursor <= toMs) {
    // ロールオーバー直前 (=その取引日の終わり) のNY曜日で判定。
    // スワップ付与は月〜金の17:00のみ (土日の17:00境界は数えない。
    // 週末分は水曜3倍のT+2慣行に織り込まれている)
    const wd = zonedTime(cursor - 1, NY).weekday;
    if (wd >= 1 && wd <= 5) {
      days += wd === 3 ? 3 : 1; // 水曜は3日分
    }
    cursor = nextRollover(cursor);
  }
  return days;
}

/** ms より後の最初の 17:00 NY (exclusive) */
export function nextRollover(ms: number): number {
  const t = zonedTime(ms, NY);
  for (let addDays = 0; addDays <= 2; addDays++) {
    // NY現地の「その日の17:00」をUTCに直す。オフセットは候補時刻自身のもので
    // 再計算する (DST切替は現地2:00に起こるため1回の再計算で収束する)
    const localMidnight = Date.UTC(t.year, t.month - 1, t.day + addDays);
    const rough = localMidnight + 17 * 3_600_000 - tzOffsetMs(ms, NY);
    const candidate = localMidnight + 17 * 3_600_000 - tzOffsetMs(rough, NY);
    if (candidate > ms) return candidate;
  }
  throw new Error("nextRollover: 候補が見つかりません (バグ)");
}
