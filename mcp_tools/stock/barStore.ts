import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DailyBar } from "./alpacaClient.ts";

export type Coverage = {
  symbol: string;
  firstDate: string;
  lastDate: string;
  backfilledAt: string;
  lastCheckedAt: string;
};

export interface BarStore {
  getCoverage(symbol: string): Promise<Coverage | undefined>;
  putCoverage(coverage: Coverage): Promise<void>;
  /** 最近 limit 根，按日期升序（最旧在前）。 */
  getBars(symbol: string, limit: number): Promise<DailyBar[]>;
  /** fromDate 起（含）的全部 bar，按日期升序。 */
  getBarsOnOrAfter(symbol: string, fromDate: string): Promise<DailyBar[]>;
  putBars(symbol: string, bars: DailyBar[]): Promise<void>;
  clearSymbol(symbol: string): Promise<void>;
}

type BarRow = { t: string; o: number; h: number; l: number; c: number; v: number; vw: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stock_bars (
  symbol TEXT NOT NULL,
  t      TEXT NOT NULL,
  o      REAL NOT NULL,
  h      REAL NOT NULL,
  l      REAL NOT NULL,
  c      REAL NOT NULL,
  v      REAL NOT NULL,
  vw     REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, t)
);
CREATE TABLE IF NOT EXISTS stock_bar_coverage (
  symbol         TEXT PRIMARY KEY,
  first_date     TEXT NOT NULL,
  last_date      TEXT NOT NULL,
  backfilled_at  TEXT NOT NULL,
  last_checked_at TEXT NOT NULL
);
`;

/**
 * SQLite 实现。日 K 是单机、只增不改、按 (symbol, date) 主键查的表格数据，
 * 用嵌入式库比外部数据库服务更合适：无需部署，无需连接管理。
 *
 * 需要 Node 的 --experimental-sqlite 标志（见 package.json 的 scripts）。
 */
export class SqliteBarStore implements BarStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** path 为 ":memory:" 时建内存库，供测试使用。 */
  static open(path: string): SqliteBarStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    return new SqliteBarStore(db);
  }

  close(): void {
    this.db.close();
  }

  async getCoverage(symbol: string): Promise<Coverage | undefined> {
    const row = this.db
      .prepare(
        "SELECT symbol, first_date, last_date, backfilled_at, last_checked_at FROM stock_bar_coverage WHERE symbol = ?",
      )
      .get(symbol) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      symbol: row["symbol"]!,
      firstDate: row["first_date"]!,
      lastDate: row["last_date"]!,
      backfilledAt: row["backfilled_at"]!,
      lastCheckedAt: row["last_checked_at"]!,
    };
  }

  async putCoverage(coverage: Coverage): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO stock_bar_coverage (symbol, first_date, last_date, backfilled_at, last_checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           first_date = excluded.first_date,
           last_date = excluded.last_date,
           backfilled_at = excluded.backfilled_at,
           last_checked_at = excluded.last_checked_at`,
      )
      .run(
        coverage.symbol,
        coverage.firstDate,
        coverage.lastDate,
        coverage.backfilledAt,
        coverage.lastCheckedAt,
      );
  }

  async getBars(symbol: string, limit: number): Promise<DailyBar[]> {
    const rows = this.db
      .prepare("SELECT t, o, h, l, c, v, vw FROM stock_bars WHERE symbol = ? ORDER BY t DESC LIMIT ?")
      .all(symbol, limit) as BarRow[];
    return rows.reverse();
  }

  async getBarsOnOrAfter(symbol: string, fromDate: string): Promise<DailyBar[]> {
    return this.db
      .prepare("SELECT t, o, h, l, c, v, vw FROM stock_bars WHERE symbol = ? AND t >= ? ORDER BY t ASC")
      .all(symbol, fromDate) as BarRow[];
  }

  async putBars(symbol: string, bars: DailyBar[]): Promise<void> {
    if (bars.length === 0) return;
    const updatedAt = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO stock_bars (symbol, t, o, h, l, c, v, vw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, t) DO UPDATE SET
         o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
         v = excluded.v, vw = excluded.vw, updated_at = excluded.updated_at`,
    );
    // 一次事务写入，5 年回补（约 1260 根）也只有一次 fsync
    this.db.exec("BEGIN");
    try {
      for (const bar of bars) {
        stmt.run(symbol, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v, bar.vw, updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async clearSymbol(symbol: string): Promise<void> {
    this.db.prepare("DELETE FROM stock_bars WHERE symbol = ?").run(symbol);
    this.db.prepare("DELETE FROM stock_bar_coverage WHERE symbol = ?").run(symbol);
  }
}
