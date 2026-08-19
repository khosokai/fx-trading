import { aggregateClosed } from "../core/aggregate.ts";
import { TF_MS } from "../core/candle.ts";
import type { Signal, StrategyContext } from "../core/strategy.ts";
import { buildActiveStrategies } from "../live/paramsRegistry.ts";
import type { ParamsDoc } from "../live/ports.ts";
import { oandaClientFromEnv } from "../oanda/client.ts";

/**
 * パリティ検証: 本番Workerが記録した判定ログ (decisions) を、同じローソク足で
 * 同じStrategy.decide()にかけて全件照合する。「本番実装 = バックテスト」の証明。
 * BOT_LIVE昇格チェックリストの必須項目 (全件一致が条件)。
 *
 * 使い方:
 *   ADMIN_BASE_URL=https://fx-trading-bot.<subdomain>.workers.dev \
 *   OANDA_API_TOKEN=... OANDA_ACCOUNT_ID=... OANDA_ENV=practice \
 *   npm run verify:parity
 */

interface DecisionRow {
  id: number;
  strategy_id: string;
  instrument: string;
  bar_time: number;
  position: number;
  target: number;
  sl_pips: number | null;
  tp_pips: number | null;
  param_version: number | null;
  status: string;
}

async function main(): Promise<void> {
  const baseUrl = process.env["ADMIN_BASE_URL"];
  if (!baseUrl) throw new Error("ADMIN_BASE_URL を設定してください");
  const client = oandaClientFromEnv();

  const paramsRes = (await (await fetch(`${baseUrl}/api/params`)).json()) as {
    version: number;
    doc: ParamsDoc;
  };
  const decisions = (await (
    await fetch(`${baseUrl}/api/decisions?limit=500`)
  ).json()) as DecisionRow[];

  const targetRows = decisions.filter(
    (d) => d.param_version === paramsRes.version && d.status !== "error",
  );
  if (targetRows.length === 0) {
    console.log("照合対象の判定ログがありません (現行paramsバージョンの行のみ照合します)");
    return;
  }
  console.log(`照合対象: ${targetRows.length}件 (params v${paramsRes.version})`);

  const strategies = new Map(
    buildActiveStrategies(paramsRes.doc).map((a) => [a.strategy.id, a.strategy]),
  );

  let ok = 0;
  let mismatch = 0;
  let skipped = 0;

  // 戦略×銘柄ごとにまとめてローソク足を取り直す
  const groups = new Map<string, DecisionRow[]>();
  for (const row of targetRows) {
    const key = `${row.strategy_id}|${row.instrument}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
  }

  for (const [key, rows] of groups) {
    const [strategyId, instrument] = key.split("|") as [string, string];
    const strategy = strategies.get(strategyId);
    if (!strategy) {
      console.log(`⚠️ ${strategyId}: 現行paramsに存在しないためスキップ (${rows.length}件)`);
      skipped += rows.length;
      continue;
    }
    const tfMs = TF_MS[strategy.timeframe];
    const minBar = Math.min(...rows.map((r) => r.bar_time));
    const maxBar = Math.max(...rows.map((r) => r.bar_time));
    const from = new Date(minBar - (strategy.warmup + 10) * tfMs);
    const to = new Date(maxBar + tfMs);
    const m1 = await client.getCandles(instrument, { granularity: "M1", from, to });
    const candles = aggregateClosed(m1, strategy.timeframe);
    const indexByTime = new Map(candles.map((c, i) => [c.time, i]));

    for (const row of rows) {
      const index = indexByTime.get(row.bar_time);
      if (index === undefined || index <= strategy.warmup) {
        skipped += 1;
        continue;
      }
      const ctx: StrategyContext = {
        instrument,
        candles,
        index,
        htf: {},
        htfIndex: {},
        position: row.position as Signal,
      };
      const decision = strategy.decide(ctx);
      const targetMatch = decision.target === row.target;
      const slMatch = close(decision.stopLossPips ?? null, row.sl_pips);
      const tpMatch = close(decision.takeProfitPips ?? null, row.tp_pips);
      if (targetMatch && slMatch && tpMatch) {
        ok += 1;
      } else {
        mismatch += 1;
        console.log(
          `❌ 不一致 #${row.id} ${strategyId} bar=${new Date(row.bar_time).toISOString()}: ` +
            `target ${row.target}→${decision.target}, sl ${row.sl_pips}→${decision.stopLossPips}, tp ${row.tp_pips}→${decision.takeProfitPips}`,
        );
      }
    }
  }

  console.log(`\n結果: 一致 ${ok} / 不一致 ${mismatch} / スキップ ${skipped}`);
  if (mismatch > 0) {
    console.log("⚠️ パリティ違反があります。原因を特定するまで昇格しないこと。");
    process.exitCode = 1;
  } else {
    console.log("✅ パリティ全件一致");
  }
}

function close(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.05; // pips精度の丸め差を許容
}

await main();
