import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InMemorySourceReviewStore, SqliteSourceReviewStore,
  type FilingIngestionArtifact, type FilingIngestionStore, type SourceReviewArtifact, type SourceReviewStore,
} from "../sourceReviewStore.ts";
import type { UnifiedStatementsArtifact } from "../unifiedStatements.ts";

const MODEL = "fm_1";
const RUN = "ing_1";

/**
 * Only the fields these tests read are real; the rest of the artifact is wide and none of it
 * participates in the store contract, which is why the cast stays local to the fixture.
 */
function review(overrides: Partial<SourceReviewArtifact> = {}): SourceReviewArtifact {
  return {
    ingestionRunId: RUN,
    statementViews: {}, filings: [], facts: [],
    coverage: {}, dimensionalDisclosures: [], curatedTables: [], curations: [],
    ...overrides,
  } as unknown as SourceReviewArtifact;
}

function unified(rowCount: number): UnifiedStatementsArtifact {
  return { rows: Array.from({ length: rowCount }, (_, index) => ({ rowId: `r${index}` })) } as unknown as UnifiedStatementsArtifact;
}

function ingestion(overrides: Partial<FilingIngestionArtifact> = {}): FilingIngestionArtifact {
  return { ingestionRunId: RUN, modelId: MODEL, ownerAgentId: "agent-1", symbol: "AAPL",
    status: "ready", diagnostics: [], ...overrides };
}

function suite(name: string, open: () => { store: SourceReviewStore & FilingIngestionStore; close: () => void }): void {
  test(`${name}: a saved review comes back`, () => {
    const { store, close } = open();
    try {
      store.save(MODEL, review());
      assert.equal(store.get(MODEL)?.ingestionRunId, RUN);
      assert.equal(store.get("fm_absent"), undefined);
    } finally { close(); }
  });

  // The regression this file exists for. `create_financial_model` writes the review once, then
  // `run_dcf_subagent` writes it again to attach `unifiedStatements` — so a save-once store fails
  // the whole DCF at the moment statement_unification hands back its artifact, after the subagent
  // has already spent its work. The in-memory store always overwrote; SQLite used a bare INSERT
  // against a PRIMARY KEY and threw "UNIQUE constraint failed".
  test(`${name}: saving the same model again overwrites rather than throwing`, () => {
    const { store, close } = open();
    try {
      store.save(MODEL, review());
      store.save(MODEL, review({ unifiedStatements: unified(2) }));

      assert.equal(store.get(MODEL)?.unifiedStatements?.rows.length, 2);
    } finally { close(); }
  });

  test(`${name}: the last save wins, field by field`, () => {
    const { store, close } = open();
    try {
      store.save(MODEL, review({ unifiedStatements: unified(2) }));
      store.save(MODEL, review({ ingestionRunId: "ing_2" }));

      const stored = store.get(MODEL);
      assert.equal(stored?.ingestionRunId, "ing_2");
      assert.equal(stored?.unifiedStatements, undefined);
    } finally { close(); }
  });

  test(`${name}: a stored review is a copy, not a live handle`, () => {
    const { store, close } = open();
    try {
      const artifact = review();
      store.save(MODEL, artifact);
      artifact.ingestionRunId = "mutated";

      assert.equal(store.get(MODEL)?.ingestionRunId, RUN);
    } finally { close(); }
  });

  test(`${name}: a saved ingestion comes back and consumes exactly once`, () => {
    const { store, close } = open();
    try {
      store.saveIngestion(ingestion());
      assert.equal(store.getIngestion(RUN)?.symbol, "AAPL");

      assert.equal(store.consumeIngestion(RUN, "agent-1", "AAPL")?.ingestionRunId, RUN);
      assert.equal(store.consumeIngestion(RUN, "agent-1", "AAPL"), undefined, "a consumed ingestion is spent");
      assert.equal(store.getIngestion("ing_absent"), undefined);
    } finally { close(); }
  });

  test(`${name}: consuming an ingestion checks owner and symbol`, () => {
    const { store, close } = open();
    try {
      store.saveIngestion(ingestion());

      assert.equal(store.consumeIngestion(RUN, "agent-2", "AAPL"), undefined, "wrong owner");
      assert.equal(store.consumeIngestion(RUN, "agent-1", "MSFT"), undefined, "wrong symbol");
      assert.equal(store.consumeIngestion(RUN, "agent-1", "AAPL")?.ingestionRunId, RUN);
    } finally { close(); }
  });

  // statementExtraction saves the ingestion on the way out of its own try block, so anything that
  // throws after that success write lands in the catch — which saves the same run id again, as
  // `failed`. A save-once store turns that into a UNIQUE error that buries the real failure.
  test(`${name}: re-saving an ingestion overwrites rather than masking the error that caused it`, () => {
    const { store, close } = open();
    try {
      store.saveIngestion(ingestion({ status: "ready" }));
      store.saveIngestion(ingestion({ status: "failed", error: { code: "arelle_unavailable", message: "boom" } }));

      const stored = store.getIngestion(RUN);
      assert.equal(stored?.status, "failed");
      assert.equal(stored?.error?.code, "arelle_unavailable");
    } finally { close(); }
  });
}

suite("in-memory", () => {
  const store = new InMemorySourceReviewStore();
  return { store, close: () => {} };
});

suite("sqlite", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-review-store-"));
  const store = SqliteSourceReviewStore.open(join(directory, "reviews.sqlite"));
  return { store, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
});
