import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompactionCache, EventStore, PreservedDataEntry } from "../../framework/eventStore.ts";
import type { SessionEvent, Source } from "../../framework/sessionState.ts";
import type { JsonObject } from "../../framework/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  parent_event_id TEXT,
  session_id      TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  source          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  -- Which agent loop's conversation this event belongs to. The main
  -- conversation's thread id IS the session_id; a subagent thread is
  -- '<session_id>:<agent>:<n>'. This replaced the old is_sidechain boolean,
  -- which answered the same question with less information.
  thread_id       TEXT,
  -- Legacy. Kept written and NOT NULL so a database written by this code still
  -- opens under the previous build, and so the read-path fallback below can
  -- reconstruct a thread for rows that predate thread_id. Nothing above the
  -- row mapper reads it.
  is_sidechain    INTEGER NOT NULL,
  turn            INTEGER NOT NULL,
  payload_json    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_events_session_sequence
  ON session_events (session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_session_events_session_turn
  ON session_events (session_id, turn);

CREATE TABLE IF NOT EXISTS session_compaction (
  session_id              TEXT PRIMARY KEY,
  summarized_through_turn INTEGER NOT NULL,
  summary_text            TEXT NOT NULL,
  preserved_data_json     TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

-- The table name chat_rooms is a legacy holdover. These rows are called Topic
-- everywhere in the code: a topic's id is its session_id (see the ensureTopic
-- call in server.ts).
CREATE TABLE IF NOT EXISTS chat_rooms (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER,
  -- The SMALL-model blurb describing what this Topic investigates and where
  -- its conclusions stand. Generated per Topic (src/agent/topicDigest.ts), NOT
  -- per Research: a Topic that was never pulled into a Research still gets one.
  summary            TEXT,
  -- One of TOPIC_CATEGORIES, or NULL for a Topic the model hasn't seen yet.
  category           TEXT,
  -- Set once the user picks a category by hand. The model then refreshes the
  -- summary but leaves the category alone, so the two never fight.
  category_locked    INTEGER NOT NULL DEFAULT 0,
  -- A digest proposes a useful title after the first turn. A manual rename
  -- locks that title while still allowing the digest body to refresh.
  title_locked       INTEGER NOT NULL DEFAULT 0,
  -- Structured ticker subjects from the digest; independent of chart tabs.
  digest_symbols_json TEXT NOT NULL DEFAULT '[]',
  digest_through_turn INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chat_rooms_agent_updated
  ON chat_rooms (agent_id, updated_at DESC);

-- A tab is either a single ticker (kind='symbol') or a multi-ticker overlay
-- (kind='overlay', payload in the overlay JSON column). Only one of
-- symbol/overlay is populated per row, matching the kind. The primary key is
-- a synthetic id because overlay rows have no natural ticker key; the
-- partial unique index below preserves the old "no duplicate ticker per
-- topic" guarantee for symbol rows while leaving overlay rows unconstrained.
CREATE TABLE IF NOT EXISTS topic_charts (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  symbol     TEXT,
  overlay    TEXT,
  -- A number of trading days (see src/data/stock/stockChartData.ts). INTEGER
  -- rather than TEXT because the range is no longer a label like '1Y'.
  range      INTEGER,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_charts_symbol
  ON topic_charts (topic_id, symbol) WHERE symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topic_charts_topic_order
  ON topic_charts (topic_id, sort_order);

-- researches.id doubles as its session_id, reusing the same trick as topic.
CREATE TABLE IF NOT EXISTS researches (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_researches_agent_updated
  ON researches (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS research_members (
  research_id         TEXT NOT NULL,
  topic_id            TEXT NOT NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  digest              TEXT,
  digest_through_turn INTEGER NOT NULL DEFAULT 0,
  seen_through_turn   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (research_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_research_members_topic
  ON research_members (topic_id);
`;

/** Columns added to `chat_rooms` after the table shipped. `CREATE TABLE IF NOT
 *  EXISTS` is a no-op against a database that already has the old table, so a
 *  new column in SCHEMA above reaches new databases only — existing ones need
 *  this. There is no migration framework here and this list is deliberately
 *  the whole mechanism: each entry is an idempotent `ADD COLUMN`, applied only
 *  when `PRAGMA table_info` says it is missing. Keep it in sync with SCHEMA. */
const CHAT_ROOM_ADDED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "summary", ddl: "summary TEXT" },
  { name: "category", ddl: "category TEXT" },
  { name: "category_locked", ddl: "category_locked INTEGER NOT NULL DEFAULT 0" },
  { name: "title_locked", ddl: "title_locked INTEGER NOT NULL DEFAULT 0" },
  { name: "digest_symbols_json", ddl: "digest_symbols_json TEXT NOT NULL DEFAULT '[]'" },
  { name: "digest_through_turn", ddl: "digest_through_turn INTEGER NOT NULL DEFAULT 0" },
];

/** Same mechanism as CHAT_ROOM_ADDED_COLUMNS, for `session_events`. */
const SESSION_EVENT_ADDED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "thread_id", ddl: "thread_id TEXT" },
];

/** Adds any of `CHAT_ROOM_ADDED_COLUMNS` the database does not have yet. Safe
 *  to run on every open: a database already carrying them does no writes. */
function migrateChatRooms(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(chat_rooms)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const column of CHAT_ROOM_ADDED_COLUMNS) {
    if (!existing.has(column.name)) db.exec(`ALTER TABLE chat_rooms ADD COLUMN ${column.ddl}`);
  }
}

/** Adds `thread_id` to databases written before threads existed, then indexes
 *  it. The index lives here rather than in SCHEMA because SCHEMA runs first —
 *  on an old database the column does not exist yet at that point. */
function migrateSessionEvents(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(session_events)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const column of SESSION_EVENT_ADDED_COLUMNS) {
    if (!existing.has(column.name)) db.exec(`ALTER TABLE session_events ADD COLUMN ${column.ddl}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_session_thread
             ON session_events (session_id, thread_id)`);
}

/** Digest model output is persisted as JSON; a malformed legacy value must not
 * prevent the entire sidebar from rendering. Validation of ticker syntax has
 * already happened at the digest boundary, so this is intentionally a small
 * defensive parser rather than a second policy engine. */
function parseDigestSymbols(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

type EventRow = {
  event_id: string;
  parent_event_id: string | null;
  session_id: string;
  timestamp: string;
  source: string;
  kind: string;
  thread_id: string | null;
  is_sidechain: number;
  turn: number;
  payload_json: string;
};

/**
 * A thread for a row written before threads existed. The old model carried the
 * same distinction in two weaker pieces: `is_sidechain` said "inside some
 * subagent", and `payload.task_id` said which one. Together they reconstruct a
 * thread id exactly, so no data migration is needed — old traces group the way
 * they always did, just under a key that happens to be a dispatch event id.
 *
 * `liveThreads()` will not offer these to the orchestrator: it derives from a
 * dispatch's `child_thread_id`, which old dispatches do not have. That is
 * correct — those tasks were one-shot and there is nothing to resume.
 */
function legacyThreadId(row: EventRow, payload: JsonObject): string {
  if (row.is_sidechain !== 1) return row.session_id;
  return typeof payload.task_id === "string" ? payload.task_id : row.session_id;
}

type CompactionRow = {
  summarized_through_turn: number;
  summary_text: string;
  preserved_data_json: string;
};

/**
 * What kind of investigation a Topic is, in the order the sidebar groups them.
 *
 * The test each category has to pass is "does this label predict what the user
 * opens next" — that is why asset class (crypto / commodities / FX) is NOT a
 * category. Asset class is an axis orthogonal to these six: a BTC Topic can be
 * single-name research or a macro thesis. It falls out of `leadSymbol` instead.
 */
export const TOPIC_CATEGORIES = [
  "single_name",
  "comparative",
  "sector",
  "macro",
  "strategy",
  "portfolio",
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

/** Narrows an untrusted string (model output, request body) to a category. */
export function asTopicCategory(value: unknown): TopicCategory | null {
  return typeof value === "string" && (TOPIC_CATEGORIES as readonly string[]).includes(value)
    ? (value as TopicCategory)
    : null;
}

export type TopicSummary = {
  id: string;
  name: string;
  /** Derived from `topic_charts` — the first visible chart (sort_order ASC). Never written directly. */
  leadSymbol: string | null;
  /** Symbols identified by the Topic digest, ordered by relevance. */
  subjectSymbols: string[];
  createdAt: number;
  lastMessage: { text: string; createdAt: number } | null;
  messageCount: number;
  /** SMALL-model blurb; null until the Topic has had a turn and been digested. */
  summary: string | null;
  category: TopicCategory | null;
  /** True once the user set the category by hand — the model stops overwriting it. */
  categoryLocked: boolean;
};

/** `range` is a number of trading days (src/data/stock/stockChartData.ts). */
export type OverlaySpec = { symbols: string[]; range: number; normalize: "pct" | "index100" };

export type TopicChartPreferenceRow =
  | { id: string; kind: "symbol"; symbol: string; range: number | null; hidden: boolean; sortOrder: number }
  | { id: string; kind: "overlay"; overlay: OverlaySpec; range: number | null; hidden: boolean; sortOrder: number };

type TopicRow = {
  id: string;
  name: string;
  lead_symbol: string | null;
  created_at: number;
  summary: string | null;
  category: string | null;
  category_locked: number;
  digest_symbols_json: string;
};
type LastMessageRow = { payload_json: string; timestamp: string };

export type ResearchSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
};

export type ResearchMember = {
  topicId: string;
  sortOrder: number;
  digest: string | null;
  digestThroughTurn: number;
  seenThroughTurn: number;
};

type ResearchRow = { id: string; name: string; created_at: number; updated_at: number; member_count: number };
type ResearchMemberRow = {
  topic_id: string;
  sort_order: number;
  digest: string | null;
  digest_through_turn: number;
  seen_through_turn: number;
};

/** Local, process-safe session persistence backed by one SQLite file. */
export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Use `:memory:` in tests; file-backed databases create their parent directory. */
  static open(databasePath: string): SqliteEventStore {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    migrateChatRooms(db);
    migrateSessionEvents(db);
    return new SqliteEventStore(db);
  }

  close(): void {
    this.db.close();
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    this.db.prepare(
      `INSERT INTO session_events (
         event_id, parent_event_id, session_id, timestamp, source, kind,
         thread_id, is_sidechain, turn, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.event_id,
      event.parent_event_id,
      event.session_id,
      event.timestamp,
      event.source,
      event.kind,
      event.thread_id,
      // Legacy column, still NOT NULL: anything off the main thread is what the
      // old boolean called a sidechain.
      event.thread_id === event.session_id ? 0 : 1,
      event.turn,
      JSON.stringify(event.payload),
    );
    this.db.prepare("UPDATE chat_rooms SET updated_at = ? WHERE id = ?").run(Date.now(), event.session_id);
  }

  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const rows = this.db.prepare(
      `SELECT event_id, parent_event_id, session_id, timestamp, source, kind,
              thread_id, is_sidechain, turn, payload_json
       FROM session_events
       WHERE session_id = ?
       ORDER BY sequence ASC`,
    ).all(sessionId) as EventRow[];

    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as JsonObject;
      return {
        event_id: row.event_id,
        parent_event_id: row.parent_event_id,
        session_id: row.session_id,
        timestamp: row.timestamp,
        source: row.source as Source,
        kind: row.kind,
        thread_id: row.thread_id ?? legacyThreadId(row, payload),
        turn: row.turn,
        payload,
      };
    });
  }

  async loadCompaction(sessionId: string): Promise<CompactionCache | undefined> {
    const row = this.db.prepare(
      `SELECT summarized_through_turn, summary_text, preserved_data_json
       FROM session_compaction
       WHERE session_id = ?`,
    ).get(sessionId) as CompactionRow | undefined;
    if (!row) return undefined;
    return {
      summarizedThroughTurn: row.summarized_through_turn,
      summaryText: row.summary_text,
      preservedData: JSON.parse(row.preserved_data_json) as PreservedDataEntry[],
    };
  }

  async saveCompaction(sessionId: string, cache: CompactionCache): Promise<void> {
    this.db.prepare(
      `INSERT INTO session_compaction (
         session_id, summarized_through_turn, summary_text, preserved_data_json, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         summarized_through_turn = excluded.summarized_through_turn,
         summary_text = excluded.summary_text,
         preserved_data_json = excluded.preserved_data_json,
         updated_at = excluded.updated_at`,
    ).run(
      sessionId,
      cache.summarizedThroughTurn,
      cache.summaryText,
      JSON.stringify(cache.preservedData),
      new Date().toISOString(),
    );
  }

  createTopic(agentId: string, topicId: string, name: string, createdAt = Date.now()): TopicSummary {
    this.db.prepare(
      `INSERT INTO chat_rooms (id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(topicId, agentId, name, createdAt, createdAt);
    return {
      id: topicId,
      name,
      leadSymbol: null,
      subjectSymbols: [],
      createdAt,
      lastMessage: null,
      messageCount: 0,
      summary: null,
      category: null,
      categoryLocked: false,
    };
  }

  ensureTopic(agentId: string, topicId: string, name: string, createdAt = Date.now()): void {
    this.createTopic(agentId, topicId, name, createdAt);
  }

  listTopics(agentId: string): TopicSummary[] {
    const topics = this.db.prepare(
      `SELECT chat_rooms.id AS id, chat_rooms.name AS name, chat_rooms.created_at AS created_at,
              chat_rooms.summary AS summary, chat_rooms.category AS category,
              chat_rooms.category_locked AS category_locked,
              chat_rooms.digest_symbols_json AS digest_symbols_json,
              lead.symbol AS lead_symbol
       FROM chat_rooms
       LEFT JOIN (
         SELECT topic_id, symbol,
                ROW_NUMBER() OVER (PARTITION BY topic_id ORDER BY sort_order ASC) AS rn
         FROM topic_charts WHERE hidden = 0
       ) lead ON lead.topic_id = chat_rooms.id AND lead.rn = 1
       WHERE agent_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
    ).all(agentId) as TopicRow[];
    const countStatement = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM session_events
       WHERE session_id = ? AND kind IN ('user_message', 'reply')`,
    );
    const lastMessageStatement = this.db.prepare(
      `SELECT payload_json, timestamp
       FROM session_events
       WHERE session_id = ? AND kind IN ('user_message', 'reply')
       ORDER BY sequence DESC
       LIMIT 1`,
    );

    return topics.map((topic) => {
      const countRow = countStatement.get(topic.id) as { count: number };
      const lastRow = lastMessageStatement.get(topic.id) as LastMessageRow | undefined;
      let lastMessage: TopicSummary["lastMessage"] = null;
      if (lastRow) {
        const payload = JSON.parse(lastRow.payload_json) as JsonObject;
        lastMessage = {
          text: String(payload.content ?? ""),
          createdAt: Date.parse(lastRow.timestamp),
        };
      }
      return {
        id: topic.id,
        name: topic.name,
        leadSymbol: topic.lead_symbol,
        subjectSymbols: parseDigestSymbols(topic.digest_symbols_json),
        createdAt: topic.created_at,
        lastMessage,
        messageCount: countRow.count,
        summary: topic.summary,
        category: asTopicCategory(topic.category),
        categoryLocked: topic.category_locked === 1,
      };
    });
  }

  /**
   * User-driven edits to a Topic. Distinct from `setTopicDigest`, which is the
   * model's write path: this one bumps `updated_at` (the user touched the
   * Topic, so it belongs at the top of the rail) and, for `category`, sets the
   * lock that stops the model overwriting the choice.
   *
   * `category: null` means "go back to automatic" — it releases the lock and
   * leaves the stored category ALONE. Blanking it would be the worse reading of
   * the same gesture: the Topic is not stale (its digest already covers every
   * turn), so nothing would reclassify it, and the user would watch the label
   * vanish until they happened to chat again. Automatic means the model owns
   * the choice, not that there is no choice.
   */
  updateTopic(
    agentId: string,
    topicId: string,
    patch: { name?: string; category?: TopicCategory | null },
  ): boolean {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      // A hand-edited name must not be overwritten by a later background
      // digest. It remains a normal Topic title, merely user-owned now.
      assignments.push("name = ?", "title_locked = 1");
      values.push(patch.name);
    }
    if (patch.category === null) {
      assignments.push("category_locked = 0");
    } else if (patch.category !== undefined) {
      assignments.push("category = ?", "category_locked = 1");
      values.push(patch.category);
    }
    if (assignments.length === 0) return false;
    assignments.push("updated_at = ?");
    values.push(Date.now(), topicId, agentId);

    const result = this.db.prepare(
      `UPDATE chat_rooms SET ${assignments.join(", ")} WHERE id = ? AND agent_id = ?`,
    ).run(...values);
    return result.changes > 0;
  }

  /**
   * The digest writer's counterpart to `updateTopic`.
   *
   * Deliberately does NOT touch `updated_at`. The rail orders by it, so a
   * background digest that bumped it would shove the Topic to the top of the
   * list minutes after the user stopped working on it — the summariser would
   * be manufacturing the very activity it is supposed to be describing.
   *
   * `category` is skipped when the user has locked one, but `summary` is
   * written either way: a locked category is a statement about what the Topic
   * IS, not a request to freeze what it currently says.
   */
  setTopicDigest(
    topicId: string,
    summary: string,
    category: TopicCategory | null,
    throughTurn: number,
    metadata: { title: string | null; symbols: string[] } = { title: null, symbols: [] },
  ): void {
    const locked = this.db
      .prepare("SELECT category_locked, title_locked FROM chat_rooms WHERE id = ?")
      .get(topicId) as { category_locked: number; title_locked: number } | undefined;
    if (!locked) return;

    const symbols = JSON.stringify(metadata.symbols);
    const title = metadata.title?.trim() || null;
    const titleAssignment = locked.title_locked === 0 && title !== null ? ", name = ?" : "";
    const titleValue = locked.title_locked === 0 && title !== null ? [title] : [];

    if (locked.category_locked === 1 || category === null) {
      this.db
        .prepare(`UPDATE chat_rooms SET summary = ?, digest_symbols_json = ?, digest_through_turn = ?${titleAssignment} WHERE id = ?`)
        .run(summary, symbols, throughTurn, ...titleValue, topicId);
      return;
    }
    this.db
      .prepare(`UPDATE chat_rooms SET summary = ?, category = ?, digest_symbols_json = ?, digest_through_turn = ?${titleAssignment} WHERE id = ?`)
      .run(summary, category, symbols, throughTurn, ...titleValue, topicId);
  }

  /**
   * Whether one Topic's log has moved past its digest. Same rule as
   * `listStaleTopics`, kept in SQL beside it so the two can never disagree —
   * the scheduler asks this at fire time rather than trusting the reason it
   * was scheduled.
   *
   * A Topic with no turns is not stale: summarising a conversation that hasn't
   * happened yields a confident description of nothing.
   */
  isTopicDigestStale(topicId: string): boolean {
    const row = this.db.prepare(
      `SELECT chat_rooms.digest_through_turn AS digested,
              (SELECT MAX(turn) FROM session_events WHERE session_id = chat_rooms.id) AS max_turn
       FROM chat_rooms WHERE id = ?`,
    ).get(topicId) as { digested: number; max_turn: number | null } | undefined;
    if (!row) return false;
    return (row.max_turn ?? 0) > row.digested;
  }

  /** A digest is due for its first completed turn, then only after three more
   * completed turns. This keeps digest generation incremental and bounded. */
  isTopicDigestDue(topicId: string): boolean {
    const row = this.db.prepare(
      `SELECT chat_rooms.digest_through_turn AS digested,
              (SELECT MAX(turn) FROM session_events WHERE session_id = chat_rooms.id) AS max_turn
       FROM chat_rooms WHERE id = ?`,
    ).get(topicId) as { digested: number; max_turn: number | null } | undefined;
    if (!row) return false;
    const observed = row.max_turn ?? 0;
    return row.digested === 0 ? observed >= 1 : observed >= row.digested + 3;
  }

  getTopicDigest(topicId: string): { summary: string | null; throughTurn: number } | null {
    const row = this.db.prepare(
      "SELECT summary, digest_through_turn FROM chat_rooms WHERE id = ?",
    ).get(topicId) as { summary: string | null; digest_through_turn: number } | undefined;
    return row ? { summary: row.summary, throughTurn: row.digest_through_turn } : null;
  }

  /**
   * Topics whose log has moved past their digest — the same `turnCount >
   * digestThroughTurn` rule the Research layer already used, pushed into SQL
   * so a catch-up sweep never has to load event payloads to find out.
   */
  listStaleTopics(agentId: string): string[] {
    const rows = this.db.prepare(
      `SELECT chat_rooms.id AS id
       FROM chat_rooms
       LEFT JOIN (
         SELECT session_id, MAX(turn) AS max_turn FROM session_events GROUP BY session_id
       ) turns ON turns.session_id = chat_rooms.id
       WHERE chat_rooms.agent_id = ?
         AND COALESCE(turns.max_turn, 0) > chat_rooms.digest_through_turn`,
    ).all(agentId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** Topics whose first digest or next complete three-turn increment is due. */
  listDigestDueTopics(agentId: string): string[] {
    const rows = this.db.prepare(
      `SELECT chat_rooms.id AS id
       FROM chat_rooms
       LEFT JOIN (
         SELECT session_id, MAX(turn) AS max_turn FROM session_events GROUP BY session_id
       ) turns ON turns.session_id = chat_rooms.id
       WHERE chat_rooms.agent_id = ?
         AND (
           (chat_rooms.digest_through_turn = 0 AND COALESCE(turns.max_turn, 0) >= 1)
           OR COALESCE(turns.max_turn, 0) >= chat_rooms.digest_through_turn + 3
         )`,
    ).all(agentId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  deleteTopic(agentId: string, topicId: string): boolean {
    const topic = this.db.prepare("SELECT 1 FROM chat_rooms WHERE id = ? AND agent_id = ?").get(topicId, agentId);
    if (!topic) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(topicId);
      this.db.prepare("DELETE FROM session_compaction WHERE session_id = ?").run(topicId);
      this.db.prepare("DELETE FROM topic_charts WHERE topic_id = ?").run(topicId);
      this.db.prepare("DELETE FROM research_members WHERE topic_id = ?").run(topicId);
      this.db.prepare("DELETE FROM chat_rooms WHERE id = ? AND agent_id = ?").run(topicId, agentId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listTopicCharts(topicId: string): TopicChartPreferenceRow[] {
    const rows = this.db.prepare(
      `SELECT id, kind, symbol, overlay, range, hidden, sort_order
       FROM topic_charts WHERE topic_id = ? ORDER BY sort_order ASC, symbol ASC`,
    ).all(topicId) as Array<{
      id: string;
      kind: string;
      symbol: string | null;
      overlay: string | null;
      range: number | null;
      hidden: number;
      sort_order: number;
    }>;
    const result: TopicChartPreferenceRow[] = [];
    for (const row of rows) {
      if (row.kind === "symbol" && row.symbol !== null) {
        result.push({
          id: row.id,
          kind: "symbol",
          symbol: row.symbol,
          range: row.range,
          hidden: row.hidden === 1,
          sortOrder: row.sort_order,
        });
      } else if (row.kind === "overlay" && row.overlay !== null) {
        // Storage outlives the build that wrote it: a row this build cannot
        // parse (schema drift, hand-edited data, a future field we don't
        // know about) must be skipped, not allowed to throw and take the
        // whole tab bar down with it.
        try {
          const overlay = JSON.parse(row.overlay) as OverlaySpec;
          result.push({
            id: row.id,
            kind: "overlay",
            overlay,
            range: row.range,
            hidden: row.hidden === 1,
            sortOrder: row.sort_order,
          });
        } catch {
          continue;
        }
      }
      // Rows whose kind doesn't match a known variant (or whose matching
      // payload column is NULL) are skipped for the same reason.
    }
    return result;
  }

  replaceTopicCharts(topicId: string, rows: TopicChartPreferenceRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM topic_charts WHERE topic_id = ?").run(topicId);
      const insert = this.db.prepare(
        `INSERT INTO topic_charts (id, topic_id, kind, symbol, overlay, range, hidden, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        if (row.kind === "symbol") {
          insert.run(row.id, topicId, "symbol", row.symbol, null, row.range, row.hidden ? 1 : 0, row.sortOrder);
        } else {
          insert.run(row.id, topicId, "overlay", null, JSON.stringify(row.overlay), row.range, row.hidden ? 1 : 0, row.sortOrder);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Test-only raw SQL escape hatch. Used to simulate storage that outlives
   * the build that wrote it (e.g. a hand-corrupted overlay JSON payload),
   * which is otherwise impossible to construct through the typed API.
   */
  rawExec(sql: string): void {
    this.db.exec(sql);
  }

  /** Test-only counterpart to `rawExec`, for asserting on columns the typed
   *  API deliberately does not project (e.g. `updated_at`). */
  rawGet(sql: string): unknown {
    return this.db.prepare(sql).get();
  }

  createResearch(agentId: string, researchId: string, name: string, createdAt = Date.now()): ResearchSummary {
    this.db.prepare(
      `INSERT INTO researches (id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(researchId, agentId, name, createdAt, createdAt);
    return { id: researchId, name, createdAt, updatedAt: createdAt, memberCount: 0 };
  }

  listResearches(agentId: string): ResearchSummary[] {
    const rows = this.db.prepare(
      `SELECT researches.id AS id, researches.name AS name,
              researches.created_at AS created_at, researches.updated_at AS updated_at,
              COUNT(research_members.topic_id) AS member_count
       FROM researches
       LEFT JOIN research_members ON research_members.research_id = researches.id
       WHERE researches.agent_id = ?
       GROUP BY researches.id
       ORDER BY researches.updated_at DESC, researches.created_at DESC`,
    ).all(agentId) as ResearchRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      memberCount: row.member_count,
    }));
  }

  getResearch(agentId: string, researchId: string): ResearchSummary | undefined {
    const row = this.db.prepare(
      `SELECT researches.id AS id, researches.name AS name,
              researches.created_at AS created_at, researches.updated_at AS updated_at,
              COUNT(research_members.topic_id) AS member_count
       FROM researches
       LEFT JOIN research_members ON research_members.research_id = researches.id
       WHERE researches.agent_id = ? AND researches.id = ?
       GROUP BY researches.id`,
    ).get(agentId, researchId) as ResearchRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      memberCount: row.member_count,
    };
  }

  renameResearch(agentId: string, researchId: string, name: string): boolean {
    const result = this.db.prepare(
      `UPDATE researches SET name = ?, updated_at = ? WHERE id = ? AND agent_id = ?`,
    ).run(name, Date.now(), researchId, agentId);
    return result.changes > 0;
  }

  deleteResearch(agentId: string, researchId: string): boolean {
    const research = this.db.prepare("SELECT 1 FROM researches WHERE id = ? AND agent_id = ?").get(researchId, agentId);
    if (!research) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM research_members WHERE research_id = ?").run(researchId);
      this.db.prepare("DELETE FROM researches WHERE id = ? AND agent_id = ?").run(researchId, agentId);
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(researchId);
      this.db.prepare("DELETE FROM session_compaction WHERE session_id = ?").run(researchId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listResearchMembers(researchId: string): ResearchMember[] {
    const rows = this.db.prepare(
      `SELECT topic_id, sort_order, digest, digest_through_turn, seen_through_turn
       FROM research_members WHERE research_id = ? ORDER BY sort_order ASC`,
    ).all(researchId) as ResearchMemberRow[];
    return rows.map((row) => ({
      topicId: row.topic_id,
      sortOrder: row.sort_order,
      digest: row.digest,
      digestThroughTurn: row.digest_through_turn,
      seenThroughTurn: row.seen_through_turn,
    }));
  }

  /**
   * Whole-set replacement, but surviving members keep their `digest` / `digestThroughTurn` /
   * `seenThroughTurn` — a digest costs a real model call, and a membership edit must not
   * silently re-bill it.
   */
  replaceResearchMembers(researchId: string, topicIds: string[]): void {
    const existing = this.listResearchMembers(researchId);
    const existingById = new Map(existing.map((member) => [member.topicId, member]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM research_members WHERE research_id = ?").run(researchId);
      const insert = this.db.prepare(
        `INSERT INTO research_members (research_id, topic_id, sort_order, digest, digest_through_turn, seen_through_turn)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      topicIds.forEach((topicId, index) => {
        const previous = existingById.get(topicId);
        insert.run(
          researchId,
          topicId,
          index,
          previous?.digest ?? null,
          previous?.digestThroughTurn ?? 0,
          previous?.seenThroughTurn ?? 0,
        );
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setMemberDigest(researchId: string, topicId: string, digest: string, digestThroughTurn: number): void {
    this.db.prepare(
      `UPDATE research_members SET digest = ?, digest_through_turn = ?
       WHERE research_id = ? AND topic_id = ?`,
    ).run(digest, digestThroughTurn, researchId, topicId);
  }

  setMemberSeenTurn(researchId: string, topicId: string, seenThroughTurn: number): void {
    this.db.prepare(
      `UPDATE research_members SET seen_through_turn = ?
       WHERE research_id = ? AND topic_id = ?`,
    ).run(seenThroughTurn, researchId, topicId);
  }
}
