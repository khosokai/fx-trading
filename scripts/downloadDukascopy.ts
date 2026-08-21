import { getHistoricalRates } from "dukascopy-node";
import { mergeBidAsk, findGaps, formatGapReport, type DukascopyBar } from "../src/data/dukascopy.ts";
import { LocalChunkStore, monthRange } from "../src/data/store.ts";

/**
 * DukascopyからM1のBid/Ask足をダウンロードしてローカルチャンクに保存する。
 *
 * 使い方:
 *   npm run data:download                          # デフォルト (USD_JPY, EUR_USD, 2021-01-01〜)
 *   node scripts/downloadDukascopy.ts USD_JPY 2023-01-01 2024-01-01
 *
 * 月単位でダウンロード・保存するため、途中で中断しても再実行すれば続きから
 * 埋まる (保存済み月はスキップ。最新月だけは未確定なので常に取り直す)。
 */

const INSTRUMENT_MAP: Record<string, string> = {
  USD_JPY: "usdjpy",
  EUR_USD: "eurusd",
  EUR_JPY: "eurjpy",
  GBP_USD: "gbpusd",
};

const DATA_DIR = new URL("../data/candles", import.meta.url).pathname;

async function downloadMonth(
  dukaInstrument: string,
  month: string,
): Promise<{ bids: DukascopyBar[]; asks: DukascopyBar[] }> {
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = endOfMonth(month);
  const common = {
    instrument: dukaInstrument as Parameters<typeof getHistoricalRates>[0]["instrument"],
    dates: { from, to },
    timeframe: "m1",
    format: "json",
    volumes: true,
    ignoreFlats: true,
    retryCount: 8,
    // Dukascopyのレートリミット (429) 対策: バックオフを長めに取る
    pauseBetweenRetriesMs: 5000,
    pauseBetweenBatchesMs: 500,
  } as const;
  const bids = (await getHistoricalRates({ ...common, priceType: "bid" })) as DukascopyBar[];
  const asks = (await getHistoricalRates({ ...common, priceType: "ask" })) as DukascopyBar[];
  return { bids, asks };
}

function endOfMonth(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1)); // 翌月1日 0:00 (exclusive)
}

async function main(): Promise<void> {
  const [instrumentArg, fromArg, toArg] = process.argv.slice(2);
  const instruments = instrumentArg ? [instrumentArg] : ["USD_JPY", "EUR_USD"];
  const fromMs = Date.parse(fromArg ?? "2021-01-01T00:00:00Z");
  const toMs = Math.min(Date.parse(toArg ?? "2100-01-01"), Date.now());
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error("日付の形式が不正です (YYYY-MM-DD)");
  }

  const store = new LocalChunkStore(DATA_DIR);
  const currentMonth = new Date().toISOString().slice(0, 7);

  for (const instrument of instruments) {
    const dukaInstrument = INSTRUMENT_MAP[instrument];
    if (!dukaInstrument) {
      throw new Error(`未対応のインストルメント: ${instrument} (対応: ${Object.keys(INSTRUMENT_MAP).join(", ")})`);
    }

    const existing = new Set(await store.listMonths(instrument));
    const months = monthRange(fromMs, toMs);
    console.log(`=== ${instrument}: ${months.length}ヶ月分 (保存済み ${existing.size}ヶ月) ===`);

    for (const month of months) {
      // 過去月で保存済みならスキップ。当月は未確定なので取り直す
      if (existing.has(month) && month !== currentMonth) continue;
      process.stdout.write(`${instrument} ${month} ... `);
      try {
        const { bids, asks } = await downloadMonth(dukaInstrument, month);
        const { candles, droppedBidOnly, droppedAskOnly } = mergeBidAsk(bids, asks);
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
        console.error(`失敗: ${err instanceof Error ? err.message : err}`);
      }
      // レートリミット回避の月間ウェイト
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // ギャップレポート (全期間ロードして平日欠損を確認)
    const all = await store.load(instrument, new Date(fromMs), new Date(toMs));
    console.log(formatGapReport(instrument, all, findGaps(all)));
  }
}

await main();
