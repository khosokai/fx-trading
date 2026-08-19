import { aggregateClosed } from "../core/aggregate.ts";
import { TF_MS, type BidAskCandle } from "../core/candle.ts";
import { pipSize, pipValueJpyPerUnit, quoteCurrency } from "../core/pips.ts";
import { isWeekendClosed } from "../core/sessions.ts";
import type { Signal, StrategyContext } from "../core/strategy.ts";
import { isAmbiguousSendError } from "../httpClient.ts";
import type { OandaClient } from "../oanda/client.ts";
import type { SafetyConfig } from "../safety/config.ts";
import type { Notifier } from "../safety/notifier.ts";
import type { RiskManager } from "../safety/riskManager.ts";
import { STATE_KEYS, type StateStore } from "../safety/state.ts";
import { buildActiveStrategies, type ActiveStrategy } from "./paramsRegistry.ts";
import type { BotDb } from "./ports.ts";

/**
 * ライブ取引ボット (毎分cronのtick)。gmo-coinのtradingBotの設計原則を踏襲:
 * - バックテストと同一のStrategyを実行する (パリティ原則)
 * - ポジションは毎回OANDAから導出する (プロセス内状態に依存しない)
 * - デフォルトはドライラン。BOT_LIVE="true" のときだけ実発注
 *
 * tickシーケンス (docs/architecture.md):
 * 1. キルスイッチ確認 → 2. 週末確認 → 3. transaction照合 (発注検討より必ず先)
 * → 4. M1取得+集計 → 5. バーゲート → 6. ポジション導出 → 7. 判定
 * → 8. リスクチェック → 9. 発注 (intent先行INSERT, POSTリトライ禁止)
 * → 10. スナップショット
 *
 * 死亡セマンティクス: decisions INSERT (ゲート) → intent INSERT → POST の
 * 順序により、途中でWorkerが死んだ場合は常に機会損失側に倒れる。
 * サイレントスキップは「decisionあり・intentなし」としてGUIが検出する。
 */

export interface BotDeps {
  client: OandaClient;
  db: BotDb;
  store: StateStore;
  riskManager: RiskManager;
  /** ハードリミット。GUI編集可能なentry.riskPctはここのmaxRiskPctでクランプされる */
  safetyConfig: SafetyConfig;
  notifier: Notifier;
  live: boolean;
}

export interface TickResult {
  skipped: string | null;
  decisionsMade: number;
  ordersPlaced: number;
  errors: string[];
}

export async function runOnce(deps: BotDeps, nowMs: number = Date.now()): Promise<TickResult> {
  const { client, db, store, riskManager, notifier, live } = deps;
  const result: TickResult = { skipped: null, decisionsMade: 0, ordersPlaced: 0, errors: [] };

  // 1. キルスイッチ
  const ks = await store.get(STATE_KEYS.killSwitch);
  if (ks !== null && (JSON.parse(ks) as { active?: boolean }).active) {
    result.skipped = "killSwitch";
    return result;
  }

  // 2. 週末
  if (isWeekendClosed(nowMs)) {
    result.skipped = "weekend";
    return result;
  }

  // 3. transaction照合 (新規発注の検討より必ず先に行う。
  //    POSTが結果不明で終わった前回tickの回復パス)
  await reconcile(deps, nowMs);

  // パラメータと戦略の構築
  const paramsRow = await db.getParams();
  if (!paramsRow) {
    result.skipped = "no-params";
    return result;
  }
  const active = buildActiveStrategies(paramsRow.doc);
  if (active.length === 0) {
    result.skipped = "no-active-strategies";
    return result;
  }

  // 4. 口座情報とポジション (毎回OANDAから導出)
  const summary = await client.getAccountSummary();
  const nav = Number(summary.account.NAV);
  const marginUsed = Number(summary.account.marginUsed);
  const positions = await client.getOpenPositions();
  const netUnitsByInstrument = new Map<string, number>();
  for (const p of positions.positions) {
    netUnitsByInstrument.set(p.instrument, Number(p.long.units) + Number(p.short.units));
  }
  let totalAbsUnits = 0;
  for (const u of netUnitsByInstrument.values()) totalAbsUnits += Math.abs(u);

  // インストルメントごとにM1取得は1回にまとめる
  const instruments = [...new Set(active.map((a) => a.entry.instrument))];
  const m1ByInstrument = new Map<string, BidAskCandle[]>();
  const pricing = await client.getPricing(instruments);
  for (const instrument of instruments) {
    // 最大warmup×15分足ぶんのM1 + 余裕 (count上限5000)
    const maxWarmupBars = Math.max(
      ...active
        .filter((a) => a.entry.instrument === instrument)
        .map((a) => (a.strategy.warmup + 10) * (TF_MS[a.strategy.timeframe] / TF_MS.M1)),
    );
    const count = Math.min(5000, Math.ceil(maxWarmupBars) + 30);
    m1ByInstrument.set(instrument, await client.getCandles(instrument, { granularity: "M1", count }));
  }

  for (const activeStrategy of active) {
    try {
      const placed = await runStrategyTick(deps, {
        activeStrategy,
        m1: m1ByInstrument.get(activeStrategy.entry.instrument) ?? [],
        pricing,
        nav,
        marginUsed,
        netUnits: netUnitsByInstrument.get(activeStrategy.entry.instrument) ?? 0,
        totalAbsUnits,
        paramVersion: paramsRow.version,
        nowMs,
      });
      if (placed !== null) {
        result.decisionsMade += 1;
        if (placed) result.ordersPlaced += 1;
      }
    } catch (err) {
      const message = `${activeStrategy.strategy.id}: ${err instanceof Error ? err.message : err}`;
      result.errors.push(message);
      await notifier.warn(`tickエラー ${message}`);
    }
  }

  // 10. スナップショット
  const price = pricing.prices[0];
  const spreadPips = price
    ? (Number(price.asks[0]?.price ?? 0) - Number(price.bids[0]?.price ?? 0)) /
      pipSize(price.instrument)
    : undefined;
  const snapshot = {
    ts: new Date(nowMs).toISOString(),
    nav,
    balance: Number(summary.account.balance),
    marginUsed,
    unrealizedPl: Number(summary.account.unrealizedPL),
    openUnits: totalAbsUnits,
    ...(spreadPips !== undefined ? { spreadPips } : {}),
  };
  await db.insertEquitySnapshot(snapshot);

  return result;
}

/** POST前に死んだpending intentをunknownへ降格するまでの猶予 */
const PENDING_TO_UNKNOWN_MS = 90_000;
/** unknownをorphan確定するまでの猶予 (OANDA側の遅延処理txnが台帳に載るのを待つ) */
const UNKNOWN_TO_ORPHAN_MS = 180_000;

/**
 * transactions/sinceid で台帳を取り込み、unknown intentを解決する。
 * (テストのためexport。runOnceの一部としてのみ呼ばれる)
 *
 * 【重要】unknownの解決は揮発的な res.transactions ではなく、永続化済みの
 * oanda_transactions 台帳 (client_order_id) に対して行う。カーソル前進と
 * intent解決の間でWorkerが死んでも、次tickで台帳から正しくfilledと判定できる
 * (レスポンスだけ見ると「もう返ってこないtxn」を根拠に誤orphanしてしまう)。
 */
export async function reconcile(deps: BotDeps, nowMs: number = Date.now()): Promise<void> {
  const { client, db, store, notifier } = deps;
  const lastId = await store.get(STATE_KEYS.lastTransactionId);
  if (lastId === null) {
    // 初回: 現在のlastTransactionIDから開始 (過去の取込はしない)
    const summary = await client.getAccountSummary();
    await store.set(STATE_KEYS.lastTransactionId, summary.lastTransactionID);
    return;
  }
  const res = await client.getTransactionsSince(lastId);
  if (res.transactions.length > 0) {
    await db.ingestTransactions(res.transactions);
  }
  // カーソルは取り込み成功の後にのみ前進 (途中で死んでも再取り込みは冪等)
  await store.set(STATE_KEYS.lastTransactionId, res.lastTransactionID);

  // unknown intent の解決: 永続台帳にclientOrderIDが現れたか
  const unknowns = await db.listIntentsByStatus("unknown");
  for (const intent of unknowns) {
    const txn = await db.findTransactionByClientOrderId(intent.clientId);
    if (txn) {
      await db.updateIntent(intent.clientId, { status: "filled", oandaTxnId: txn.id });
      await notifier.warn(
        `結果不明だった発注 ${intent.clientId} は約定していました (txn ${txn.id})`,
      );
    } else if (Date.parse(intent.ts) < nowMs - UNKNOWN_TO_ORPHAN_MS) {
      // 猶予を過ぎても台帳に現れない = サーバーに届いていなかった (機会損失側)
      await db.updateIntent(intent.clientId, { status: "orphaned" });
      await notifier.info(`結果不明だった発注 ${intent.clientId} は未達と確認 (orphaned)`);
    }
    // 猶予内は unknown のまま次tickへ持ち越す (遅延処理の約定を待つ)
  }
  // pendingのまま残っているintent (POST前にWorkerが死んだ) はunknown扱いに落とす
  const pendings = await db.listIntentsByStatus("pending");
  for (const intent of pendings) {
    if (Date.parse(intent.ts) < nowMs - PENDING_TO_UNKNOWN_MS) {
      await db.updateIntent(intent.clientId, { status: "unknown" });
    }
  }
}

interface StrategyTickInput {
  activeStrategy: ActiveStrategy;
  m1: BidAskCandle[];
  pricing: Awaited<ReturnType<OandaClient["getPricing"]>>;
  nav: number;
  marginUsed: number;
  netUnits: number;
  totalAbsUnits: number;
  paramVersion: number;
  nowMs: number;
}

/** 1戦略ぶんのtick。判定しなかったらnull、判定したら発注有無を返す */
async function runStrategyTick(deps: BotDeps, input: StrategyTickInput): Promise<boolean | null> {
  const { client, db, riskManager, notifier, live } = deps;
  const { strategy, entry } = input.activeStrategy;
  const instrument = entry.instrument;
  const pip = pipSize(instrument);

  // 4b. M1→戦略時間軸へ集計 (確定足のみ)
  const candles = aggregateClosed(input.m1, strategy.timeframe);
  if (candles.length <= strategy.warmup + 1) return null;
  const index = candles.length - 1;
  const bar = candles[index]!;

  // 6. ポジション方向
  const position: Signal = input.netUnits > 0 ? 1 : input.netUnits < 0 ? -1 : 0;

  // 7. 判定 (バックテストと同一のdecide)
  const ctx: StrategyContext = {
    instrument,
    candles,
    index,
    htf: {},
    htfIndex: {},
    position,
  };
  const decision = strategy.decide(ctx);
  const action =
    decision.target === position
      ? "none"
      : position === 0
        ? "open"
        : decision.target === 0
          ? "close"
          : "reverse";

  // 5. バーゲート (INSERT OR IGNORE)。既に処理済みのバーならスキップ。
  //    「最新の未処理確定足を処理する」= cronが足確定より先に発火したtickでは
  //    前の足のバーゲートに弾かれてno-opになり、次のtickで新しい足を処理する
  const decisionId = await db.gateDecision({
    ts: new Date(input.nowMs).toISOString(),
    strategyId: strategy.id,
    instrument,
    barTime: bar.time,
    closeBid: bar.bid.c,
    closeAsk: bar.ask.c,
    position,
    target: decision.target,
    action,
    ...(decision.stopLossPips !== undefined ? { slPips: decision.stopLossPips } : {}),
    ...(decision.takeProfitPips !== undefined ? { tpPips: decision.takeProfitPips } : {}),
    status: live ? "ok" : "dry_run",
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    paramVersion: input.paramVersion,
    live,
  });
  if (decisionId === null) return null; // このバーは処理済み
  if (action === "none") return false;

  // 現在価格とスプレッド
  const price = input.pricing.prices.find((p) => p.instrument === instrument);
  if (!price || !price.tradeable) {
    await db.updateDecision(decisionId, { status: "blocked", reason: "not tradeable" });
    return false;
  }
  const bid = Number(price.bids[0]?.price ?? price.closeoutBid);
  const ask = Number(price.asks[0]?.price ?? price.closeoutAsk);
  const spreadPips = (ask - bid) / pip;

  if (!live) {
    await notifier.info(
      `[DRY] ${strategy.id} ${instrument} ${action} target=${decision.target} ` +
        `(bid=${bid} ask=${ask} spread=${spreadPips.toFixed(1)}p)`,
    );
    return false;
  }

  // 決済 (close / reverseの決済側)。PUTはリトライ可 (冪等に近い)
  if (position !== 0 && decision.target !== position) {
    await client.closePosition(instrument, position === 1 ? { longUnits: "ALL" } : { shortUnits: "ALL" });
    await notifier.info(`${strategy.id} ${instrument} ポジションクローズ (${action})`);
    if (decision.target === 0) return false;
  }

  // 新規エントリー (open / reverseの新規側)
  const slPips = decision.stopLossPips;
  if (slPips === undefined || !(slPips > 0)) {
    await db.updateDecision(decisionId, { status: "error", reason: "SLなしエントリーを拒否" });
    await notifier.warn(`${strategy.id} がSLなしでエントリーしようとしたため拒否`);
    return false;
  }

  // サイジング (エンジンと同じ式)。GUI編集可能なriskPctは
  // ハードリミットSAFETY_MAX_RISK_PCTで必ずクランプする (タイプミス防衛)
  const usdJpy = await resolveUsdJpyRate(client, instrument, input.pricing);
  const pipValue = pipValueJpyPerUnit(instrument, usdJpy);
  const riskFraction = clamp01(decision.riskFraction ?? 1);
  const riskPct = Math.min(entry.riskPct, deps.safetyConfig.maxRiskPct);
  const riskBudget = input.nav * (riskPct / 100) * riskFraction;
  let units = Math.floor(riskBudget / (slPips * pipValue));
  units = Math.min(units, Math.floor((input.nav * 25) / ((ask * pipValue) / pip)));
  if (units < 1) {
    await db.updateDecision(decisionId, { status: "blocked", reason: "units<1" });
    return false;
  }
  const signedUnits = decision.target === 1 ? units : -units;
  const entryPrice = decision.target === 1 ? ask : bid;

  // 8. ハードリミット (キルスイッチ再チェック込み)
  const notionalJpy = (entryPrice * pipValue) / pip; // 1unitあたりのJPY想定元本
  const check = await riskManager.checkOrder({
    instrument,
    units: signedUnits,
    price: entryPrice,
    refPrice: (bar.bid.c + bar.ask.c) / 2,
    spreadPips,
    currentTotalUnits: input.totalAbsUnits,
    marginUsedPctAfter:
      input.nav > 0 ? ((input.marginUsed + (notionalJpy * units) / 25) / input.nav) * 100 : 100,
    nowMs: input.nowMs,
  });
  if (!check.ok) {
    await db.updateDecision(decisionId, { status: "blocked", reason: check.reason });
    await notifier.info(`発注ブロック ${strategy.id}: ${check.reason}`);
    return false;
  }

  // 9. 発注: intentを必ずPOSTの前にINSERTする
  const clientId = `fx-${strategy.id}-${bar.time}`.slice(0, 120);
  const tpPrice =
    decision.takeProfitPips !== undefined && decision.takeProfitPips > 0
      ? round5(entryPrice + decision.target * decision.takeProfitPips * pip)
      : undefined;
  await db.insertIntent({
    clientId,
    ts: new Date(input.nowMs).toISOString(),
    instrument,
    units: signedUnits,
    slDistancePips: slPips,
    ...(tpPrice !== undefined ? { tpPrice } : {}),
    decisionId,
  });

  try {
    const res = await client.createMarketOrder({
      type: "MARKET",
      instrument,
      units: String(signedUnits),
      timeInForce: "FOK",
      positionFill: "DEFAULT",
      clientExtensions: { id: clientId, tag: strategy.id },
      tradeClientExtensions: { tag: strategy.id },
      // SLはdistance指定 (約定価格からの相対) — Workerが死んでもサーバー側で守られる
      stopLossOnFill: { distance: round5(slPips * pip).toString(), timeInForce: "GTC" },
      ...(tpPrice !== undefined
        ? { takeProfitOnFill: { price: tpPrice.toString(), timeInForce: "GTC" as const } }
        : {}),
    });
    if (res.orderFillTransaction) {
      await db.updateIntent(clientId, {
        status: "filled",
        ...(res.orderFillTransaction.orderID !== undefined
          ? { oandaOrderId: res.orderFillTransaction.orderID }
          : {}),
        oandaTxnId: res.orderFillTransaction.id,
      });
      await notifier.info(
        `約定 ${strategy.id} ${instrument} ${signedUnits}units @${res.orderFillTransaction.price} SL=${slPips.toFixed(1)}p`,
      );
    } else if (res.orderRejectTransaction || res.orderCancelTransaction) {
      const reason =
        res.orderRejectTransaction?.rejectReason ?? res.orderCancelTransaction?.reason ?? "unknown";
      await db.updateIntent(clientId, { status: "rejected" });
      await db.updateDecision(decisionId, { status: "error", reason: `発注拒否: ${reason}` });
      await notifier.warn(`発注拒否 ${strategy.id}: ${reason}`);
      return false;
    } else {
      await db.updateIntent(clientId, {
        status: "created",
        ...(res.orderCreateTransaction ? { oandaTxnId: res.orderCreateTransaction.id } : {}),
      });
    }
    await riskManager.recordOrder(input.nowMs);
    return true;
  } catch (err) {
    if (isAmbiguousSendError(err)) {
      // 【最重要】結果不明 → リトライ禁止。次tickのreconcileが解決する
      await db.updateIntent(clientId, { status: "unknown" });
      await notifier.critical(
        `発注結果が不明 (${clientId})。リトライせず次tickの照合で解決します: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
    await db.updateIntent(clientId, { status: "rejected" });
    throw err;
  }
}

/** 非JPYクォートのpip価値換算用にUSD/JPYレートを引く */
async function resolveUsdJpyRate(
  client: OandaClient,
  instrument: string,
  pricing: Awaited<ReturnType<OandaClient["getPricing"]>>,
): Promise<number | undefined> {
  if (quoteCurrency(instrument) === "JPY") return undefined;
  const inBatch = pricing.prices.find((p) => p.instrument === "USD_JPY");
  if (inBatch) return Number(inBatch.closeoutBid);
  const res = await client.getPricing(["USD_JPY"]);
  const p = res.prices[0];
  if (!p) throw new Error("USD/JPYレートを取得できませんでした");
  return Number(p.closeoutBid);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

/** 価格を小数5桁に丸める (OANDAのprecision要件対策の簡易版) */
function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}
