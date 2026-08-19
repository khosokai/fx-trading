/**
 * OANDA v20 REST APIの型定義 (使用するエンドポイントのみ手書き)。
 * 公式OpenAPI仕様は2018年から更新されていないため、
 * developer.oanda.com のドキュメントに基づく。
 * 価格・数量はAPI仕様どおりすべて文字列。
 */

/** Accept-Datetime-Format: UNIX 時の時刻表現 (例: "1657234800.000000000") */
export type UnixTime = string;

export interface OandaCandlestick {
  complete: boolean;
  volume: number;
  time: UnixTime;
  bid?: OandaOhlc;
  ask?: OandaOhlc;
  mid?: OandaOhlc;
}

export interface OandaOhlc {
  o: string;
  h: string;
  l: string;
  c: string;
}

export interface CandlesResponse {
  instrument: string;
  granularity: string;
  candles: OandaCandlestick[];
}

export interface AccountSummaryResponse {
  account: {
    id: string;
    currency: string;
    balance: string;
    NAV: string;
    unrealizedPL: string;
    marginUsed: string;
    marginAvailable: string;
    openTradeCount: number;
    openPositionCount: number;
    pendingOrderCount: number;
    lastTransactionID: string;
  };
  lastTransactionID: string;
}

export interface PositionSide {
  units: string;
  averagePrice?: string;
  unrealizedPL: string;
  tradeIDs?: string[];
}

export interface OandaPosition {
  instrument: string;
  long: PositionSide;
  short: PositionSide;
  unrealizedPL: string;
}

export interface OpenPositionsResponse {
  positions: OandaPosition[];
  lastTransactionID: string;
}

export interface ClientExtensions {
  id?: string;
  tag?: string;
  comment?: string;
}

export interface MarketOrderRequest {
  type: "MARKET";
  instrument: string;
  /** 符号付き数量の文字列 (正=買い, 負=売り) */
  units: string;
  timeInForce: "FOK" | "IOC";
  positionFill: "DEFAULT" | "REDUCE_FIRST" | "REDUCE_ONLY" | "OPEN_ONLY";
  clientExtensions?: ClientExtensions;
  /** 約定した瞬間にサーバー側でSLが設定される (Workerが死んでも守られる) */
  stopLossOnFill?: { distance?: string; price?: string; timeInForce: "GTC" };
  takeProfitOnFill?: { price: string; timeInForce: "GTC" };
  tradeClientExtensions?: ClientExtensions;
}

/** Transaction: 型は多岐にわたるため必要フィールド + インデックスシグネチャ */
export interface OandaTransaction {
  id: string;
  time: UnixTime;
  type: string;
  accountID?: string;
  instrument?: string;
  units?: string;
  price?: string;
  pl?: string;
  financing?: string;
  reason?: string;
  orderID?: string;
  tradeID?: string;
  clientOrderID?: string;
  tradeOpened?: { tradeID: string; units: string; price: string };
  tradesClosed?: { tradeID: string; units: string; price: string; realizedPL: string }[];
  tradeReduced?: { tradeID: string; units: string; price: string; realizedPL: string };
  clientExtensions?: ClientExtensions;
  rejectReason?: string;
  [key: string]: unknown;
}

export interface CreateOrderResponse {
  orderCreateTransaction?: OandaTransaction;
  orderFillTransaction?: OandaTransaction;
  orderCancelTransaction?: OandaTransaction;
  orderRejectTransaction?: OandaTransaction;
  lastTransactionID: string;
}

export interface TransactionsSinceIdResponse {
  transactions: OandaTransaction[];
  lastTransactionID: string;
}

export interface PriceBucket {
  price: string;
  liquidity: number;
}

export interface ClientPrice {
  instrument: string;
  time: UnixTime;
  tradeable: boolean;
  bids: PriceBucket[];
  asks: PriceBucket[];
  closeoutBid: string;
  closeoutAsk: string;
}

export interface PricingResponse {
  prices: ClientPrice[];
  time: UnixTime;
}

export interface OrderBookBucket {
  price: string;
  longCountPercent: string;
  shortCountPercent: string;
}

export interface OrderBookResponse {
  orderBook: {
    instrument: string;
    time: UnixTime;
    price: string;
    bucketWidth: string;
    buckets: OrderBookBucket[];
  };
}

export interface PositionBookResponse {
  positionBook: {
    instrument: string;
    time: UnixTime;
    price: string;
    bucketWidth: string;
    buckets: OrderBookBucket[];
  };
}

export interface PendingOrder {
  id: string;
  type: string;
  instrument?: string;
  units?: string;
  clientExtensions?: ClientExtensions;
}

export interface PendingOrdersResponse {
  orders: PendingOrder[];
  lastTransactionID: string;
}

export interface ClosePositionResponse {
  longOrderFillTransaction?: OandaTransaction;
  shortOrderFillTransaction?: OandaTransaction;
  lastTransactionID: string;
}
