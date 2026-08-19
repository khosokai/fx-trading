import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HttpClient, HttpStatusError, OandaApiError } from "../src/httpClient.ts";

/**
 * fetch注入によるHTTPクライアントの検証。
 * 最重要は「POSTのネットワーク断・タイムアウトはリトライしない」の回帰テスト
 * (OANDAの成行注文に冪等性がないため、これが崩れると二重発注リスクになる)。
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch): HttpClient {
  return new HttpClient({
    baseUrl: "https://api.example.test",
    token: "test-token",
    // テストを速くするため流量制限を事実上無効化
    rateLimitGet: 10_000,
    rateLimitPost: 10_000,
    timeoutMs: 5_000,
    fetchFn,
  });
}

describe("HttpClient", () => {
  it("正常系: Bearerヘッダ付きでJSONを返す", async () => {
    let capturedAuth: string | null = null;
    const client = makeClient(async (_url, init) => {
      capturedAuth = new Headers(init?.headers).get("Authorization");
      return jsonResponse(200, { ok: true });
    });
    const result = await client.request<{ ok: boolean }>({ method: "GET", path: "/v3/test" });
    assert.deepEqual(result, { ok: true });
    assert.equal(capturedAuth, "Bearer test-token");
  });

  it("GET: 429は指数バックオフでリトライして成功する", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(429, { errorMessage: "rate limit" });
      return jsonResponse(200, { ok: true });
    });
    const result = await client.request<{ ok: boolean }>({ method: "GET", path: "/v3/test" });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 3);
  });

  it("GET: ネットワーク断(TypeError)はリトライする", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(200, { ok: true });
    });
    await client.request({ method: "GET", path: "/v3/test" });
    assert.equal(calls, 2);
  });

  it("【回帰テスト】POST: ネットワーク断(TypeError)は絶対にリトライしない", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      client.request({ method: "POST", path: "/v3/accounts/x/orders", body: {} }),
      TypeError,
    );
    assert.equal(calls, 1, "POSTのネットワーク断がリトライされた: 二重発注リスク");
  });

  it("【回帰テスト】POST: タイムアウト(AbortError)も絶対にリトライしない", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    });
    await assert.rejects(client.request({ method: "POST", path: "/v3/x", body: {} }));
    assert.equal(calls, 1, "POSTのタイムアウトがリトライされた: 二重発注リスク");
  });

  it("POST: 429はサーバーが拒否済み(結果が明確)なのでリトライしてよい", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, { errorMessage: "rate limit" });
      return jsonResponse(201, { orderCreateTransaction: {} });
    });
    await client.request({ method: "POST", path: "/v3/x", body: {} });
    assert.equal(calls, 2);
  });

  it("4xx(429以外)はリトライせずOandaApiErrorを投げる", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return jsonResponse(400, { errorMessage: "Invalid instrument", errorCode: "INVALID" });
    });
    await assert.rejects(client.request({ method: "GET", path: "/v3/test" }), (err: unknown) => {
      assert.ok(err instanceof OandaApiError);
      assert.equal(err.httpStatus, 400);
      assert.equal(err.errorCode, "INVALID");
      return true;
    });
    assert.equal(calls, 1);
  });

  it("JSONでないエラーボディはHttpStatusErrorになる", async () => {
    const client = makeClient(async () => new Response("<html>not found</html>", { status: 404 }));
    await assert.rejects(
      client.request({ method: "GET", path: "/v3/test" }),
      (err: unknown) => err instanceof HttpStatusError && err.httpStatus === 404,
    );
  });
});
