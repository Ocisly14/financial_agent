import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore, type FilingIngestionArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { InMemoryDecompositionStore } from "../../../src/infra/xbrl/decompositionStore.ts";
import type { FilingTable, TableCuration } from "../../../src/infra/xbrl/tableTypes.ts";
import type { PreparedFilingStatements, PresentationExtract } from "../../../src/infra/xbrl/types.ts";
import { createFinancialModelTools, type FinancialModelToolDeps } from "../financialModelTools.ts";
import { formatAllowedTools } from "../../../src/framework/subagent.ts";

function fixture(): { deps: FinancialModelToolDeps; ingestion: InMemorySourceReviewStore; prepared: PreparedFilingStatements } {
  const ingestion = new InMemorySourceReviewStore();
  const periods = [
    { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" as const },
    { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" as const },
    { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" as const },
    { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" as const },
  ];
  const rows = (["income_statement", "balance_sheet", "cash_flow_statement"] as const).map((statement, index) => ({
    sourceLineItemId: `source.${statement}.row`, statement, label: `${statement} row`, unit: { kind: "currency" as const, code: "USD" }, order: index,
  }));
  const facts = rows.map((row, index) => ({ factId: `f${index}`, status: "staged" as const, lineItemId: row.sourceLineItemId,
    periodId: "FY2024", value: 100 + index, unit: row.unit, provenance: { sourceType: "filing_xbrl", sourceRefs: ["fixture"], asOfDate: "2026-02-01" } }));
  const statementViews = Object.fromEntries(rows.map((row) => [row.statement, { candidate: { periods, rows: [] }, filingPresentations: [] }])) as unknown as PreparedFilingStatements["statementViews"];
  const prepared: PreparedFilingStatements = { filings: [], periods, rows, facts, statementViews, dimensionalDisclosures: [], diagnostics: [],
    coverage: { requestedPeriodIds: ["FY2024"], statements: rows.map((row) => ({ statement: row.statement, availablePeriodIds: ["FY2024"], missingPeriodIds: [] })), issues: [] } };
  return { ingestion, prepared, deps: { modelStore: new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec),
    insightStore: new InMemoryFilingInsightStore(), sourceReviewStore: ingestion, ingestionStore: ingestion,
    decompositionStore: new InMemoryDecompositionStore() } };
}

const CURATED_STATEMENTS = ["income_statement", "balance_sheet", "cash_flow_statement"] as const;
const curatedTables: FilingTable[] = CURATED_STATEMENTS.map((statement, index) => ({
  sourceTableId: `filing:html-table:${index + 1}`, accession: "filing", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
  heading: statement, htmlOrder: index + 1, sourceAnchor: `https://sec.test/filing#table=${index + 1}`,
  prescreen: { tier: "strong", presentationOverlap: 0.9, dimensionlessRatio: 1, periodSpan: 1, factCount: 1 },
  suggestedStatements: [statement], columns: [], rows: [],
}));
const curations: TableCuration[] = CURATED_STATEMENTS.map((statement, index) => ({
  sourceTableId: `filing:html-table:${index + 1}`, statement, reportDate: "2025-12-31", kind: "face",
  rationale: "Consolidated statement heading and complete annual columns.",
}));

const presentationExtracts: PresentationExtract[] = [{
  filing: { accession: "filing", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31", primaryDocumentUrl: "https://sec.test/filing" },
  calculationRelations: [], negatedConcepts: [], statements: [],
}];

function run(ready = true) {
  const value = fixture();
  const artifact: FilingIngestionArtifact = { ingestionRunId: "ing-1", modelId: "model-1", ownerAgentId: "owner-1", symbol: "TEST",
    status: ready ? "ready" : "failed", source: { company: { cik: 1, ticker: "TEST", title: "Test Co" }, reportingCurrency: "USD",
      fiscalYearEnd: "12-31", periods: value.prepared.periods, filings: [] }, diagnostics: [],
    curatedTables: structuredClone(curatedTables), curations: structuredClone(curations),
    presentationExtracts: structuredClone(presentationExtracts),
    ...(ready ? { prepared: value.prepared } : { error: { code: "incomplete_financial_statements", message: "cash flow missing" } }) };
  value.ingestion.saveIngestion(artifact);
  return { ...value, tools: new Map(createFinancialModelTools(value.deps).map((tool) => [tool.name, tool])) };
}

test("create consumes an owned ingestion exactly once and writes explicit revisions zero and one", async () => {
  const { deps, tools } = run();
  const result = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(result.error, undefined);
  assert.equal(result.generation_context?.data["revision"], 1);
  assert.deepEqual(deps.modelStore.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
  const duplicate = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(duplicate.error?.code, "filing_ingestion_not_found");
});

test("failed three-statement ingestion leaves a durable revision zero", async () => {
  const { deps, tools } = run(false);
  const result = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(result.error?.code, "incomplete_financial_statements");
  assert.equal(deps.modelStore.getRevision("model-1")?.revision, 0);
});

test("all reads and mutations are owner scoped without disclosing another owner's model", async () => {
  const { tools } = run();
  await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  const read = await tools.get("get_financial_model")!.execute({ modelId: "model-1" }, { agentId: "owner-2", sessionId: "s2" });
  const archive = await tools.get("archive_financial_model")!.execute({ modelId: "model-1", expectedRevision: 1 }, { agentId: "owner-2", sessionId: "s2" });
  const list = await tools.get("list_financial_models")!.execute({}, { agentId: "owner-2", sessionId: "s2" });
  assert.equal(read.error?.code, "financial_model_not_found");
  assert.equal(archive.error?.code, "financial_model_not_found");
  assert.deepEqual(list.generation_context?.data["models"], []);
});

test("ingestion ownership/symbol checks do not consume the artifact, but successful use does", async () => {
  const { tools } = run();
  const wrongOwner = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-2", sessionId: "s" });
  const wrongSymbol = await tools.get("create_financial_model")!.execute({ symbol: "NOPE", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(wrongOwner.error?.code, "filing_ingestion_not_found");
  assert.equal(wrongSymbol.error?.code, "filing_ingestion_not_found");
  const valid = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(valid.error, undefined);
});

test("create carries the curation loop's tables and decisions into the source review artifact", async () => {
  const { ingestion, tools } = run();
  const created = await tools.get("create_financial_model")!.execute(
    { symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(created.error, undefined);
  const source = ingestion.get("model-1")!;
  assert.deepEqual(source.curations, curations);
  assert.deepEqual(source.curatedTables.map((table) => table.sourceTableId), curatedTables.map((table) => table.sourceTableId));
  assert.deepEqual(source.presentationExtracts, presentationExtracts);
  assert.ok(source.presentationExtracts!.every((extract) => !("tables" in extract)));
});

test("history review commits without any table classification gate", async () => {
  const { tools } = run();
  await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  const reviewed = await tools.get("review_financial_model_history")!.execute({ modelId: "model-1", expectedRevision: 1,
    selectedHistoricalPeriodIds: ["FY2024"], decisions: [], categoryLineItems: [], statementMappingPlans: [], categoryGroups: [],
  }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(reviewed.error, undefined);
  assert.equal(reviewed.generation_context?.data["revision"], 2);
});

test("tool schemas expose nested operation contracts and reject unknown or malformed payloads", async () => {
  const { tools } = run();
  const reviewSchema = tools.get("review_financial_model_history")!.inputSchema;
  assert.ok(reviewSchema.properties?.["decisions"]?.items?.properties?.["action"]?.enum?.includes("commit"));
  const operationItems = tools.get("apply_financial_model_operations")!.inputSchema.properties?.["operations"]?.items;
  assert.ok(operationItems?.oneOf?.some((variant) => variant.properties?.["kind"]?.enum?.includes("set_assumption")));
  const rendered = formatAllowedTools([tools.get("apply_financial_model_operations")!]);
  for (const field of ["set_assumption", "set_formula", "set_valuation_config", "assumptionId", "sensitivity"]) assert.match(rendered, new RegExp(field));

  const unknown = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1", surprise: true }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(unknown.error?.code, "invalid_tool_input");
  const invalidReview = await tools.get("review_financial_model_history")!.execute({ modelId: "m", expectedRevision: 1,
    selectedHistoricalPeriodIds: [], decisions: [{ action: "commit" }], categoryLineItems: [], statementMappingPlans: [], categoryGroups: [] },
  { agentId: "owner-1", sessionId: "s" });
  assert.equal(invalidReview.error?.code, "invalid_tool_input");
  const invalidOperation = await tools.get("apply_financial_model_operations")!.execute({ modelId: "m", expectedRevision: 1,
    operations: [{ kind: "invented_operation" }] }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(invalidOperation.error?.code, "invalid_tool_input");
});

test("a review decision may omit reviewedAt, and the committed ledger carries the host's stamp", async () => {
  const { deps, tools } = run();
  const owner = { agentId: "owner-1", sessionId: "s" };
  await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, owner);
  const staged = deps.modelStore.getRevision("model-1")!.snapshot.facts.find((fact) => fact.status === "staged")!;
  const before = new Date().toISOString();

  const reviewed = await tools.get("review_financial_model_history")!.execute({
    modelId: "model-1", expectedRevision: 1, selectedHistoricalPeriodIds: ["FY2024"],
    decisions: [{ decisionId: "d1", factId: staged.factId, action: "commit", mappedLineItemId: staged.lineItemId!,
      rationale: "Confirmed against the filing", reviewedBy: "mapping_review_subagent" }],
    categoryLineItems: [], statementMappingPlans: [], categoryGroups: [],
  }, owner);

  assert.equal(reviewed.error, undefined);
  const stamped = deps.modelStore.getRevision("model-1")!.snapshot.factReviewDecisions.find((entry) => entry.decisionId === "d1");
  assert.ok(stamped, "the decision was committed");
  assert.ok(stamped!.reviewedAt >= before && stamped!.reviewedAt <= new Date().toISOString());
});
