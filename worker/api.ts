import { KillSwitch } from "../src/safety/killSwitch.ts";
import type { Notifier } from "../src/safety/notifier.ts";
import type { StateStore } from "../src/safety/state.ts";
import { STATE_KEYS } from "../src/safety/state.ts";
import { validateParamsDoc } from "../src/live/paramsRegistry.ts";
import type { TradingActions } from "../src/safety/killSwitch.ts";
import type { D1BotDb } from "./db.ts";

/**
 * 管理画面のJSON API。すべて薄いD1クエリに徹する。
 *
 * 認証: Cloudflare Access配下での運用を前提とし、変更系はAccessのJWTヘッダ
 * (またはフォールバックのADMIN_TOKEN) を要求する。認証判定はrequireAuthに
 * 隔離してあり、方式の差し替えはこの1関数で完結する。
 */

export interface ApiDeps {
  db: D1Database;
  botDb: D1BotDb;
  store: StateStore;
  notifier: Notifier;
  killSwitchActions: TradingActions | null;
  flattenOnKill: boolean;
  adminToken: string | undefined;
}

/**
 * 認証 — fail-closed。
 * ADMIN_TOKEN との Bearer 一致のみを認証とみなす。ADMIN_TOKEN未設定なら全拒否
 * (設定漏れでworkers.dev上に公開される事故を構造的に防ぐ)。
 *
 * ⚠️ Cf-Access-Jwt-Assertion ヘッダの「存在」は認証に使わない — 誰でも偽装できる。
 * Cloudflare Accessへ移行する際は、WebCrypto (crypto.subtle) でJWTのRS256署名を
 * チームドメインのJWKSに対して検証する実装をこの関数に追加してから
 * トークン要求を緩めること。それまではAccess配下でもADMIN_TOKENを併用する。
 */
function requireAuth(request: Request, deps: ApiDeps): Response | null {
  if (!deps.adminToken) {
    return Response.json(
      { error: "ADMIN_TOKEN未設定のため全リクエストを拒否します (fail-closed)" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("Authorization");
  if (auth === `Bearer ${deps.adminToken}`) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // GET系にも認証を要求する (エクイティ・トレード履歴・判定ログも非公開情報)
  const denied = requireAuth(request, deps);
  if (denied) return denied;

  try {
    if (method === "GET") {
      switch (path) {
        case "/api/summary":
          return Response.json(await summary(deps));
        case "/api/equity":
          return Response.json(await equity(deps, url));
        case "/api/trades":
          return Response.json(await trades(deps, url));
        case "/api/decisions":
          return Response.json(await decisions(deps, url));
        case "/api/params":
          return Response.json((await deps.botDb.getParams()) ?? { version: 0, doc: { strategies: [] } });
        case "/api/params/history":
          return Response.json(await paramsHistory(deps));
        case "/api/volume":
          return Response.json(await volume(deps));
        case "/api/intents":
          return Response.json(await intents(deps, url));
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    }

    if (method === "POST") {
      switch (path) {
        case "/api/params": {
          const body = (await request.json()) as { doc: unknown; note?: string };
          const doc = validateParamsDoc(body.doc); // スキーマ+範囲バリデーション
          const version = await deps.botDb.saveParams(doc, body.note);
          await deps.notifier.info(`パラメータ更新 v${version} (次tickから新規エントリーに適用)`);
          return Response.json({ ok: true, version });
        }
        case "/api/kill": {
          const body = (await request.json().catch(() => ({}))) as { reason?: string };
          // OANDA未設定でも取引ロックだけは必ず永続化する (ロック最優先の原則)。
          // ドライラン期間中のキルスイッチ・リハーサルもこれで成立する
          const actions = deps.killSwitchActions ?? {
            cancelAllOrders: async () => 0,
            closeAllPositions: async () => {},
          };
          const ks = new KillSwitch(actions, deps.notifier, deps.store, deps.flattenOnKill);
          await ks.trip(body.reason ?? "管理画面から手動発動");
          if (!deps.killSwitchActions) {
            await deps.notifier.warn(
              "OANDA未設定のため市場操作 (注文キャンセル/クローズ) はスキップ。ロックのみ記録しました",
            );
          }
          return Response.json({ ok: true, marketActions: deps.killSwitchActions !== null });
        }
        case "/api/kill/reset": {
          await KillSwitch.reset(deps.store);
          await deps.notifier.warn("キルスイッチが手動で解除されました");
          return Response.json({ ok: true });
        }
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    }

    return Response.json({ error: "method not allowed" }, { status: 405 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

async function summary(deps: ApiDeps): Promise<unknown> {
  const [latest, killSwitch, params, unknownIntents, silentSkips, openTrades] = await Promise.all([
    deps.db
      .prepare("SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT 1")
      .first(),
    deps.store.get(STATE_KEYS.killSwitch),
    deps.botDb.getParams(),
    deps.db
      .prepare("SELECT COUNT(*) AS n FROM orders_intent WHERE status IN ('unknown','pending')")
      .first<{ n: number }>(),
    // サイレントスキップ検出: 発注すべき判定にintentが紐づいていない
    deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions d
         LEFT JOIN orders_intent oi ON oi.decision_id = d.id
         WHERE d.action IN ('open','reverse') AND d.status = 'ok' AND d.live = 1
           AND oi.client_id IS NULL AND d.ts > datetime('now', '-1 day')`,
      )
      .first<{ n: number }>(),
    deps.db
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE state = 'open'")
      .first<{ n: number }>(),
  ]);
  return {
    latestSnapshot: latest,
    killSwitch: killSwitch ? JSON.parse(killSwitch) : null,
    paramsVersion: params?.version ?? 0,
    unresolvedIntents: unknownIntents?.n ?? 0,
    silentSkips24h: silentSkips?.n ?? 0,
    openTrades: openTrades?.n ?? 0,
    supervisor: JSON.parse((await deps.store.get(STATE_KEYS.supervisor)) ?? "null"),
  };
}

async function equity(deps: ApiDeps, url: URL): Promise<unknown> {
  const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 86400_000).toISOString();
  const res = await deps.db
    .prepare("SELECT ts, nav, margin_used, spread_pips FROM equity_snapshots WHERE ts >= ? ORDER BY ts")
    .bind(from)
    .all();
  return res.results;
}

async function trades(deps: ApiDeps, url: URL): Promise<unknown> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const res = await deps.db
    .prepare("SELECT * FROM trades ORDER BY COALESCE(exit_ts, entry_ts) DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all();
  return res.results;
}

async function decisions(deps: ApiDeps, url: URL): Promise<unknown> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const status = url.searchParams.get("status");
  const res = status
    ? await deps.db
        .prepare("SELECT * FROM decisions WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?")
        .bind(status, limit, offset)
        .all()
    : await deps.db
        .prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ? OFFSET ?")
        .bind(limit, offset)
        .all();
  return res.results;
}

async function paramsHistory(deps: ApiDeps): Promise<unknown> {
  const res = await deps.db
    .prepare("SELECT version, updated_at, note FROM params_history ORDER BY version DESC LIMIT 50")
    .all();
  return res.results;
}

/**
 * Goldステータス月間取引量 (USD notional)。
 * 加算カウンタではなくtransaction台帳からのSUMで導出する (冪等・二重計上なし)。
 * ⚠️ このゲージは監視専用 — サイズや頻度を目標駆動で上げるトリガーにしない。
 */
async function volume(deps: ApiDeps): Promise<unknown> {
  const res = await deps.db
    .prepare(
      `SELECT substr(ts, 1, 7) AS month,
              SUM(CASE
                    WHEN instrument LIKE 'USD/_%' ESCAPE '/' THEN ABS(units)
                    WHEN instrument LIKE '%/_USD' ESCAPE '/' THEN ABS(units) * price
                    ELSE 0
                  END) AS usd_notional,
              COUNT(*) AS fills
       FROM oanda_transactions
       WHERE type = 'ORDER_FILL'
       GROUP BY month ORDER BY month DESC LIMIT 12`,
    )
    .all();
  return { months: res.results, goldRequirementUsd: 500_000 };
}

async function intents(deps: ApiDeps, url: URL): Promise<unknown> {
  const status = url.searchParams.get("status");
  const res = status
    ? await deps.db
        .prepare("SELECT * FROM orders_intent WHERE status = ? ORDER BY ts DESC LIMIT 200")
        .bind(status)
        .all()
    : await deps.db.prepare("SELECT * FROM orders_intent ORDER BY ts DESC LIMIT 200").all();
  return res.results;
}
