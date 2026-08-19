import { setTimeout as delay } from "node:timers/promises";

/**
 * トークンバケット式レートリミッタ (gmo-coinから移植)。
 * OANDAのIP単位制限(120req/秒)に対して十分保守的な流量で使う。
 * 参照系と発注系で別インスタンスを作る。
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(requestsPerSecond: number) {
    this.capacity = requestsPerSecond;
    this.tokens = requestsPerSecond;
    this.refillPerMs = requestsPerSecond / 1000;
    this.lastRefill = performance.now();
  }

  /** トークンが確保できるまで待つ。呼び出し順は保証される。 */
  acquire(): Promise<void> {
    const result = this.queue.then(() => this.waitForToken());
    // 前の待機が失敗しても後続を止めない
    this.queue = result.catch(() => {});
    return result;
  }

  private async waitForToken(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const needMs = (1 - this.tokens) / this.refillPerMs;
      await delay(Math.max(needMs, 5));
    }
  }

  private refill(): void {
    const now = performance.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (now - this.lastRefill) * this.refillPerMs,
    );
    this.lastRefill = now;
  }
}
