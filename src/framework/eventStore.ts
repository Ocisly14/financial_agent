// src/framework/eventStore.ts
import type { JsonObject } from "./types.ts";
import type { SessionEvent } from "./sessionState.ts";

export type PreservedDataEntry = {
  turn: number;
  agent: string;
  /** Durable task-result event containing the complete, auditable tool data. */
  sourceEventId?: string;
  data: JsonObject;
};

export type CompactionCache = {
  summarizedThroughTurn: number;
  summaryText: string;
  preservedData: PreservedDataEntry[];
};

/** Pluggable persistence for the session event log. `record()` writes
 *  fire-and-forget; `SessionRegistry` reads on cold start to restore a session. */
export interface EventStore {
  appendEvent(event: SessionEvent): Promise<void>;
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
  loadCompaction(sessionId: string): Promise<CompactionCache | undefined>;
  saveCompaction(sessionId: string, cache: CompactionCache): Promise<void>;
}

/** In-memory EventStore — used in tests, and as a safe default when no
 *  database is configured (data does not survive a process restart). */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, SessionEvent[]>();
  private readonly compactions = new Map<string, CompactionCache>();

  async appendEvent(event: SessionEvent): Promise<void> {
    const list = this.events.get(event.session_id) ?? [];
    list.push(event);
    this.events.set(event.session_id, list);
  }

  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    return [...(this.events.get(sessionId) ?? [])];
  }

  async loadCompaction(sessionId: string): Promise<CompactionCache | undefined> {
    const cache = this.compactions.get(sessionId);
    return cache ? { ...cache, preservedData: [...cache.preservedData] } : undefined;
  }

  async saveCompaction(sessionId: string, cache: CompactionCache): Promise<void> {
    this.compactions.set(sessionId, { ...cache, preservedData: [...cache.preservedData] });
  }
}
