import assert from "node:assert/strict";
import test from "node:test";
import { FinancialModelService, type CreateModelInput, type RevisionChangeSummary } from "../../financial-model/service.ts";
import type { FinancialModelSnapshot } from "../../financial-model/operations.ts";
import { financialModelSnapshotCodec } from "../../financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../financial-model/store.ts";
import type { Period } from "../../financial-model/types.ts";
import { getModelContext, listTopicModels } from "../financialModelRoutes.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
];

function createInput(overrides: Partial<CreateModelInput> = {}): CreateModelInput {
  return {
    modelId: "model-1",
    ownerAgentId: "agent-1",
    originSessionId: "topic-1",
    symbol: "TEST",
    metadata: { companyName: "Synthetic Company" },
    reportingCurrency: "USD",
    periods: PERIODS,
    preparedStatementRows: [{
      sourceLineItemId: "source.income_statement.revenue",
      statement: "income_statement",
      label: "Revenue",
      unit: { kind: "currency", code: "USD" },
      order: 1,
    }],
    ...overrides,
  };
}

function setup() {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  return { deps: { modelStore }, service: new FinancialModelService(modelStore, "test-session") };
}

test("listTopicModels returns only the models a topic owns", () => {
  const { deps, service } = setup();
  service.createModel(createInput());
  service.createModel(createInput({ modelId: "model-2", originSessionId: "topic-2", symbol: "OTHER" }));

  const result = listTopicModels(deps, "agent-1", "topic-1");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.models.map((model) => model.modelId), ["model-1"]);
  assert.equal(result.body.models[0]?.symbol, "TEST");
});

test("listTopicModels hides archived models", () => {
  const { deps, service } = setup();
  const created = service.createModel(createInput());
  service.archive("model-1", created.revision);

  assert.deepEqual(listTopicModels(deps, "agent-1", "topic-1").body.models, []);
});

test("getModelContext returns the full workbook context", () => {
  const { deps, service } = setup();
  service.createModel(createInput());

  const result = getModelContext(deps, "model-1");

  assert.equal(result.status, 200);
  assert.ok("currentWorkbook" in result.body);
  assert.equal(result.body.model.symbol, "TEST");
  assert.deepEqual(result.body.currentWorkbook.periods.map((period) => period.id), ["FY2024", "FY2025"]);
});

test("getModelContext reports 404 for an unknown model", () => {
  const { deps } = setup();

  const result = getModelContext(deps, "nope");

  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
});

test("getModelContext still reads an archived model by id", () => {
  const { deps, service } = setup();
  const created = service.createModel(createInput());
  service.archive("model-1", created.revision);

  assert.equal(getModelContext(deps, "model-1").status, 200);
});
