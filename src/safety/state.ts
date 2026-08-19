/**
 * 安全装置の永続状態。
 *
 * 【設計判断 — gmo-coinからの変更点】
 * gmo-coinは状態全体を単一JSONブロブで load→modify→save していたが、
 * これがsupervisorとキルスイッチの書き込み競合の根源だった。
 * 本プロジェクトは最初から key-value 行構造とし、各キーを独立に
 * 読み書きする。ブロブの全上書きは存在しないため競合自体が起こらない。
 *
 * 永続化先:
 * - ローカル実行: FileStateStore (data/state/ 配下にキーごとのJSONファイル)
 * - Cloudflare Workers: D1StateStore (worker/state.ts、1キー=1行)
 *   D1は強整合なのでキルスイッチが即時反映される (KVは伝播に最大60秒)。
 */

export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 状態キーの一覧 (タイポ防止のため必ずここを経由する) */
export const STATE_KEYS = {
  killSwitch: "killSwitch",
  daily: "daily",
  peakEquity: "peakEquity",
  orderTimestamps: "orderTimestamps",
  supervisor: "supervisor",
  lastTransactionId: "lastTransactionId",
} as const;

export interface KillSwitchState {
  active: boolean;
  reason: string;
  trippedAt: string;
}

export interface DailyState {
  /** FX取引日 (NY17:00区切り, sessions.tradingDay) */
  day: string;
  startEquity: number;
}

export interface SupervisorState {
  lastStatus: string | null;
  consecutiveFailures: number;
}

export async function getJson<T>(store: StateStore, key: string): Promise<T | null> {
  const raw = await store.get(key);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

export async function setJson(store: StateStore, key: string, value: unknown): Promise<void> {
  await store.set(key, JSON.stringify(value));
}

export async function isKillSwitchActive(store: StateStore): Promise<boolean> {
  const ks = await getJson<KillSwitchState>(store, STATE_KEYS.killSwitch);
  return ks?.active === true;
}

/** ローカル実行用: 1キー=1ファイルで保存する (単一プロセス前提) */
export class FileStateStore implements StateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private async fs() {
    return await import("node:fs/promises");
  }

  private filePath(key: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`不正な状態キー: ${key}`);
    return `${this.dir}/${key}.json`;
  }

  async get(key: string): Promise<string | null> {
    const fs = await this.fs();
    try {
      return await fs.readFile(this.filePath(key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const fs = await this.fs();
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(key), value, "utf8");
  }

  async delete(key: string): Promise<void> {
    const fs = await this.fs();
    try {
      await fs.unlink(this.filePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/** テスト用のインメモリ実装 */
export class MemoryStateStore implements StateStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
