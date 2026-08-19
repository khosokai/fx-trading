import { isRolloverBlackout, tradingDay } from "../core/sessions.ts";
import type { SafetyConfig } from "./config.ts";
import {
  STATE_KEYS,
  getJson,
  setJson,
  type DailyState,
  type KillSwitchState,
  type StateStore,
} from "./state.ts";

/**
 * ハードリミットの判定 (gmo-coinから移植・FX翻案)。
 * 戦略やパラメータからの入力が何であれ、ここを通らない注文は発注層で拒否される。
 * 発注頻度カウンタもStateStoreに永続化する (Workersではプロセス状態が残らないため)。
 */

export interface OrderCheckRequest {
  instrument: string;
  /** 符号付きユニット数 (正=買い, 負=売り) */
  units: number;
  /** 発注時の参照価格 (成行なら現在の実勢) */
  price: number;
  /** 直近の確定足終値など、乖離チェックの基準価格 */
  refPrice: number;
  /** 現在のスプレッド (pips) */
  spreadPips: number;
  /** 発注前の全ポジション合計ユニット (絶対値) */
  currentTotalUnits: number;
  /** 発注後の想定証拠金使用率 (%)。不明ならundefined (チェックはスキップ) */
  marginUsedPctAfter?: number;
  /** 判定時刻 (ms)。省略時は現在時刻 (バックテスト/テストで注入) */
  nowMs?: number;
}

export type OrderCheckResult = { ok: true } | { ok: false; reason: string };

export interface EquityCheck {
  /** キルスイッチを引くべき違反 (なければnull) */
  violation: string | null;
  dailyPnl: number;
  dailyPnlPct: number;
  drawdownPct: number;
}

export class RiskManager {
  private readonly config: SafetyConfig;
  private readonly store: StateStore;

  constructor(config: SafetyConfig, store: StateStore) {
    this.config = config;
    this.store = store;
  }

  /** 発注前チェック。すべてのハードリミットを通過した注文だけがokになる */
  async checkOrder(req: OrderCheckRequest): Promise<OrderCheckResult> {
    // POST直前の再チェック: tickの先頭で確認済みでも、長いハング中に
    // supervisorが発動している可能性がある (D1 read 1回の安価な保険)
    const ks = await getJson<KillSwitchState>(this.store, STATE_KEYS.killSwitch);
    if (ks?.active) {
      return { ok: false, reason: "キルスイッチ発動中" };
    }

    const now = req.nowMs ?? Date.now();
    const absUnits = Math.abs(req.units);

    if (absUnits > this.config.maxUnitsPerOrder) {
      return {
        ok: false,
        reason: `1注文の上限超過: ${absUnits} units > ${this.config.maxUnitsPerOrder} units`,
      };
    }

    if (req.currentTotalUnits + absUnits > this.config.maxTotalUnits) {
      return {
        ok: false,
        reason: `総ポジション上限超過: ${req.currentTotalUnits + absUnits} units > ${this.config.maxTotalUnits} units`,
      };
    }

    if (req.spreadPips > this.config.maxSpreadPips) {
      return {
        ok: false,
        reason: `スプレッド拡大中(見送り): ${req.spreadPips.toFixed(1)} pips > ${this.config.maxSpreadPips} pips`,
      };
    }

    if (isRolloverBlackout(now)) {
      return { ok: false, reason: "ロールオーバー帯(NY 16:55-17:10)のため新規発注ブラックアウト" };
    }

    const deviationPct = Math.abs(req.price / req.refPrice - 1) * 100;
    if (deviationPct > this.config.maxPriceDeviationPct) {
      return {
        ok: false,
        reason: `価格乖離が大きすぎる(誤発注疑い): ${deviationPct.toFixed(2)}% > ${this.config.maxPriceDeviationPct}%`,
      };
    }

    if (
      req.marginUsedPctAfter !== undefined &&
      req.marginUsedPctAfter > this.config.maxMarginUsedPct
    ) {
      return {
        ok: false,
        reason: `証拠金使用率の上限超過: ${req.marginUsedPctAfter.toFixed(1)}% > ${this.config.maxMarginUsedPct}%`,
      };
    }

    const timestamps = (await getJson<number[]>(this.store, STATE_KEYS.orderTimestamps)) ?? [];
    const oneHourAgo = now - 3600_000;
    if (timestamps.filter((t) => t > oneHourAgo).length >= this.config.maxOrdersPerHour) {
      return {
        ok: false,
        reason: `発注頻度の上限超過(暴走疑い): ${this.config.maxOrdersPerHour}回/時`,
      };
    }

    return { ok: true };
  }

  /** checkOrderが通り実際に発注した後に呼ぶ (頻度カウント用) */
  async recordOrder(nowMs: number = Date.now()): Promise<void> {
    const timestamps = (await getJson<number[]>(this.store, STATE_KEYS.orderTimestamps)) ?? [];
    const oneHourAgo = nowMs - 3600_000;
    await setJson(this.store, STATE_KEYS.orderTimestamps, [
      ...timestamps.filter((t) => t > oneHourAgo),
      nowMs,
    ]);
  }

  /**
   * NAVから日次損失・最大ドローダウンを判定する。
   * 取引日(NY17:00区切り)が変わったら基準をリセットし、過去最高資産を更新する。
   * 注意: 入出金があると基準がずれるため、入出金後は手動で状態リセット推奨。
   */
  async checkEquity(equityJpy: number, nowMs: number = Date.now()): Promise<EquityCheck> {
    const today = tradingDay(nowMs);

    let daily = await getJson<DailyState>(this.store, STATE_KEYS.daily);
    if (!daily || daily.day !== today) {
      daily = { day: today, startEquity: equityJpy };
      await setJson(this.store, STATE_KEYS.daily, daily);
    }

    const peakRaw = await getJson<number>(this.store, STATE_KEYS.peakEquity);
    const peak = Math.max(peakRaw ?? 0, equityJpy);
    if (peak !== peakRaw) {
      await setJson(this.store, STATE_KEYS.peakEquity, peak);
    }

    const dailyPnl = equityJpy - daily.startEquity;
    const dailyPnlPct = daily.startEquity > 0 ? (dailyPnl / daily.startEquity) * 100 : 0;
    const drawdownPct = peak > 0 ? (1 - equityJpy / peak) * 100 : 0;

    let violation: string | null = null;
    if (dailyPnlPct <= -this.config.dailyLossLimitPct) {
      violation = `日次損失上限: ${dailyPnlPct.toFixed(1)}% (上限 -${this.config.dailyLossLimitPct}%)`;
    } else if (drawdownPct >= this.config.maxDrawdownPct) {
      violation = `最大ドローダウン超過: -${drawdownPct.toFixed(1)}% (上限 -${this.config.maxDrawdownPct}%)`;
    }

    return { violation, dailyPnl, dailyPnlPct, drawdownPct };
  }
}
