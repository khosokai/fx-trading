import { execFileSync } from "node:child_process";
import { mergeBidAsk, findGaps, formatGapReport, type DukascopyBar } from "../src/data/dukascopy.ts";
import { LocalChunkStore, monthRange } from "../src/data/store.ts";

/**
 * Dukascopyの生datafeedエンドポイントから日次M1キャンドル(.bi5)を直接取得する
 * フォールバックダウンローダ。
 *
 * 背景 (2026-08-21): dukascopy-nodeが使うjetta.dukascopy.com/v1 APIはIP/ASN単位の
 * 429ブロックが厳しく、自宅IP・VPN経由とも長時間解除されなかった。一方
 * datafeed.dukascopy.com の生.bi5はHTTP(80)で取得可能だったため、この経路を実装。
 * 整合性は同一日のバー単位突合で検証済み (2021-01-04: 1439本OHLC完全一致、
 * 差分はflat足のみ)。--verify で任意の保存済み日を再検証できる。
 *
 * 使い方:
 *   node scripts/downloadDukascopyRaw.ts GBP_USD 2021-01-01            # 欠損月を補完
 *   node scripts/downloadDukascopyRaw.ts GBP_USD --verify 2021-01-04 2023-10-03
 *
 * 注意:
 * - .bi5はLZMA-alone形式。展開は xz CLI (`xz -dc --format=lzma`) に依存 (Node組み込み
 *   zlibはLZMA非対応。ランタイム依存ゼロ方針のためnpmのLZMAライブラリは追加しない)
 * - jetta経路 (downloadDukascopy.ts) と同じ ignoreFlats 相当 (volume=0の足を除外) +
 *   mergeBidAsk を通すため、保存形式・意味は既存チャンクと完全互換
 * - 429を受けたら即座に中断する (リトライ連射はBANを更新するだけ)。月次保存なので
 *   再実行すれば続きから埋まる
 * - 当月 (未確定) はデフォルトでは触らない。--current 指定時のみ当月チャンクを
 *   丸ごと取り直す (観察フェーズの週次更新用)
 */

const INSTRUMENT_MAP: Record<string, { code: string; factor: number }> = {
  USD_JPY: { code: "USDJPY", factor: 1e3 },
  EUR_USD: { code: "EURUSD", factor: 1e5 },
  EUR_JPY: { code: "EURJPY", factor: 1e3 },
  GBP_USD: { code: "GBPUSD", factor: 1e5 },
};

const DATA_DIR = new URL("../data/candles", import.meta.url).pathname;
// VPN等のDNSが返すAWS系エッジ (16.62.x.x) は503を返すことがある。
// DATAFEED_HOST=194.8.15.180 のようにDukascopy自社AS側エッジを直指定できる
// (Hostヘッダ不要なことは確認済み)
const DATAFEED_HOST = process.env["DATAFEED_HOST"] ?? "datafeed.dukascopy.com";
const BASE = `http://${DATAFEED_HOST}/datafeed`;
const PAUSE_MS = 250;

class RateLimitedError extends Error {}

function lzmaDecompress(buf: Buffer): Buffer {
  return execFileSync("xz", ["-dc", "--format=lzma"], {
    input: buf,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 日次M1キャンドル.bi5 (24Bレコード×1440) をパースする。404等でデータなしならnull */
async function fetchDayCandles(
  code: string,
  factor: number,
  year: number,
  month0: number,
  day: number,
  priceType: "BID" | "ASK",
): Promise<DukascopyBar[] | null> {
  const url = `${BASE}/${code}/${year}/${String(month0).padStart(2, "0")}/${String(day).padStart(2, "0")}/${priceType}_candles_min_1.bi5`;
  // クォータ到達後は 301→https→503 のソフトブロックに変わるため、リダイレクトは
  // 追わずにレートリミット扱いで即中断する
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
  if (res.status === 429 || res.status === 503 || (res.status >= 300 && res.status < 400)) {
    throw new RateLimitedError(`${res.status} (rate limited): ${url}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length === 0) return null;
  const bin = lzmaDecompress(raw);
  if (bin.length % 24 !== 0) throw new Error(`不正なレコード長 ${bin.length}: ${url}`);
  const dayStartMs = Date.UTC(year, month0, day);
  const bars: DukascopyBar[] = [];
  for (let o = 0; o < bin.length; o += 24) {
    const sec = bin.readUInt32BE(o);
    if (sec >= 86_400 || sec % 60 !== 0) throw new Error(`不正な秒オフセット ${sec}: ${url}`);
    const open = bin.readUInt32BE(o + 4) / factor;
    const close = bin.readUInt32BE(o + 8) / factor;
    const low = bin.readUInt32BE(o + 12) / factor;
    const high = bin.readUInt32BE(o + 16) / factor;
    const volume = bin.readFloatBE(o + 20);
    if (volume === 0) continue; // ignoreFlats相当 (jetta経路とのパリティ)
    if (!(low > 0 && low <= open && low <= close && high >= open && high >= close)) {
      throw new Error(`不正なOHLC (${open}/${high}/${low}/${close}): ${url}`);
    }
    bars.push({ timestamp: dayStartMs + sec * 1000, open, high, low, close, volume });
  }
  return bars;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

async function downloadMonth(
  instrument: string,
  month: string,
): Promise<ReturnType<typeof mergeBidAsk>> {
  const { code, factor } = INSTRUMENT_MAP[instrument]!;
  const [y, m] = month.split("-").map(Number);
  const year = y!;
  const month0 = m! - 1;
  const bids: DukascopyBar[] = [];
  const asks: DukascopyBar[] = [];
  for (let day = 1; day <= daysInMonth(year, month0); day++) {
    // 土曜(UTC)は全体が週末クローズ (金17:00 NY〜日17:00 NY) 内でflat足しかないため
    // リクエスト自体を省略する (クォータ節約)
    if (new Date(Date.UTC(year, month0, day)).getUTCDay() === 6) continue;
    const b = await fetchDayCandles(code, factor, year, month0, day, "BID");
    await sleep(PAUSE_MS);
    const a = await fetchDayCandles(code, factor, year, month0, day, "ASK");
    await sleep(PAUSE_MS);
    if (b) bids.push(...b);
    if (a) asks.push(...a);
  }
  return mergeBidAsk(bids, asks);
}

/** 保存済みデータと生datafeedを指定日でバー単位に突合する */
async function verifyDays(instrument: string, days: string[]): Promise<void> {
  const { code, factor } = INSTRUMENT_MAP[instrument]!;
  const store = new LocalChunkStore(DATA_DIR);
  let allOk = true;
  for (const dayStr of days) {
    const dayMs = Date.parse(`${dayStr}T00:00:00Z`);
    if (!Number.isFinite(dayMs)) throw new Error(`日付の形式が不正です: ${dayStr}`);
    const d = new Date(dayMs);
    const stored = await store.load(instrument, d, new Date(dayMs + 86_400_000));
    const bid = await fetchDayCandles(code, factor, d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), "BID");
    await sleep(PAUSE_MS);
    const ask = await fetchDayCandles(code, factor, d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), "ASK");
    await sleep(PAUSE_MS);
    const { candles } = mergeBidAsk(bid ?? [], ask ?? []);
    const rawByTime = new Map(candles.map((c) => [c.time, c]));

    let mismatch = 0;
    let missing = 0;
    let volDiff = 0;
    const eq = (x: number, y: number): boolean => Math.abs(x - y) < 1e-9;
    for (const s of stored) {
      const r = rawByTime.get(s.time);
      if (!r) {
        missing += 1;
        continue;
      }
      rawByTime.delete(s.time);
      const ohlcOk =
        eq(s.bid.o, r.bid.o) && eq(s.bid.h, r.bid.h) && eq(s.bid.l, r.bid.l) && eq(s.bid.c, r.bid.c) &&
        eq(s.ask.o, r.ask.o) && eq(s.ask.h, r.ask.h) && eq(s.ask.l, r.ask.l) && eq(s.ask.c, r.ask.c);
      if (!ohlcOk) mismatch += 1;
      // volumeはjetta側の丸めがあり得るため相対1e-4で比較 (参考情報)
      if (Math.abs(s.volume - r.volume) > Math.max(1e-4, Math.abs(s.volume) * 1e-4)) volDiff += 1;
    }
    const extra = rawByTime.size;
    const ok = mismatch === 0 && missing === 0 && extra === 0;
    allOk &&= ok;
    console.log(
      `${instrument} ${dayStr}: 保存${stored.length}本 vs 生${candles.length}本 — ` +
        `OHLC不一致${mismatch} 保存のみ${missing} 生のみ${extra} vol差${volDiff} → ${ok ? "OK" : "NG"}`,
    );
  }
  if (!allOk) {
    process.exitCode = 1;
    console.error("突合NGあり: データソース混在は安全と言えません");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const instrument = args[0];
  if (!instrument || !INSTRUMENT_MAP[instrument]) {
    throw new Error(`インストルメントを指定してください (対応: ${Object.keys(INSTRUMENT_MAP).join(", ")})`);
  }

  if (args[1] === "--verify") {
    await verifyDays(instrument, args.slice(2));
    return;
  }

  // --current: 当月 (+前月が未保存なら前月も) を取り直す。週次の観察フェーズ更新用
  const refreshCurrent = args.includes("--current");
  const dateArgs = args.slice(1).filter((a) => a !== "--current");
  const fromMs = Date.parse(dateArgs[0] ?? "2021-01-01T00:00:00Z");
  const toMs = Math.min(Date.parse(dateArgs[1] ?? "2100-01-01"), Date.now());
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error("日付の形式が不正です (YYYY-MM-DD)");
  }

  const store = new LocalChunkStore(DATA_DIR);
  const existing = new Set(await store.listMonths(instrument));
  const currentMonth = new Date().toISOString().slice(0, 7);
  const months = monthRange(fromMs, toMs).filter(
    (mo) => (!existing.has(mo) && mo !== currentMonth) || (refreshCurrent && mo === currentMonth),
  );
  console.log(`=== ${instrument} (raw datafeed): 対象 ${months.length}ヶ月 (保存済み ${existing.size}ヶ月${refreshCurrent ? "、当月取り直し" : ""}) ===`);

  for (const month of months) {
    process.stdout.write(`${instrument} ${month} ... `);
    try {
      const { candles, droppedBidOnly, droppedAskOnly } = await downloadMonth(instrument, month);
      if (candles.length === 0) {
        console.log("データなし");
        continue;
      }
      await store.save(instrument, candles);
      const dropped =
        droppedBidOnly + droppedAskOnly > 0
          ? ` (片側欠損で除外: bid側${droppedBidOnly} ask側${droppedAskOnly})`
          : "";
      console.log(`${candles.length}本 保存${dropped}`);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        console.error(`\n429を検知したため中断します (再実行で続きから埋まる): ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }

  const all = await store.load(instrument, new Date(fromMs), new Date(toMs));
  console.log(formatGapReport(instrument, all, findGaps(all)));
}

await main();
