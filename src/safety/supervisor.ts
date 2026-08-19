import type { OandaClient } from "../oanda/client.ts";
import type { KillSwitch } from "./killSwitch.ts";
import type { Notifier } from "./notifier.ts";
import type { RiskManager } from "./riskManager.ts";
import { STATE_KEYS, getJson, setJson, type StateStore, type SupervisorState } from "./state.ts";

/**
 * 5分毎の監視 (gmo-coinのsupervisorを移植・FX翻案)。
 * - NAVを取得して日次損失・最大DDを判定 → 違反ならキルスイッチ発動
 * - 連続失敗カウントを永続化し、閾値超過で警告
 * - 完了ごとにデッドマンスイッチ (healthchecks.io) へping
 */

const MAX_CONSECUTIVE_FAILURES = 3;

export interface SupervisorDeps {
  client: OandaClient;
  store: StateStore;
  riskManager: RiskManager;
  killSwitch: KillSwitch;
  notifier: Notifier;
  healthcheckUrl?: string;
}

export async function superviseOnce(deps: SupervisorDeps, nowMs: number = Date.now()): Promise<void> {
  const { client, store, riskManager, killSwitch, notifier } = deps;
  const state =
    (await getJson<SupervisorState>(store, STATE_KEYS.supervisor)) ?? {
      lastStatus: null,
      consecutiveFailures: 0,
    };

  try {
    const summary = await client.getAccountSummary();
    const nav = Number(summary.account.NAV);
    const check = await riskManager.checkEquity(nav, nowMs);

    if (check.violation) {
      await killSwitch.trip(check.violation);
    }

    state.lastStatus = `nav=${nav} daily=${check.dailyPnlPct.toFixed(2)}% dd=${check.drawdownPct.toFixed(2)}%`;
    state.consecutiveFailures = 0;
  } catch (err) {
    state.consecutiveFailures += 1;
    state.lastStatus = `error: ${err instanceof Error ? err.message : err}`;
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await notifier.warn(
        `監視が${state.consecutiveFailures}回連続で失敗しています: ${state.lastStatus}`,
      );
    }
  } finally {
    await setJson(store, STATE_KEYS.supervisor, state);
  }

  await pingHealthcheck(deps.healthcheckUrl);
}

/** デッドマンスイッチ: 「pingが来ないこと」をhealthchecks.io側が検知する */
export async function pingHealthcheck(url: string | undefined): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
  } catch {
    // ping失敗で本体を止めない
  }
}
