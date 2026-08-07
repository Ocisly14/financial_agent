import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLlmProvider } from "../../src/agent/createApp.ts";
import { createDcfSubagentTool } from "../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { DcfSubagentRegistry } from "../../src/agent/financial-modeling/subagents.ts";
import { runRevenueDecomposition } from "../../src/agent/financial-modeling/revenueDecomposition.ts";
import type { FinancialModelSnapshot } from "../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../src/infra/filing-insights/store.ts";
import { ModelRouter } from "../../src/infra/llm/provider.ts";
import { createArelleProcessRunner } from "../../src/infra/xbrl/arelleAdapter.ts";
import { InMemoryDecompositionStore } from "../../src/infra/xbrl/decompositionStore.ts";
import { SqliteFilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import { createPreparedStatementProvider } from "../../src/infra/xbrl/preparedStatementProvider.ts";
import { InMemorySourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import type { SourceReviewArtifact } from "../../src/infra/xbrl/sourceReviewStore.ts";

// Manual, network-gated smoke test for the revenue-decomposition pipeline (spec §9):
// resolve + extract AAPL filings, curate face statements, assemble a SourceReviewArtifact,
// then run the real filing_decomposition / decomposition_reduce subagent loops end to end.
//
// Run manually only (needs SEC network access + a live LLM provider):
//   node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/smoke-revenue-decomposition.ts

const companion = fileURLToPath(new URL("./arelle_companion.py", import.meta.url));
const command = process.env["ARELLE_ADAPTER_COMMAND"]?.trim() || "python3";
const args = process.env["ARELLE_ADAPTER_ARGS"]
  ? parseArgs(process.env["ARELLE_ADAPTER_ARGS"]!)
  : [companion];
const historyYears = boundedInteger(process.env["SMOKE_HISTORY_YEARS"], 5, 2, 5);
const symbol = (process.env["SMOKE_SYMBOL"]?.trim() || "AAPL").toUpperCase();
// Insights feed only forecast_modeling/valuation_review; skipping them drops ~60 small-model
// calls without touching anything the decomposition pipeline reads.
const skipInsights = process.env["SMOKE_SKIP_INSIGHTS"] === "1";
const runTimestamp = new Date().toISOString();
const dateStamp = runTimestamp.slice(0, 10);
const outputDirectory = resolve(process.env["SMOKE_OUTPUT_DIR"]?.trim()
  || join("data", "smoke", "xbrl", `${symbol.toLowerCase()}-${historyYears}y-revenue-decomposition-${dateStamp}`));
const provider = createPreparedStatementProvider({
  arelle: createArelleProcessRunner({ command, args, timeoutMs: 300_000 }),
});

await mkdir(outputDirectory, { recursive: true });

// In-memory model/insight/source-review stores throughout: this smoke never persists a DCF
// model, mirroring how runRevenueDecomposition's own tests exercise the pipeline directly
// (see revenueDecomposition.test.ts). The filing table store is sqlite because
// statement_extraction persists raw table catalogs it expects to page through by run id.
const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const insightStore = new InMemoryFilingInsightStore();
const sourceStore = new InMemorySourceReviewStore();
const tableStore = SqliteFilingTableStore.open(join(outputDirectory, "filing-tables.sqlite"));
const decompositionStore = new InMemoryDecompositionStore();
const financialDeps = {
  modelStore,
  insightStore,
  sourceReviewStore: sourceStore,
  ingestionStore: sourceStore,
  decompositionStore,
};
const modelRouter = new ModelRouter(resolveLlmProvider());
const extractionTool = createDcfSubagentTool({
  modelRouter,
  financial: financialDeps,
  provider,
  tableStore,
  ...(skipInsights ? { generateInsights: async () => ({ insights: [] }) } : {}),
});
const registry = new DcfSubagentRegistry();

try {
  const extracted = await extractionTool.execute({ subagent: "statement_extraction", symbol, historyYears, forecastYears: 3 }, {
    agentId: "smoke-owner",
    sessionId: "smoke-session",
  });
  if (extracted.error) throw new Error(`${symbol} statement extraction failed: ${extracted.error.code}: ${extracted.error.message}`);
  const extractionData = extracted.generation_context!.data as Record<string, unknown>;
  const ingestionRunId = String(extractionData["ingestionRunId"]);
  const ingestion = sourceStore.getIngestion(ingestionRunId)!;
  if (!ingestion.source || !ingestion.prepared) throw new Error(`${symbol} curation did not produce prepared statements`);
  const prepared = ingestion.prepared;

  const sourceReview: SourceReviewArtifact = {
    ingestionRunId,
    filings: prepared.filings,
    facts: prepared.facts,
    statementViews: prepared.statementViews,
    coverage: prepared.coverage,
    dimensionalDisclosures: prepared.dimensionalDisclosures,
    curatedTables: ingestion.curatedTables ?? [],
    curations: ingestion.curations ?? [],
    ...(ingestion.verification ? { verification: ingestion.verification } : {}),
  };
  await writeJson(join(outputDirectory, "source-review-artifact.json"), sourceReview);

  const mapPrompt = registry.get("filing_decomposition").prompt;
  const reducePrompt = registry.get("decomposition_reduce").prompt;
  const result = await runRevenueDecomposition({
    modelRouter,
    sourceReview,
    tableStore,
    store: decompositionStore,
    mapPrompt,
    reducePrompt,
    task: `Decompose ${symbol}'s consolidated revenue into non-overlapping economic drivers (e.g. product line, geography) using each filing's disclosed tables.`,
  });

  const rankedIds = result.decision?.ranked ?? [];
  const schemesById = new Map(result.candidates.map((candidate) => [candidate.candidateSchemeId, candidate]));
  const report = (rankedIds.length > 0 ? rankedIds : result.candidates.map((candidate) => candidate.candidateSchemeId))
    .map((id) => schemesById.get(id))
    .filter((candidate) => candidate !== undefined)
    .map((candidate) => ({
      candidateSchemeId: candidate.candidateSchemeId,
      label: candidate.label,
      axisHint: candidate.axisHint,
      isDriver: candidate.candidateSchemeId === result.decision?.driverSchemeId,
      coverage: candidate.coverage,
      residualRatioByPeriod: candidate.residualRatioByPeriod,
      flags: candidate.flags,
      children: candidate.children.map((child) => child.label),
    }));

  process.stdout.write(`\n${symbol} revenue decomposition — ${report.length} scheme(s), driver: ${result.decision?.driverSchemeId ?? "none"}\n`);
  for (const scheme of report) {
    process.stdout.write(`  [${scheme.isDriver ? "DRIVER" : "      "}] ${scheme.label} (axis: ${scheme.axisHint})\n`);
    process.stdout.write(`           coverage: ${JSON.stringify(scheme.coverage)}\n`);
    process.stdout.write(`           residuals: ${JSON.stringify(scheme.residualRatioByPeriod)}\n`);
    if (scheme.flags.length > 0) process.stdout.write(`           flags: ${scheme.flags.join(", ")}\n`);
  }
  if (result.diagnostics.length > 0) process.stdout.write(`  diagnostics: ${result.diagnostics.join(", ")}\n`);

  const manifest = {
    createdAt: runTimestamp,
    symbol,
    historyYears,
    ingestionRunId,
    outputDirectory,
    driverSchemeId: result.decision?.driverSchemeId ?? null,
    decisionRationale: result.decision?.rationale ?? null,
    diagnostics: result.diagnostics,
    schemes: report,
  };
  await writeJson(join(outputDirectory, "revenue-decomposition.json"), manifest);
  process.stdout.write(`\n${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  tableStore.close();
}

function parseArgs(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("ARELLE_ADAPTER_ARGS must be a JSON string array");
  }
  return parsed;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`SMOKE_HISTORY_YEARS must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
