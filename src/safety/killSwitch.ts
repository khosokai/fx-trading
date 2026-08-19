import type { Notifier } from "./notifier.ts";
import { STATE_KEYS, getJson, setJson, type KillSwitchState, type StateStore } from "./state.ts";

/**
 * キルスイッチ: 取引ロック + (設定により)全ポジションクローズ。
 * ロック状態はStateStoreに永続化され、再起動しても解除されない。
 * 解除は人間の明示操作 (管理画面のリセットボタン) のみ。
 *
 * OANDAクライアントへの依存を避けるため、実際の市場操作は
 * TradingActions として注入する (テスト容易性とレイヤ分離のため)。
 */
export interface TradingActions {
  /** 未約定注文をすべてキャンセルする。キャンセルした件数を返す */
  cancelAllOrders(): Promise<number>;
  /** 全ポジションを成行でクローズする */
  closeAllPositions(): Promise<void>;
}

export class KillSwitch {
  private readonly actions: TradingActions;
  private readonly notifier: Notifier;
  private readonly store: StateStore;
  private readonly flatten: boolean;

  constructor(actions: TradingActions, notifier: Notifier, store: StateStore, flatten: boolean) {
    this.actions = actions;
    this.notifier = notifier;
    this.store = store;
    this.flatten = flatten;
  }

  /** 発動する。多重発動は無視 */
  async trip(reason: string): Promise<void> {
    const current = await getJson<KillSwitchState>(this.store, STATE_KEYS.killSwitch);
    if (current?.active) return;

    // 取引ロックを最優先で永続化 (killSwitchキーのみの独立UPDATE)
    await setJson(this.store, STATE_KEYS.killSwitch, {
      active: true,
      reason,
      trippedAt: new Date().toISOString(),
    } satisfies KillSwitchState);

    await this.notifier.critical(`キルスイッチ発動: ${reason}`);

    try {
      const canceled = await this.actions.cancelAllOrders();
      await this.notifier.critical(`全注文キャンセル完了: ${canceled}件`);
    } catch (err) {
      await this.notifier.critical(
        `注文キャンセルに失敗。手動で確認してください: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (this.flatten) {
      try {
        await this.actions.closeAllPositions();
        await this.notifier.critical("全ポジションを成行クローズしました");
      } catch (err) {
        await this.notifier.critical(
          `ポジションクローズに失敗。手動で対応してください: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else {
      await this.notifier.critical(
        "ポジションは残っています (サーバー側SL/TPは有効)。クローズするかは手動で判断してください。",
      );
    }
  }

  /** 人間による明示的な解除 */
  static async reset(store: StateStore): Promise<void> {
    await store.delete(STATE_KEYS.killSwitch);
  }
}
