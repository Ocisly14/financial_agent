// src/infra/db/mongoEventStore.ts
import { MongoClient, type Collection } from "mongodb";
import { createLogger } from "../logger/logger.ts";
import type { CompactionCache, EventStore, PreservedDataEntry } from "../../framework/eventStore.ts";
import type { SessionEvent } from "../../framework/sessionState.ts";

const log = createLogger("mongo-event-store");

type CompactionDoc = {
  session_id: string;
  summarizedThroughTurn: number;
  summaryText: string;
  preservedData: PreservedDataEntry[];
  updatedAt: string;
};

export class MongoEventStore implements EventStore {
  private readonly client: MongoClient;
  private readonly events: Collection<SessionEvent>;
  private readonly compactions: Collection<CompactionDoc>;

  private constructor(client: MongoClient, events: Collection<SessionEvent>, compactions: Collection<CompactionDoc>) {
    this.client = client;
    this.events = events;
    this.compactions = compactions;
  }

  static async connect(uri: string): Promise<MongoEventStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    const db = client.db();
    const events = db.collection<SessionEvent>("session_events");
    const compactions = db.collection<CompactionDoc>("session_compaction");
    await events.createIndex({ session_id: 1, event_id: 1 }, { unique: true });
    await events.createIndex({ session_id: 1, turn: 1 });
    log.info(`connected to ${uri}`);
    return new MongoEventStore(client, events, compactions);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    await this.events.insertOne({ ...event });
  }

  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const docs = await this.events
      .find({ session_id: sessionId }, { projection: { _id: 0 } })
      .sort({ timestamp: 1 })
      .toArray();
    return docs as unknown as SessionEvent[];
  }

  async loadCompaction(sessionId: string): Promise<CompactionCache | undefined> {
    const doc = await this.compactions.findOne({ session_id: sessionId }, { projection: { _id: 0 } });
    if (!doc) return undefined;
    return {
      summarizedThroughTurn: doc.summarizedThroughTurn,
      summaryText: doc.summaryText,
      preservedData: doc.preservedData,
    };
  }

  async saveCompaction(sessionId: string, cache: CompactionCache): Promise<void> {
    await this.compactions.updateOne(
      { session_id: sessionId },
      { $set: { ...cache, session_id: sessionId, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
  }
}
