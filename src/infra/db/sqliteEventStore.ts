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
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_rooms_agent_updated
  ON chat_rooms (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS topic_charts (
  topic_id   TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  range      TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (topic_id, symbol)
);

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

type EventRow = {
  event_id: string;
  parent_event_id: string | null;
  session_id: string;
  timestamp: string;
  source: string;
  kind: string;
  is_sidechain: number;
  turn: number;
  payload_json: string;
};

type CompactionRow = {
  summarized_through_turn: number;
  summary_text: string;
  preserved_data_json: string;
};

export type TopicSummary = {
  id: string;
  name: string;
  /** Derived from `topic_charts` — the first visible chart (sort_order ASC). Never written directly. */
  leadSymbol: string | null;
  createdAt: number;
  lastMessage: { text: string; createdAt: number } | null;
  messageCount: number;
};

export type TopicChartPreferenceRow = {
  symbol: string;
  range: string | null;
  hidden: boolean;
  sortOrder: number;
};

type TopicRow = { id: string; name: string; lead_symbol: string | null; created_at: number };
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
    return new SqliteEventStore(db);
  }

  close(): void {
    this.db.close();
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    this.db.prepare(
      `INSERT INTO session_events (
         event_id, parent_event_id, session_id, timestamp, source, kind,
         is_sidechain, turn, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.event_id,
      event.parent_event_id,
      event.session_id,
      event.timestamp,
      event.source,
      event.kind,
      event.is_sidechain ? 1 : 0,
      event.turn,
      JSON.stringify(event.payload),
    );
    this.db.prepare("UPDATE chat_rooms SET updated_at = ? WHERE id = ?").run(Date.now(), event.session_id);
  }

  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const rows = this.db.prepare(
      `SELECT event_id, parent_event_id, session_id, timestamp, source, kind,
              is_sidechain, turn, payload_json
       FROM session_events
       WHERE session_id = ?
       ORDER BY sequence ASC`,
    ).all(sessionId) as EventRow[];

    return rows.map((row) => ({
      event_id: row.event_id,
      parent_event_id: row.parent_event_id,
      session_id: row.session_id,
      timestamp: row.timestamp,
      source: row.source as Source,
      kind: row.kind,
      is_sidechain: row.is_sidechain === 1,
      turn: row.turn,
      payload: JSON.parse(row.payload_json) as JsonObject,
    }));
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
    return { id: topicId, name, leadSymbol: null, createdAt, lastMessage: null, messageCount: 0 };
  }

  ensureTopic(agentId: string, topicId: string, name: string, createdAt = Date.now()): void {
    this.createTopic(agentId, topicId, name, createdAt);
  }

  listTopics(agentId: string): TopicSummary[] {
    const topics = this.db.prepare(
      `SELECT chat_rooms.id AS id, chat_rooms.name AS name, chat_rooms.created_at AS created_at,
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
        createdAt: topic.created_at,
        lastMessage,
        messageCount: countRow.count,
      };
    });
  }

  updateTopic(
    agentId: string,
    topicId: string,
    patch: { name?: string },
  ): boolean {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) { assignments.push("name = ?"); values.push(patch.name); }
    if (assignments.length === 0) return false;
    assignments.push("updated_at = ?");
    values.push(Date.now(), topicId, agentId);

    const result = this.db.prepare(
      `UPDATE chat_rooms SET ${assignments.join(", ")} WHERE id = ? AND agent_id = ?`,
    ).run(...values);
    return result.changes > 0;
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
      `SELECT symbol, range, hidden, sort_order
       FROM topic_charts WHERE topic_id = ? ORDER BY sort_order ASC, symbol ASC`,
    ).all(topicId) as Array<{ symbol: string; range: string | null; hidden: number; sort_order: number }>;
    return rows.map((row) => ({
      symbol: row.symbol,
      range: row.range,
      hidden: row.hidden === 1,
      sortOrder: row.sort_order,
    }));
  }

  replaceTopicCharts(topicId: string, rows: TopicChartPreferenceRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM topic_charts WHERE topic_id = ?").run(topicId);
      const insert = this.db.prepare(
        `INSERT INTO topic_charts (topic_id, symbol, range, hidden, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(topicId, row.symbol, row.range, row.hidden ? 1 : 0, row.sortOrder);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
