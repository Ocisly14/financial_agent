import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFormula } from "../dsl/parser.ts";
import { ENGINE_VERSION, evaluate, type EngineInput } from "../engine.ts";
import { FinancialModelError } from "../errors.ts";
import type { FinancialModelSnapshot } from "../operations.ts";
import { createSkeleton } from "../skeleton.ts";
import { financialModelSnapshotCodec } from "../snapshotCodec.ts";
import { SqliteModelStore, type SnapshotCodec } from "../store.ts";
import type { Diagnostic, Period, ValuationConfig } from "../types.ts";

const PERIODS: Period[] = [
  {
    id: "FY2025",
    label: "FY2025",
    start: "2025-01-01",
    end: "2025-12-31",
    cls: "actual",
  },
  {
    id: "FY2026",
    label: "FY2026",
    start: "2026-01-01",
    end: "2026-12-31",
    cls: "forecast",
  },
  {
    id: "FY2027",
    label: "FY2027",
    start: "2027-01-01",
    end: "2027-12-31",
    cls: "forecast",
  },
];

const VALUATION_CONFIG: ValuationConfig = {
  anchorPeriodId: "FY2025",
  discountConvention: "year_end",
  exitTerminalMetric: "ebitda",
  sensitivity: {
    waccDeltas: [-0.01, 0, 0.01],
    terminalGrowthDeltas: [-0.005, 0, 0.005],
    exitMultipleDeltas: [-1, 0, 1],
  },
  sourceType: "analyst_inference",
  sourceRefs: ["https://example.com/methodology"],
  asOfDate: "2026-01-01",
  rationale: "Determinism fixture.",
};

function engineInput(): EngineInput {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  return {
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    facts: [],
    assumptions: [],
    formulas: skeleton.formulas,
    valuationConfig: VALUATION_CONFIG,
  };
}

function orderedDiagnostics(
  output: ReturnType<typeof evaluate>,
): Diagnostic[] {
  return output.order.flatMap((key) =>
    output.cells.get(key)?.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      refs: [...diagnostic.refs],
    })) ?? []);
}

function snapshot(output = evaluate(engineInput())): FinancialModelSnapshot {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  return {
    lifecycleStage: "draft",
    periods: PERIODS.map((period) => ({ ...period })),
    lineItems: skeleton.lineItems.map((item) => ({ ...item, unit: { ...item.unit } })),
    facts: [],
    factReviewDecisions: [],
    assumptions: [],
    formulas: skeleton.formulas.map((formula) => ({
      ...formula,
      ...(formula.periodIds === undefined ? {} : { periodIds: [...formula.periodIds] }),
    })),
    compiledFormulas: skeleton.formulas.map((formula) => ({
      ...formula,
      ...(formula.periodIds === undefined ? {} : { periodIds: [...formula.periodIds] }),
      ast: parseFormula(formula.source),
    })),
    selectedHistoricalPeriodIds: [],
    categoryGroups: [],
    valuationConfig: structuredClone(VALUATION_CONFIG),
    cells: new Map(output.cells),
    diagnostics: orderedDiagnostics(output),
    reconciliationResults: [],
    valuation: null,
    waccSheet: null,
    engineVersion: ENGINE_VERSION,
  };
}

test("reordering non-semantic engine inputs preserves byte-identical ordered results", () => {
  const original = engineInput();
  const first = evaluate(original);
  const second = evaluate({
    ...original,
    lineItems: [...original.lineItems].reverse(),
    facts: [...original.facts].reverse(),
    assumptions: [...original.assumptions].reverse(),
    formulas: [...original.formulas].reverse(),
  });

  assert.deepEqual(second.order, first.order);
  assert.deepEqual([...second.cells], [...first.cells]);
  assert.equal(
    financialModelSnapshotCodec.encode(snapshot(second)),
    financialModelSnapshotCodec.encode(snapshot(first)),
  );
});

test("SQLite round-trip and repeated equivalent commits preserve snapshot bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "financial-model-determinism-"));
  const path = join(directory, "models.sqlite");
  const expected = financialModelSnapshotCodec.encode(snapshot());
  try {
    let store = SqliteModelStore.open<FinancialModelSnapshot>(
      path,
      financialModelSnapshotCodec,
    );
    store.create(
      {
        modelId: "deterministic-model",
        ownerAgentId: "agent:test",
        originSessionId: "session:test",
        symbol: "TEST",
        metadata: { fixture: "determinism" },
      },
      {
        lifecycleStage: "draft",
        snapshot: snapshot(),
        changeSummary: { kind: "model_created" },
        engineVersion: ENGINE_VERSION,
        creatingSessionId: "session:test",
      },
    );
    store.close();

    store = SqliteModelStore.open<FinancialModelSnapshot>(
      path,
      financialModelSnapshotCodec,
    );
    const reloaded = store.getRevision("deterministic-model", 0)!;
    assert.equal(financialModelSnapshotCodec.encode(reloaded.snapshot), expected);
    store.commit("deterministic-model", 0, {
      lifecycleStage: "draft",
      snapshot: reloaded.snapshot,
      changeSummary: { kind: "input_equivalent_recalculation" },
      engineVersion: ENGINE_VERSION,
      creatingSessionId: "session:test",
    });
    const repeated = store.commit("deterministic-model", 1, {
      lifecycleStage: "draft",
      snapshot: reloaded.snapshot,
      changeSummary: { kind: "input_equivalent_recalculation" },
      engineVersion: ENGINE_VERSION,
      creatingSessionId: "session:test",
    });
    assert.equal(financialModelSnapshotCodec.encode(repeated.snapshot), expected);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revision headers do not decode old snapshots and a latest read decodes exactly one", () => {
  const directory = mkdtempSync(join(tmpdir(), "financial-model-headers-"));
  const path = join(directory, "models.sqlite");
  try {
    let store = SqliteModelStore.open<FinancialModelSnapshot>(
      path,
      financialModelSnapshotCodec,
    );
    store.create(
      {
        modelId: "header-model",
        ownerAgentId: "agent:test",
        originSessionId: "session:test",
        symbol: "HEAD",
        metadata: {},
      },
      {
        lifecycleStage: "draft",
        snapshot: snapshot(),
        changeSummary: { kind: "model_created" },
        engineVersion: ENGINE_VERSION,
        creatingSessionId: "session:test",
      },
    );
    store.commit("header-model", 0, {
      lifecycleStage: "draft",
      snapshot: snapshot(),
      changeSummary: { kind: "recalculated" },
      engineVersion: ENGINE_VERSION,
      creatingSessionId: "session:test",
    });
    store.close();

    let decodeCount = 0;
    const instrumented: SnapshotCodec<FinancialModelSnapshot> = {
      encode: (value) => financialModelSnapshotCodec.encode(value),
      decode: (json) => {
        decodeCount += 1;
        return financialModelSnapshotCodec.decode(json);
      },
    };
    store = SqliteModelStore.open<FinancialModelSnapshot>(path, instrumented);
    assert.equal(store.listRevisionHeaders("header-model").length, 2);
    assert.equal(decodeCount, 0);
    assert.equal(store.getRevision("header-model")?.revision, 1);
    assert.equal(decodeCount, 1);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed authoritative period order is rejected rather than normalized", () => {
  const malformed = snapshot();
  malformed.periods = [...malformed.periods].reverse();
  assert.throws(
    () => financialModelSnapshotCodec.encode(malformed),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "invalid_snapshot",
  );
});
