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

CREATE TABLE IF NOT EXISTS chat_rooms (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_rooms_agent_updated
  ON chat_rooms (agent_id, updated_at DESC);
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

export type ChatRoomSummary = {
  id: string;
  name: string;
  createdAt: number;
  lastMessage: { text: string; createdAt: number } | null;
  messageCount: number;
};

type RoomRow = { id: string; name: string; created_at: number };
type LastMessageRow = { payload_json: string; timestamp: string };

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

  createRoom(agentId: string, roomId: string, name: string, createdAt = Date.now()): ChatRoomSummary {
    this.db.prepare(
      `INSERT INTO chat_rooms (id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(roomId, agentId, name, createdAt, createdAt);
    return { id: roomId, name, createdAt, lastMessage: null, messageCount: 0 };
  }

  ensureRoom(agentId: string, roomId: string, name: string, createdAt = Date.now()): void {
    this.createRoom(agentId, roomId, name, createdAt);
  }

  listRooms(agentId: string): ChatRoomSummary[] {
    const rooms = this.db.prepare(
      `SELECT id, name, created_at
       FROM chat_rooms
       WHERE agent_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
    ).all(agentId) as RoomRow[];
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

    return rooms.map((room) => {
      const countRow = countStatement.get(room.id) as { count: number };
      const lastRow = lastMessageStatement.get(room.id) as LastMessageRow | undefined;
      let lastMessage: ChatRoomSummary["lastMessage"] = null;
      if (lastRow) {
        const payload = JSON.parse(lastRow.payload_json) as JsonObject;
        lastMessage = {
          text: String(payload.content ?? ""),
          createdAt: Date.parse(lastRow.timestamp),
        };
      }
      return {
        id: room.id,
        name: room.name,
        createdAt: room.created_at,
        lastMessage,
        messageCount: countRow.count,
      };
    });
  }

  renameRoom(agentId: string, roomId: string, name: string): boolean {
    const result = this.db.prepare(
      `UPDATE chat_rooms SET name = ?, updated_at = ? WHERE id = ? AND agent_id = ?`,
    ).run(name, Date.now(), roomId, agentId);
    return result.changes > 0;
  }

  deleteRoom(agentId: string, roomId: string): boolean {
    const room = this.db.prepare("SELECT 1 FROM chat_rooms WHERE id = ? AND agent_id = ?").get(roomId, agentId);
    if (!room) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(roomId);
      this.db.prepare("DELETE FROM session_compaction WHERE session_id = ?").run(roomId);
      this.db.prepare("DELETE FROM chat_rooms WHERE id = ? AND agent_id = ?").run(roomId, agentId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
