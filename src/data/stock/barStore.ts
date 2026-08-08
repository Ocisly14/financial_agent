import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BarFeed, DailyBar, Timeframe } from "./alpacaClient.ts";

export type Coverage = {
  symbol: string;
  timeframe: Timeframe;
  /** Which tape the bars came from. IEX and SIP disagree on the same day's close — one is a single
   *  exchange, the other the consolidated tape — so they are cached side by side, never merged. */
  feed: BarFeed;
  firstDate: string;
  lastDate: string;
  backfilledAt: string;
  lastCheckedAt: string;
};

export interface BarStore {
  getCoverage(symbol: string, timeframe: Timeframe, feed: BarFeed): Promise<Coverage | undefined>;
  putCoverage(coverage: Coverage): Promise<void>;
  /** The most recent `limit` bars, ascending by date (oldest first). */
  getBars(symbol: string, timeframe: Timeframe, feed: BarFeed, limit: number): Promise<DailyBar[]>;
  /** All bars from fromDate onward (inclusive), ascending by date. */
  getBarsOnOrAfter(symbol: string, timeframe: Timeframe, feed: BarFeed, fromDate: string): Promise<DailyBar[]>;
  putBars(symbol: string, timeframe: Timeframe, feed: BarFeed, bars: DailyBar[]): Promise<void>;
  clearSymbol(symbol: string, timeframe: Timeframe, feed: BarFeed): Promise<void>;
}

type BarRow = { t: string; o: number; h: number; l: number; c: number; v: number; vw: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stock_bars (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  feed   TEXT NOT NULL,
  t      TEXT NOT NULL,
  o      REAL NOT NULL,
  h      REAL NOT NULL,
  l      REAL NOT NULL,
  c      REAL NOT NULL,
  v      REAL NOT NULL,
  vw     REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, feed, t)
);
CREATE TABLE IF NOT EXISTS stock_bar_coverage (
  symbol         TEXT NOT NULL,
  timeframe      TEXT NOT NULL,
  feed           TEXT NOT NULL,
  first_date     TEXT NOT NULL,
  last_date      TEXT NOT NULL,
  backfilled_at  TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, feed)
);
`;

/** Cached bars are a rebuildable copy of a vendor API, so a missing column is dropped and refetched
 *  rather than migrated. */
function hasLegacySchema(db: DatabaseSync, table: string): boolean {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  return !names.has("timeframe") || !names.has("feed");
}

/**
 * SQLite implementation. Daily bars are single-machine, append-only, tabular data queried by
 * a (symbol, date) primary key, which suits an embedded library better than an external
 * database service: no deployment, no connection management.
 *
 * Requires Node's --experimental-sqlite flag (see package.json scripts).
 */
export class SqliteBarStore implements BarStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Builds an in-memory database when path is ":memory:", for use in tests. */
  static open(path: string): SqliteBarStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    if (hasLegacySchema(db, "stock_bars") || hasLegacySchema(db, "stock_bar_coverage")) {
      db.exec("DROP TABLE IF EXISTS stock_bars; DROP TABLE IF EXISTS stock_bar_coverage;");
    }
    db.exec(SCHEMA);
    return new SqliteBarStore(db);
  }

  close(): void {
    this.db.close();
  }

  async getCoverage(symbol: string, timeframe: Timeframe, feed: BarFeed): Promise<Coverage | undefined> {
    const row = this.db
      .prepare(
        "SELECT symbol, timeframe, feed, first_date, last_date, backfilled_at, last_checked_at FROM stock_bar_coverage WHERE symbol = ? AND timeframe = ? AND feed = ?",
      )
      .get(symbol, timeframe, feed) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      symbol: row["symbol"]!,
      timeframe: row["timeframe"]! as Timeframe,
      feed: row["feed"]! as BarFeed,
      firstDate: row["first_date"]!,
      lastDate: row["last_date"]!,
      backfilledAt: row["backfilled_at"]!,
      lastCheckedAt: row["last_checked_at"]!,
    };
  }

  async putCoverage(coverage: Coverage): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO stock_bar_coverage (symbol, timeframe, feed, first_date, last_date, backfilled_at, last_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, timeframe, feed) DO UPDATE SET
           first_date = excluded.first_date,
           last_date = excluded.last_date,
           backfilled_at = excluded.backfilled_at,
           last_checked_at = excluded.last_checked_at`,
      )
      .run(
        coverage.symbol,
        coverage.timeframe,
        coverage.feed,
        coverage.firstDate,
        coverage.lastDate,
        coverage.backfilledAt,
        coverage.lastCheckedAt,
      );
  }

  async getBars(symbol: string, timeframe: Timeframe, feed: BarFeed, limit: number): Promise<DailyBar[]> {
    const rows = this.db
      .prepare("SELECT t, o, h, l, c, v, vw FROM stock_bars WHERE symbol = ? AND timeframe = ? AND feed = ? ORDER BY t DESC LIMIT ?")
      .all(symbol, timeframe, feed, limit) as BarRow[];
    return rows.reverse();
  }

  async getBarsOnOrAfter(symbol: string, timeframe: Timeframe, feed: BarFeed, fromDate: string): Promise<DailyBar[]> {
    return this.db
      .prepare("SELECT t, o, h, l, c, v, vw FROM stock_bars WHERE symbol = ? AND timeframe = ? AND feed = ? AND t >= ? ORDER BY t ASC")
      .all(symbol, timeframe, feed, fromDate) as BarRow[];
  }

  async putBars(symbol: string, timeframe: Timeframe, feed: BarFeed, bars: DailyBar[]): Promise<void> {
    if (bars.length === 0) return;
    const updatedAt = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO stock_bars (symbol, timeframe, feed, t, o, h, l, c, v, vw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, timeframe, feed, t) DO UPDATE SET
         o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
         v = excluded.v, vw = excluded.vw, updated_at = excluded.updated_at`,
    );
    // Single transactional write — even a 5-year backfill (~1260 bars) costs only one fsync
    this.db.exec("BEGIN");
    try {
      for (const bar of bars) {
        stmt.run(symbol, timeframe, feed, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v, bar.vw, updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async clearSymbol(symbol: string, timeframe: Timeframe, feed: BarFeed): Promise<void> {
    this.db.prepare("DELETE FROM stock_bars WHERE symbol = ? AND timeframe = ? AND feed = ?").run(symbol, timeframe, feed);
    this.db.prepare("DELETE FROM stock_bar_coverage WHERE symbol = ? AND timeframe = ? AND feed = ?").run(symbol, timeframe, feed);
  }
}
