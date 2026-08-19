import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { JsonObject } from "../../framework/types.ts";
import { FinancialModelError } from "../errors.ts";
import {
  InMemoryModelStore,
  SqliteModelStore,
  type ModelStore,
  type NewModelMeta,
  type RevisionInput,
  type SnapshotCodec,
} from "../store.ts";

type Snapshot = { values: number[]; label: string };
type Summary = JsonObject & { kind: string };
type Store = ModelStore<Snapshot, Summary>;
type Harness = { store: Store; close(): void };

const codec: SnapshotCodec<Snapshot> = {
  encode: (value) => {
    if (value.values.some((entry) => !Number.isFinite(entry))) {
      throw new Error("snapshot contains a non-finite value");
    }
    return JSON.stringify(value);
  },
  decode: (json) => {
    const value = JSON.parse(json) as Snapshot;
    if (!Array.isArray(value.values)
      || value.values.some((entry) => !Number.isFinite(entry))
      || typeof value.label !== "string") {
      throw new Error("invalid snapshot");
    }
    return value;
  },
};

function modelMeta(modelId = "model-1"): NewModelMeta {
  return {
    modelId,
    ownerTenantId: "agent-1",
    originSessionId: "session-1",
    symbol: "TEST",
    metadata: { currency: "USD" },
  };
}

function input(
  label: string,
  lifecycleStage: RevisionInput<Snapshot, Summary>["lifecycleStage"] = "draft",
): RevisionInput<Snapshot, Summary> {
  return {
    lifecycleStage,
    snapshot: { values: [1, 2], label },
    changeSummary: { kind: label, changedSections: [label] },
    engineVersion: "1",
    creatingSessionId: "session-1",
  };
}

function useStore(t: TestContext, make: () => Harness): Store {
  const harness = make();
  t.after(() => harness.close());
  return harness.store;
}

function isCode(code: FinancialModelError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof FinancialModelError && error.code === code;
}

function storeContract(name: string, make: () => Harness): void {
  test(`${name}: create stores stable metadata and complete revision zero`, (t) => {
    const store = useStore(t, make);
    const zero = store.create(modelMeta(), input("created"));
    assert.equal(zero.modelId, "model-1");
    assert.equal(zero.revision, 0);
    assert.equal(zero.parentRevision, null);
    assert.equal(zero.snapshot.label, "created");
    assert.deepEqual(zero.changeSummary, {
      kind: "created",
      changedSections: ["created"],
    });
    assert.deepEqual(store.getMeta("model-1"), {
      ...modelMeta(),
      currentRevision: 0,
      lifecycleStage: "draft",
      updatedAt: zero.createdAt,
      createdAt: zero.createdAt,
    });
  });

  test(`${name}: every mutation appends one full snapshot and current is greatest`, (t) => {
    const store = useStore(t, make);
    store.create(modelMeta(), input("created"));
    const history = store.commit("model-1", 0, input("history", "history_committed"));
    const revenue = store.commit("model-1", 1, input("revenue", "revenue_forecast"));

    assert.equal(history.revision, 1);
    assert.equal(history.parentRevision, 0);
    assert.equal(revenue.revision, 2);
    assert.equal(revenue.parentRevision, 1);
    assert.equal(store.getRevision("model-1")?.snapshot.label, "revenue");
    assert.equal(store.getRevision("model-1", 0)?.snapshot.label, "created");
    assert.equal(store.getRevision("model-1", 1)?.snapshot.label, "history");
    assert.equal(store.getMeta("model-1")?.currentRevision, 2);
  });

  test(`${name}: economically partial history and revenue snapshots are valid revisions`, (t) => {
    const store = useStore(t, make);
    store.create(modelMeta(), input("empty-draft"));
    assert.equal(
      store.commit("model-1", 0, input("history-only", "history_committed")).revision,
      1,
    );
    assert.equal(
      store.commit("model-1", 1, input("revenue-only", "revenue_forecast")).revision,
      2,
    );
  });

  test(`${name}: stale writers conflict and cannot create a second revision`, (t) => {
    const store = useStore(t, make);
    store.create(modelMeta(), input("created"));
    store.commit("model-1", 0, input("winner"));
    assert.throws(() => store.commit("model-1", 0, input("loser")), (error: unknown) => {
      assert.ok(error instanceof FinancialModelError);
      assert.equal(error.code, "revision_conflict");
      assert.deepEqual(error.details, { currentRevision: 1 });
      return true;
    });
    assert.deepEqual(store.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
    assert.equal(store.getRevision("model-1")?.snapshot.label, "winner");
  });

  test(`${name}: failed create and commit calls leave no state or revision gap`, (t) => {
    const store = useStore(t, make);
    const invalidCreate = input("invalid-create");
    invalidCreate.snapshot.values = [Number.NaN];
    assert.throws(() => store.create(modelMeta(), invalidCreate), isCode("invalid_snapshot"));
    assert.equal(store.getMeta("model-1"), undefined);

    store.create(modelMeta(), input("created"));
    const invalidSnapshot = input("invalid-snapshot");
    invalidSnapshot.snapshot.values = [Number.POSITIVE_INFINITY];
    assert.throws(
      () => store.commit("model-1", 0, invalidSnapshot),
      isCode("invalid_snapshot"),
    );
    const invalidSummary = input("invalid-summary");
    invalidSummary.changeSummary = { kind: "invalid", count: Number.NaN };
    assert.throws(
      () => store.commit("model-1", 0, invalidSummary),
      isCode("invalid_snapshot"),
    );
    assert.deepEqual(store.listRevisionHeaders("model-1").map((header) => header.revision), [0]);
    assert.equal(store.commit("model-1", 0, input("valid-after-failure")).revision, 1);
  });

  test(`${name}: write inputs and read results are deeply cloned`, (t) => {
    const store = useStore(t, make);
    const initial = input("created");
    const metadata = modelMeta();
    store.create(metadata, initial);
    initial.snapshot.values.push(99);
    initial.changeSummary.changedSections = ["mutated"];
    metadata.metadata.currency = "EUR";

    const firstRead = store.getRevision("model-1", 0)!;
    assert.deepEqual(firstRead.snapshot.values, [1, 2]);
    assert.deepEqual(firstRead.changeSummary.changedSections, ["created"]);
    assert.deepEqual(store.getMeta("model-1")?.metadata, { currency: "USD" });

    firstRead.snapshot.values.push(88);
    firstRead.changeSummary.changedSections = ["read-mutated"];
    const secondRead = store.getRevision("model-1", 0)!;
    assert.deepEqual(secondRead.snapshot.values, [1, 2]);
    assert.deepEqual(secondRead.changeSummary.changedSections, ["created"]);

    const next = input("next");
    store.commit("model-1", 0, next);
    next.snapshot.label = "mutated-after-commit";
    assert.equal(store.getRevision("model-1", 1)?.snapshot.label, "next");
  });

  test(`${name}: headers are ascending summaries without snapshots and are cloned`, (t) => {
    const store = useStore(t, make);
    store.create(modelMeta(), input("created"));
    store.commit("model-1", 0, input("history"));
    const headers = store.listRevisionHeaders("model-1");
    assert.deepEqual(headers.map((header) => header.revision), [0, 1]);
    assert.equal(headers.every((header) => !("snapshot" in header)), true);
    assert.deepEqual(headers.map((header) => header.changeSummary.kind), ["created", "history"]);

    headers[0]!.changeSummary.kind = "mutated";
    assert.equal(store.listRevisionHeaders("model-1")[0]!.changeSummary.kind, "created");
  });

  test(`${name}: archived latest state is hidden by default but remains auditable`, (t) => {
    const store = useStore(t, make);
    store.create(modelMeta(), input("created"));
    store.commit("model-1", 0, input("archived", "archived"));
    assert.deepEqual(store.list(), []);
    assert.equal(store.list({ includeArchived: true }).length, 1);
    assert.equal(store.list({ lifecycleStage: "archived" }).length, 1);
    assert.equal(store.getRevision("model-1", 0)?.snapshot.label, "created");
    assert.equal(store.getRevision("model-1", 1)?.lifecycleStage, "archived");
  });

  test(`${name}: list filters stable identity and latest lifecycle fields`, (t) => {
    const store = useStore(t, make);
    store.create(modelMeta("model-1"), input("one"));
    store.create(
      {
        ...modelMeta("model-2"),
        ownerTenantId: "agent-2",
        originSessionId: "session-2",
        symbol: "OTHER",
      },
      input("two", "history_committed"),
    );
    assert.deepEqual(store.list({ ownerTenantId: "agent-1" }).map((view) => view.modelId), ["model-1"]);
    assert.deepEqual(store.list({ symbol: "OTHER" }).map((view) => view.modelId), ["model-2"]);
    assert.deepEqual(store.list({ lifecycleStage: "history_committed" }).map((view) => view.modelId), ["model-2"]);
  });
}

storeContract("memory", () => ({
  store: new InMemoryModelStore(codec),
  close: () => undefined,
}));

storeContract("sqlite memory", () => {
  const store = SqliteModelStore.open<Snapshot, Summary>(":memory:", codec);
  return { store, close: () => store.close() };
});

test("SQLite persists all immutable revisions across reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dcf-store-reopen-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "models.sqlite");
  const first = SqliteModelStore.open<Snapshot, Summary>(path, codec);
  first.create(modelMeta(), input("created"));
  first.commit("model-1", 0, input("next"));
  first.close();

  const second = SqliteModelStore.open<Snapshot, Summary>(path, codec);
  t.after(() => second.close());
  assert.deepEqual(second.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
  assert.equal(second.getRevision("model-1", 0)?.snapshot.label, "created");
  assert.equal(second.getRevision("model-1")?.snapshot.label, "next");
});

test("two SQLite instances with one expected revision produce exactly one winner", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dcf-store-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "models.sqlite");
  const first = SqliteModelStore.open<Snapshot, Summary>(path, codec);
  const second = SqliteModelStore.open<Snapshot, Summary>(path, codec);
  t.after(() => first.close());
  t.after(() => second.close());

  first.create(modelMeta(), input("created"));
  const firstExpected = first.getRevision("model-1")!.revision;
  const secondExpected = second.getRevision("model-1")!.revision;
  assert.equal(firstExpected, secondExpected);
  assert.equal(first.commit("model-1", firstExpected, input("winner")).revision, 1);
  assert.throws(
    () => second.commit("model-1", secondExpected, input("loser")),
    (error: unknown) => {
      assert.ok(error instanceof FinancialModelError);
      assert.equal(error.code, "revision_conflict");
      assert.deepEqual(error.details, { currentRevision: 1 });
      return true;
    },
  );
  assert.deepEqual(second.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
});

test("codec failure writes nothing and the next successful commit has no gap", (t) => {
  for (const kind of ["memory", "sqlite"] as const) {
    let failDecode = false;
    const controlledCodec: SnapshotCodec<Snapshot> = {
      encode: codec.encode,
      decode: (json) => {
        if (failDecode) throw new Error("intentional codec failure");
        return codec.decode(json);
      },
    };
    const store = kind === "memory"
      ? new InMemoryModelStore<Snapshot, Summary>(controlledCodec)
      : SqliteModelStore.open<Snapshot, Summary>(":memory:", controlledCodec);
    if (store instanceof SqliteModelStore) t.after(() => store.close());

    store.create(modelMeta(`${kind}-model`), input("created"));
    failDecode = true;
    assert.throws(
      () => store.commit(`${kind}-model`, 0, input("rejected")),
      isCode("invalid_snapshot"),
    );
    failDecode = false;
    assert.deepEqual(store.listRevisionHeaders(`${kind}-model`).map((header) => header.revision), [0]);
    assert.equal(store.commit(`${kind}-model`, 0, input("accepted")).revision, 1);
  }
});

test("malformed codec output is rejected before create touches either store", (t) => {
  const malformedCodec: SnapshotCodec<Snapshot> = {
    encode: () => "not-json",
    decode: () => ({ values: [], label: "permissive" }),
  };
  const stores: Store[] = [
    new InMemoryModelStore<Snapshot, Summary>(malformedCodec),
    SqliteModelStore.open<Snapshot, Summary>(":memory:", malformedCodec),
  ];
  t.after(() => (stores[1] as SqliteModelStore<Snapshot, Summary>).close());
  for (const store of stores) {
    assert.throws(() => store.create(modelMeta(), input("created")), isCode("invalid_snapshot"));
    assert.equal(store.getMeta("model-1"), undefined);
  }
});

test("generic stores accept Map domain snapshots through a JSON snapshot codec", (t) => {
  type MapSnapshot = { cells: Map<string, number> };
  const mapCodec: SnapshotCodec<MapSnapshot> = {
    encode: (snapshot) => JSON.stringify({ cells: [...snapshot.cells.entries()] }),
    decode: (json) => {
      const parsed = JSON.parse(json) as { cells: Array<[string, number]> };
      return { cells: new Map(parsed.cells) };
    },
  };
  const revisionInput: RevisionInput<MapSnapshot, Summary> = {
    lifecycleStage: "draft",
    snapshot: { cells: new Map([["revenue@FY2025", 100]]) },
    changeSummary: { kind: "created" },
    engineVersion: "1",
    creatingSessionId: "session-1",
  };
  const stores = [
    new InMemoryModelStore<MapSnapshot, Summary>(mapCodec),
    SqliteModelStore.open<MapSnapshot, Summary>(":memory:", mapCodec),
  ];
  t.after(() => (stores[1] as SqliteModelStore<MapSnapshot, Summary>).close());
  for (const store of stores) {
    const created = store.create(modelMeta(), revisionInput);
    assert.equal(created.snapshot.cells.get("revenue@FY2025"), 100);
  }
});

test("revision headers never decode stored snapshots", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dcf-store-headers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "models.sqlite");
  const writer = SqliteModelStore.open<Snapshot, Summary>(path, codec);
  writer.create(modelMeta(), input("created"));
  writer.commit("model-1", 0, input("next"));
  writer.close();

  const throwingCodec: SnapshotCodec<Snapshot> = {
    encode: codec.encode,
    decode: () => { throw new Error("snapshot decode must not run"); },
  };
  const reader = SqliteModelStore.open<Snapshot, Summary>(path, throwingCodec);
  t.after(() => reader.close());
  assert.deepEqual(reader.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
  assert.equal(reader.getMeta("model-1")?.currentRevision, 1);
  assert.throws(() => reader.getRevision("model-1", 0), isCode("invalid_snapshot"));
});

test("a non-conflict SQLite failure is not mislabeled revision_conflict", () => {
  const store = SqliteModelStore.open<Snapshot, Summary>(":memory:", codec);
  store.create(modelMeta(), input("created"));
  store.close();
  assert.throws(() => store.commit("model-1", 0, input("after-close")), (error: unknown) => {
    return !(error instanceof FinancialModelError && error.code === "revision_conflict");
  });
});
