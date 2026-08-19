import type { StateStore } from "../src/safety/state.ts";

/**
 * D1ベースのStateStore。1キー=1行の独立UPDATE。
 *
 * D1を選ぶ理由 (gmo-coinでの実証済み判断): D1は強整合なので、キルスイッチを
 * 書き込んだ直後のtickから確実に見える。KVは伝播に最大60秒かかるため
 * 安全装置には使えない。
 *
 * gmo-coinの単一JSONブロブ実装は移植しない: supervisorとキルスイッチの
 * 書き込み競合の根源だった。key-value行なら競合自体が存在しない。
 */
export class D1StateStore implements StateStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM safety_state WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO safety_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .bind(key, value)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM safety_state WHERE key = ?").bind(key).run();
  }
}
