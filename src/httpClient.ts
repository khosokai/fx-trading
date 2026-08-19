import { setTimeout as delay } from "node:timers/promises";
import { RateLimiter } from "./rateLimiter.ts";

/**
 * OANDA v20 REST用HTTPクライアント (gmo-coinのhttpClientから移植・翻案)。
 * レートリミット遵守・Bearer認証・リトライ(指数バックオフ)を担う。
 *
 * 【最重要規則 — 変更禁止】
 * OANDAの成行注文にはサーバー側の冪等性保証がない (clientExtensions.idの
 * 重複拒否は注文がpendingの間のみで、即時約定する成行には効かない)。
 * そのためPOSTがネットワーク断/タイムアウトで失敗した場合、リクエストが
 * サーバーに到達済みか判別できず、リトライすると二重発注になりうる。
 * → POSTのネットワーク断・タイムアウトは絶対にリトライしない。
 *   回復は呼び出し側が transactions/sinceid で照合してから行う。
 */

/** OANDAがエラーJSONを返したとき (HTTP 4xx/5xx + errorMessage) */
export class OandaApiError extends Error {
  readonly httpStatus: number;
  readonly errorCode: string | undefined;

  constructor(httpStatus: number, errorMessage: string, errorCode?: string) {
    super(`OANDA API error (HTTP ${httpStatus}): ${errorMessage}`);
    this.name = "OandaApiError";
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
  }
}

/** JSONとして解釈できないHTTPエラー */
export class HttpStatusError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, bodyText: string) {
    super(`HTTP ${httpStatus}: ${bodyText.slice(0, 200)}`);
    this.name = "HttpStatusError";
    this.httpStatus = httpStatus;
  }
}

/** 429/5xx/ネットワーク断など、リトライで解消しうるエラーか */
function isRetryable(err: unknown): boolean {
  if (err instanceof OandaApiError) {
    return err.httpStatus === 429 || err.httpStatus >= 500;
  }
  if (err instanceof HttpStatusError) {
    return err.httpStatus === 429 || err.httpStatus >= 500;
  }
  // fetch失敗(TypeError) / タイムアウト(AbortError系)はリトライ対象
  return err instanceof TypeError || isAbortError(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** サーバーに届いた可能性があり、結果が不明なエラーか (POSTで致命的) */
export function isAmbiguousSendError(err: unknown): boolean {
  return err instanceof TypeError || isAbortError(err);
}

export interface HttpClientConfig {
  baseUrl: string;
  /** OANDAパーソナルアクセストークン */
  token: string;
  /** 参照系の流量 (req/秒) */
  rateLimitGet?: number;
  /** 発注系の流量 (req/秒) */
  rateLimitPost?: number;
  /** リクエストタイムアウト (ms)。短めに保ち、次tickの照合で回復する */
  timeoutMs?: number;
  /** テスト用のfetch差し替え */
  fetchFn?: typeof fetch;
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string; // "/v3/..." クエリなし
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const MAX_ATTEMPTS = 4;

export class HttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly getLimiter: RateLimiter;
  private readonly postLimiter: RateLimiter;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchFn = config.fetchFn ?? fetch;
    this.getLimiter = new RateLimiter(config.rateLimitGet ?? 10);
    this.postLimiter = new RateLimiter(config.rateLimitPost ?? 5);
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const limiter = opts.method === "GET" ? this.getLimiter : this.postLimiter;
      await limiter.acquire();
      try {
        return await this.requestOnce<T>(opts);
      } catch (err) {
        lastError = err;
        // 発注(POST)は二重発注を避けるため、結果不明のエラーではリトライしない
        const doubleSendRisk = opts.method === "POST" && isAmbiguousSendError(err);
        if (!isRetryable(err) || doubleSendRisk || attempt === MAX_ATTEMPTS) throw err;
        await delay(500 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  private async requestOnce<T>(opts: RequestOptions): Promise<T> {
    const url = this.baseUrl + opts.path + buildQuery(opts.query);
    const bodyText = opts.body === undefined ? null : JSON.stringify(opts.body);

    const res = await this.fetchFn(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Accept-Datetime-Format": "UNIX",
      },
      body: bodyText,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      try {
        const json = JSON.parse(text) as { errorMessage?: string; errorCode?: string };
        if (json.errorMessage !== undefined) {
          throw new OandaApiError(res.status, json.errorMessage, json.errorCode);
        }
      } catch (err) {
        if (err instanceof OandaApiError) throw err;
        // JSONでなければ素のHTTPエラーとして投げる
      }
      throw new HttpStatusError(res.status, text);
    }
    return JSON.parse(text) as T;
  }
}

function buildQuery(
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}
