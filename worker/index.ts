/**
 * Cloudflare Workers エントリポイント。
 * - scheduled: cron 2系統 ("* * * * *"=ボットtick / "*&#47;5 * * * *"=スーパーバイザ)
 * - fetch: 管理画面 (/api/* はJSON API、それ以外は admin/public の静的アセット)
 *
 * nodejs_compat により Secrets/Vars は process.env にも入るため、
 * src/ 配下のコードは Node / Workers 両方でそのまま動く。
 */
import { goldPaceWarnDayKey, goldPaceWarning } from "../src/live/goldPace.ts";
import { runOnce } from "../src/live/tradingBot.ts";
import { STATE_KEYS } from "../src/safety/state.ts";
import { OandaClient, type OandaEnv } from "../src/oanda/client.ts";
import { loadSafetyConfig } from "../src/safety/config.ts";
import { KillSwitch, type TradingActions } from "../src/safety/killSwitch.ts";
import { Notifier } from "../src/safety/notifier.ts";
import { RiskManager } from "../src/safety/riskManager.ts";
import { pingHealthcheck, superviseOnce } from "../src/safety/supervisor.ts";
import { handleApi } from "./api.ts";
import { D1BotDb } from "./db.ts";
import { D1StateStore } from "./state.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOT_LIVE: string;
  OANDA_ENV: string;
  OANDA_API_TOKEN?: string;
  OANDA_ACCOUNT_ID?: string;
  NOTIFY_WEBHOOK_URL?: string;
  HEALTHCHECK_URL_BOT?: string;
  HEALTHCHECK_URL_SUPERVISOR?: string;
  ADMIN_TOKEN?: string;
}

const BOT_CRON = "* * * * *";
const SUPERVISOR_CRON = "*/5 * * * *";

function buildOandaClient(env: Env): OandaClient | null {
  if (!env.OANDA_API_TOKEN || !env.OANDA_ACCOUNT_ID) return null;
  const oandaEnv: OandaEnv = env.OANDA_ENV === "live" ? "live" : "practice";
  return new OandaClient({
    env: oandaEnv,
    token: env.OANDA_API_TOKEN,
    accountId: env.OANDA_ACCOUNT_ID,
  });
}

/** キルスイッチが市場に対して行う操作 (全注文キャンセル + 全ポジションクローズ) */
function buildTradingActions(client: OandaClient): TradingActions {
  return {
    async cancelAllOrders(): Promise<number> {
      const pending = await client.getPendingOrders();
      for (const order of pending.orders) {
        await client.cancelOrder(order.id);
      }
      return pending.orders.length;
    },
    async closeAllPositions(): Promise<void> {
      const positions = await client.getOpenPositions();
      for (const p of positions.positions) {
        if (Number(p.long.units) > 0) await client.closePosition(p.instrument, { longUnits: "ALL" });
        if (Number(p.short.units) < 0) await client.closePosition(p.instrument, { shortUnits: "ALL" });
      }
    },
  };
}

export default {
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const notifier = new Notifier(env.NOTIFY_WEBHOOK_URL);
    const store = new D1StateStore(env.DB);
    const client = buildOandaClient(env);

    switch (event.cron) {
      case BOT_CRON: {
        if (!client) {
          console.log("OANDA未設定のためボットtickをスキップ (dry deploy検証モード)");
          await pingHealthcheck(env.HEALTHCHECK_URL_BOT);
          return;
        }
        const config = loadSafetyConfig();
        const result = await runOnce({
          client,
          db: new D1BotDb(env.DB),
          store,
          riskManager: new RiskManager(config, store),
          safetyConfig: config,
          notifier,
          live: env.BOT_LIVE === "true",
        });
        console.log(
          `bot tick: skipped=${result.skipped} decisions=${result.decisionsMade} orders=${result.ordersPlaced} errors=${result.errors.length}`,
        );
        // デッドマンスイッチ: 正常完了時のみping (エラー多発時は沈黙してアラートさせる)
        if (result.errors.length === 0) {
          await pingHealthcheck(env.HEALTHCHECK_URL_BOT);
        }
        break;
      }
      case SUPERVISOR_CRON: {
        if (!client) {
          await pingHealthcheck(env.HEALTHCHECK_URL_SUPERVISOR);
          return;
        }
        const config = loadSafetyConfig();
        const riskManager = new RiskManager(config, store);
        const killSwitch = new KillSwitch(
          buildTradingActions(client),
          notifier,
          store,
          config.flattenOnKill,
        );
        await superviseOnce({
          client,
          store,
          riskManager,
          killSwitch,
          notifier,
          ...(env.HEALTHCHECK_URL_SUPERVISOR
            ? { healthcheckUrl: env.HEALTHCHECK_URL_SUPERVISOR }
            : {}),
        });
        // Gold維持ペース警告 (BOT_LIVE時のみ・1日1回)。情報提供に徹し、
        // ノルマ消化のための発注は人間が判断する
        if (env.BOT_LIVE === "true") {
          const now = Date.now();
          const dayKey = goldPaceWarnDayKey(now);
          if ((await store.get(STATE_KEYS.goldPaceWarnDay)) !== dayKey) {
            const month = new Date(now).toISOString().slice(0, 7);
            const usd = await new D1BotDb(env.DB).monthlyUsdNotional(month);
            const warning = goldPaceWarning({ usdNotional: usd, nowMs: now });
            if (warning) {
              await notifier.warn(warning);
              await store.set(STATE_KEYS.goldPaceWarnDay, dayKey);
            }
          }
        }
        break;
      }
      default:
        console.error(`未知のcron: ${event.cron}`);
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const client = buildOandaClient(env);
      const config = loadSafetyConfig();
      return await handleApi(request, {
        db: env.DB,
        botDb: new D1BotDb(env.DB),
        store: new D1StateStore(env.DB),
        notifier: new Notifier(env.NOTIFY_WEBHOOK_URL),
        killSwitchActions: client ? buildTradingActions(client) : null,
        flattenOnKill: config.flattenOnKill,
        adminToken: env.ADMIN_TOKEN,
      });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
