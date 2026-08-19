import type { BidAskCandle } from "../core/candle.ts";

/**
 * ローソク足のローカルストレージ。
 * 形式: 月次 gzip カラムナJSON (data/candles/USD_JPY/M1/2024-03.json.gz)。
 * M1で5年×2ペア ≈ 190万本×2 でも合計60MB程度に収まり、依存はnode:zlibのみ。
 *
 * 保存はM1のみ。上位足は必ず共通のaggregate.tsで作る (パリティ原則)。
 */

export interface CandleSource {
  /** [from, to) のM1足を時刻昇順で返す */
  load(instrument: string, from: Date, to: Date): Promise<BidAskCandle[]>;
}

export interface ChunkFile {
  v: 1;
  instrument: string;
  tf: "M1";
  /** "YYYY-MM" (UTC) */
  month: string;
  t: number[];
  bo: number[];
  bh: number[];
  bl: number[];
  bc: number[];
  ao: number[];
  ah: number[];
  al: number[];
  ac: number[];
  vol: number[];
}

export function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** 月キーの列挙 [fromMonth, toMonth] (両端含む) */
export function monthRange(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const from = new Date(fromMs);
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const last = monthKey(toMs);
  for (;;) {
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    out.push(key);
    if (key === last) break;
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
    if (out.length > 1200) throw new Error("monthRange: 範囲が広すぎます");
  }
  return out;
}

export function encodeChunk(instrument: string, month: string, candles: BidAskCandle[]): ChunkFile {
  const chunk: ChunkFile = {
    v: 1,
    instrument,
    tf: "M1",
    month,
    t: [],
    bo: [],
    bh: [],
    bl: [],
    bc: [],
    ao: [],
    ah: [],
    al: [],
    ac: [],
    vol: [],
  };
  for (const c of candles) {
    chunk.t.push(c.time);
    chunk.bo.push(c.bid.o);
    chunk.bh.push(c.bid.h);
    chunk.bl.push(c.bid.l);
    chunk.bc.push(c.bid.c);
    chunk.ao.push(c.ask.o);
    chunk.ah.push(c.ask.h);
    chunk.al.push(c.ask.l);
    chunk.ac.push(c.ask.c);
    chunk.vol.push(c.volume);
  }
  return chunk;
}

export function decodeChunk(chunk: ChunkFile): BidAskCandle[] {
  if (chunk.v !== 1) throw new Error(`未知のチャンクバージョン: ${chunk.v}`);
  const out: BidAskCandle[] = [];
  for (let i = 0; i < chunk.t.length; i++) {
    out.push({
      time: chunk.t[i]!,
      bid: { o: chunk.bo[i]!, h: chunk.bh[i]!, l: chunk.bl[i]!, c: chunk.bc[i]! },
      ask: { o: chunk.ao[i]!, h: chunk.ah[i]!, l: chunk.al[i]!, c: chunk.ac[i]! },
      volume: chunk.vol[i]!,
    });
  }
  return out;
}

/**
 * Node専用のファイル実装。Workersからはimportしないこと
 * (node:fs / node:zlib は動的importで隔離している)。
 */
export class LocalChunkStore implements CandleSource {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(instrument: string, month: string): string {
    return `${this.baseDir}/${instrument}/M1/${month}.json.gz`;
  }

  async load(instrument: string, from: Date, to: Date): Promise<BidAskCandle[]> {
    const fs = await import("node:fs/promises");
    const zlib = await import("node:zlib");
    const out: BidAskCandle[] = [];
    for (const month of monthRange(from.getTime(), to.getTime())) {
      let buf: Buffer;
      try {
        buf = await fs.readFile(this.filePath(instrument, month));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      // toString()はデフォルトutf8。引数を渡すとworkers-types併用時に型が衝突する
      const chunk = JSON.parse(zlib.gunzipSync(buf).toString()) as ChunkFile;
      for (const c of decodeChunk(chunk)) {
        if (c.time >= from.getTime() && c.time < to.getTime()) out.push(c);
      }
    }
    return out;
  }

  /** M1足を月ごとに分割して保存する (既存の同月ファイルは上書き) */
  async save(instrument: string, candles: BidAskCandle[]): Promise<void> {
    if (candles.length === 0) return;
    const fs = await import("node:fs/promises");
    const zlib = await import("node:zlib");

    const byMonth = new Map<string, BidAskCandle[]>();
    for (const c of candles) {
      const key = monthKey(c.time);
      let list = byMonth.get(key);
      if (!list) {
        list = [];
        byMonth.set(key, list);
      }
      list.push(c);
    }

    for (const [month, list] of byMonth) {
      const dir = `${this.baseDir}/${instrument}/M1`;
      await fs.mkdir(dir, { recursive: true });
      const json = JSON.stringify(encodeChunk(instrument, month, list));
      await fs.writeFile(this.filePath(instrument, month), zlib.gzipSync(json));
    }
  }

  /** 保存済みの月キー一覧 (昇順) */
  async listMonths(instrument: string): Promise<string[]> {
    const fs = await import("node:fs/promises");
    try {
      const files = await fs.readdir(`${this.baseDir}/${instrument}/M1`);
      return files
        .filter((f) => f.endsWith(".json.gz"))
        .map((f) => f.replace(".json.gz", ""))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
