import { pipSize } from "../core/pips.ts";
import { LocalChunkStore } from "../data/store.ts";
import { oandaClientFromEnv } from "../oanda/client.ts";

/**
 * OANDA vs Dukascopy のフィード突合 (Phase 5: 口座開設後の必須検証)。
 * バックテスト(Dukascopy)の前提が本番フィード(OANDA)でどれだけずれるかを測る。
 * スプレッド差が大きい場合は、その分をspreadMarkupPipsに反映してWFAを再実行する。
 *
 * 使い方:
 *   OANDA_API_TOKEN=... OANDA_ACCOUNT_ID=... OANDA_ENV=practice \
 *   npm run compare:feeds -- USD_JPY 7
 */

const DATA_DIR = new URL("../../data/candles", import.meta.url).pathname;

async function main(): Promise<void> {
  const [instrumentArg, daysArg] = process.argv.slice(2);
  const instrument = instrumentArg ?? "USD_JPY";
  const days = Number(daysArg ?? 7);
  const to = new Date();
  const from = new Date(Date.now() - days * 86400_000);

  const client = oandaClientFromEnv();
  const store = new LocalChunkStore(DATA_DIR);

  console.log(`${instrument}: 直近${days}日のM1を突合します`);
  const duka = await store.load(instrument, from, to);
  // OANDAは1回5000本まで → from/countで分割取得
  const oanda: Awaited<ReturnType<typeof client.getCandles>> = [];
  let cursor = from;
  while (cursor < to) {
    const batch = await client.getCandles(instrument, {
      granularity: "M1",
      from: cursor,
      count: 5000,
    });
    if (batch.length === 0) break;
    oanda.push(...batch.filter((c) => c.time > (oanda[oanda.length - 1]?.time ?? -1)));
    const last = batch[batch.length - 1]!;
    if (last.time <= cursor.getTime()) break;
    cursor = new Date(last.time + 60_000);
  }
  console.log(`Dukascopy: ${duka.length}本 / OANDA: ${oanda.length}本`);

  const pip = pipSize(instrument);
  const dukaByTime = new Map(duka.map((c) => [c.time, c]));
  let matched = 0;
  let missingInDuka = 0;
  const midDiffs: number[] = [];
  const dukaSpreads: number[] = [];
  const oandaSpreads: number[] = [];

  for (const oc of oanda) {
    const dc = dukaByTime.get(oc.time);
    oandaSpreads.push((oc.ask.c - oc.bid.c) / pip);
    if (!dc) {
      missingInDuka += 1;
      continue;
    }
    matched += 1;
    const oandaMid = (oc.bid.c + oc.ask.c) / 2;
    const dukaMid = (dc.bid.c + dc.ask.c) / 2;
    midDiffs.push((oandaMid - dukaMid) / pip);
    dukaSpreads.push((dc.ask.c - dc.bid.c) / pip);
  }

  console.log(`\n突合: ${matched}本一致 / OANDAのみ ${missingInDuka}本`);
  if (midDiffs.length > 0) {
    console.log(`仲値差 (OANDA-Dukascopy, pips): 平均 ${mean(midDiffs).toFixed(3)} / 絶対平均 ${mean(midDiffs.map(Math.abs)).toFixed(3)} / 最大 ${Math.max(...midDiffs.map(Math.abs)).toFixed(2)}`);
    console.log(`スプレッド (pips): Dukascopy 平均 ${mean(dukaSpreads).toFixed(2)} / OANDA 平均 ${mean(oandaSpreads).toFixed(2)}`);
    const spreadGap = mean(oandaSpreads) - mean(dukaSpreads);
    console.log(
      spreadGap > 0.1
        ? `⚠️ OANDAのスプレッドが平均 +${spreadGap.toFixed(2)}pips 広い → spreadMarkupPips=${Math.ceil(spreadGap * 10) / 10} でWFAを再実行すること`
        : "✅ スプレッド差は許容範囲",
    );
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

await main();
