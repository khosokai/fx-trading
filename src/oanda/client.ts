import type { BidAskCandle } from "../core/candle.ts";
import { HttpClient, type HttpClientConfig } from "../httpClient.ts";
import type {
  AccountSummaryResponse,
  CandlesResponse,
  ClosePositionResponse,
  CreateOrderResponse,
  MarketOrderRequest,
  OpenPositionsResponse,
  OrderBookResponse,
  PendingOrdersResponse,
  PositionBookResponse,
  PricingResponse,
  TransactionsSinceIdResponse,
} from "./types.ts";

/**
 * OANDA v20 REST APIクライアント。
 * - 認証はBearerトークン (パーソナルアクセストークン)
 * - 発注はPOST前にintent記録+リトライ禁止が前提 (httpClient.tsの規則を参照)
 */

export type OandaEnv = "practice" | "live";

const BASE_URLS: Record<OandaEnv, string> = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

export interface OandaClientConfig {
  env: OandaEnv;
  token: string;
  accountId: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export type Granularity = "S5" | "M1" | "M5" | "M15" | "H1" | "H4" | "D";

export interface GetCandlesOptions {
  granularity: Granularity;
  count?: number;
  from?: Date;
  to?: Date;
  /** 未確定足も含めるか (デフォルトfalse = 確定足のみ) */
  includeIncomplete?: boolean;
}

export class OandaClient {
  private readonly http: HttpClient;
  private readonly accountId: string;

  constructor(config: OandaClientConfig) {
    const httpConfig: HttpClientConfig = {
      baseUrl: BASE_URLS[config.env],
      token: config.token,
      // OANDAのIP制限120req/秒に対して十分保守的な流量
      rateLimitGet: 10,
      rateLimitPost: 5,
    };
    if (config.fetchFn) httpConfig.fetchFn = config.fetchFn;
    if (config.timeoutMs !== undefined) httpConfig.timeoutMs = config.timeoutMs;
    this.http = new HttpClient(httpConfig);
    this.accountId = config.accountId;
  }

  /** Bid/AskのM1等ローソク足を取得してBidAskCandleに正規化する */
  async getCandles(instrument: string, opts: GetCandlesOptions): Promise<BidAskCandle[]> {
    const res = await this.http.request<CandlesResponse>({
      method: "GET",
      path: `/v3/instruments/${instrument}/candles`,
      query: {
        granularity: opts.granularity,
        price: "BA",
        count: opts.count,
        from: opts.from ? opts.from.getTime() / 1000 : undefined,
        to: opts.to ? opts.to.getTime() / 1000 : undefined,
      },
    });
    const out: BidAskCandle[] = [];
    for (const c of res.candles) {
      if (!c.complete && !opts.includeIncomplete) continue;
      if (!c.bid || !c.ask) continue;
      out.push({
        time: Math.round(Number(c.time) * 1000),
        bid: { o: Number(c.bid.o), h: Number(c.bid.h), l: Number(c.bid.l), c: Number(c.bid.c) },
        ask: { o: Number(c.ask.o), h: Number(c.ask.h), l: Number(c.ask.l), c: Number(c.ask.c) },
        volume: c.volume,
      });
    }
    return out;
  }

  async getAccountSummary(): Promise<AccountSummaryResponse> {
    return await this.http.request<AccountSummaryResponse>({
      method: "GET",
      path: `/v3/accounts/${this.accountId}/summary`,
    });
  }

  async getOpenPositions(): Promise<OpenPositionsResponse> {
    return await this.http.request<OpenPositionsResponse>({
      method: "GET",
      path: `/v3/accounts/${this.accountId}/openPositions`,
    });
  }

  /**
   * 成行注文。【重要】この呼び出しの前に必ずorders_intentへの記録を行い、
   * ネットワークエラー時はリトライせず transactions/sinceid で照合すること。
   */
  async createMarketOrder(order: MarketOrderRequest): Promise<CreateOrderResponse> {
    return await this.http.request<CreateOrderResponse>({
      method: "POST",
      path: `/v3/accounts/${this.accountId}/orders`,
      body: { order },
    });
  }

  async getTransactionsSince(sinceId: string): Promise<TransactionsSinceIdResponse> {
    return await this.http.request<TransactionsSinceIdResponse>({
      method: "GET",
      path: `/v3/accounts/${this.accountId}/transactions/sinceid`,
      query: { id: sinceId },
    });
  }

  async getPricing(instruments: string[]): Promise<PricingResponse> {
    return await this.http.request<PricingResponse>({
      method: "GET",
      path: `/v3/accounts/${this.accountId}/pricing`,
      query: { instruments: instruments.join(",") },
    });
  }

  async getPendingOrders(): Promise<PendingOrdersResponse> {
    return await this.http.request<PendingOrdersResponse>({
      method: "GET",
      path: `/v3/accounts/${this.accountId}/pendingOrders`,
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.http.request({
      method: "PUT",
      path: `/v3/accounts/${this.accountId}/orders/${orderId}/cancel`,
    });
  }

  /** ポジション全決済 (キルスイッチのflatten用)。longUnits/shortUnits = "ALL" */
  async closePosition(
    instrument: string,
    opts: { longUnits?: "ALL" | "NONE"; shortUnits?: "ALL" | "NONE" },
  ): Promise<ClosePositionResponse> {
    return await this.http.request<ClosePositionResponse>({
      method: "PUT",
      path: `/v3/accounts/${this.accountId}/positions/${instrument}/close`,
      body: {
        longUnits: opts.longUnits ?? "NONE",
        shortUnits: opts.shortUnits ?? "NONE",
      },
    });
  }

  async getOrderBook(instrument: string, time?: Date): Promise<OrderBookResponse> {
    return await this.http.request<OrderBookResponse>({
      method: "GET",
      path: `/v3/instruments/${instrument}/orderBook`,
      query: { time: time ? time.getTime() / 1000 : undefined },
    });
  }

  async getPositionBook(instrument: string, time?: Date): Promise<PositionBookResponse> {
    return await this.http.request<PositionBookResponse>({
      method: "GET",
      path: `/v3/instruments/${instrument}/positionBook`,
      query: { time: time ? time.getTime() / 1000 : undefined },
    });
  }
}

/** 環境変数からクライアントを構築する (Node / Workers共通) */
export function oandaClientFromEnv(): OandaClient {
  const env = (process.env["OANDA_ENV"] ?? "practice") as OandaEnv;
  const token = process.env["OANDA_API_TOKEN"];
  const accountId = process.env["OANDA_ACCOUNT_ID"];
  if (!token || !accountId) {
    throw new Error("OANDA_API_TOKEN / OANDA_ACCOUNT_ID が設定されていません");
  }
  if (env !== "practice" && env !== "live") {
    throw new Error(`OANDA_ENV が不正です: ${env}`);
  }
  return new OandaClient({ env, token, accountId });
}
