import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLlmProvider } from "../../src/agent/createApp.ts";
import { createDcfSubagentTool } from "../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { createFinancialModelTools } from "../../mcp_tools/financial-model/financialModelTools.ts";
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
import type { JsonObject } from "../../src/framework/types.ts";

// Manual, network-gated smoke for the WHOLE DCF ingestion chain:
//   statement_extraction                      Arelle extraction + deterministic face selection
//   create_financial_model                    auto-premap layers 1 + 2a fill the workbook
//   run_dcf_subagent revenue_decomposition    N parallel filing_decomposition maps + one reduce
//   apply_revenue_decomposition               materialize children + premap layer 2b injection
//   mapping_review                            the agent audits the premap as a delta
//
// SMOKE_SKIP_DECOMPOSITION=1 drops the two middle stages when only premap/mapping matter.
//
//   node --env-file=.env --experimental-strip-types --experimental-sqlite \
//     scripts/xbrl/smoke-premap-mapping-review.ts
//
// SMOKE_SKIP_INSIGHTS=1 replaces the small-model insight generator with a local no-op, so the
// run exercises extraction/premap/mapping without ~60 filing-insight calls. Insights feed only
// forecast_modeling and valuation_review, never premap or mapping_review.

const companion = fileURLToPath(new URL("./arelle_companion.py", import.meta.url));
const command = process.env["ARELLE_ADAPTER_COMMAND"]?.trim() || "python3";
const args = process.env["ARELLE_ADAPTER_ARGS"] ? parseArgs(process.env["ARELLE_ADAPTER_ARGS"]!) : [companion];
const historyYears = boundedInteger(process.env["SMOKE_HISTORY_YEARS"], 5, 2, 5);
const symbol = (process.env["SMOKE_SYMBOL"]?.trim() || "AAPL").toUpperCase();
const skipInsights = process.env["SMOKE_SKIP_INSIGHTS"] === "1";
const skipDecomposition = process.env["SMOKE_SKIP_DECOMPOSITION"] === "1";
const runTimestamp = new Date().toISOString();
const outputDirectory = resolve(process.env["SMOKE_OUTPUT_DIR"]?.trim()
  || join("data", "smoke", "xbrl", `${symbol.toLowerCase()}-${historyYears}y-premap-mapping-review-${runTimestamp.slice(0, 10)}`));
const provider = createPreparedStatementProvider({ arelle: createArelleProcessRunner({ command, args, timeoutMs: 300_000 }) });
const OWNER = { agentId: "smoke-owner", sessionId: "smoke-session" };

await mkdir(outputDirectory, { recursive: true });

const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const sourceStore = new InMemorySourceReviewStore();
const tableStore = SqliteFilingTableStore.open(join(outputDirectory, "filing-tables.sqlite"));
const financialDeps = {
  modelStore,
  insightStore: new InMemoryFilingInsightStore(),
  sourceReviewStore: sourceStore,
  ingestionStore: sourceStore,
  decompositionStore: new InMemoryDecompositionStore(),
};
const modelRouter = new ModelRouter(resolveLlmProvider());
const subagentTool = createDcfSubagentTool({
  modelRouter,
  financial: financialDeps,
  provider,
  tableStore,
  // The extractor still chunks the filings; only the per-chunk model call is stubbed out.
  ...(skipInsights ? { generateInsights: async () => ({ insights: [] }) } : {}),
});
const modelTools = new Map(createFinancialModelTools(financialDeps).map((entry) => [entry.name, entry]));

try {
  process.stdout.write(`\n[1/5] statement_extraction — ${symbol}, ${historyYears}y${skipInsights ? " (insights skipped)" : ""}\n`);
  const extracted = await subagentTool.execute({ subagent: "statement_extraction", symbol, historyYears, forecastYears: 3 }, OWNER);
  if (extracted.error) throw new Error(`statement extraction failed: ${extracted.error.code}: ${extracted.error.message}`);
  const ingestionRunId = String((extracted.generation_context!.data as JsonObject)["ingestionRunId"]);
  const ingestion = sourceStore.getIngestion(ingestionRunId)!;
  process.stdout.write(`      run ${ingestionRunId} — ${ingestion.source?.filings.length ?? 0} filing(s), diagnostics: ${(ingestion.diagnostics ?? []).length}\n`);

  process.stdout.write(`\n[2/5] create_financial_model — deterministic auto-premap (layers 1 + 2a)\n`);
  const created = await modelTools.get("create_financial_model")!.execute({ symbol, ingestionRunId }, OWNER);
  if (created.error) throw new Error(`model creation failed: ${created.error.code}: ${created.error.message}`);
  const createdData = created.generation_context!.data as JsonObject;
  const modelId = String(createdData["model_id"]);
  const premap = createdData["premap"] as JsonObject | null;
  const mapped = (premap?.["mapped"] ?? []) as Array<JsonObject>;
  const unmapped = (premap?.["unmapped"] ?? {}) as JsonObject;
  const demoted = (premap?.["demoted"] ?? []) as Array<JsonObject>;
  process.stdout.write(`      model ${modelId} @ revision ${String(createdData["revision"])}\n`);
  process.stdout.write(`      premap: ${mapped.length} target(s) mapped, ${((unmapped["spineTargets"] ?? []) as unknown[]).length} spine target(s) unmapped, `
    + `${((unmapped["sourceRows"] ?? []) as unknown[]).length} source row(s) unconsumed, ${demoted.length} demoted\n`);
  for (const entry of mapped) {
    const rows = (entry["sourceRows"] ?? []) as Array<JsonObject>;
    process.stdout.write(`        ${String(entry["targetLineItemId"]).padEnd(38)} ← ${rows.map((row) => row["label"]).join(" + ")}`
      + `  [${String(entry["basis"])}, ${((entry["periodIds"] ?? []) as unknown[]).length}p]\n`);
  }
  for (const entry of demoted) process.stdout.write(`        DEMOTED ${String(entry["targetLineItemId"])}: ${String(entry["reason"])}\n`);
  await writeJson(join(outputDirectory, "premap.json"), { modelId, revision: createdData["revision"], premap });
  await writeJson(join(outputDirectory, "workbook-after-premap.json"), createdData["current_workbook"] ?? null);

  let decompositionSummary: JsonObject | null = null;
  let applySummary: JsonObject | null = null;
  if (skipDecomposition) {
    process.stdout.write(`\n[3/5] revenue_decomposition — SKIPPED (SMOKE_SKIP_DECOMPOSITION=1)\n[4/5] apply_revenue_decomposition — SKIPPED\n`);
  } else {
    process.stdout.write(`\n[3/5] revenue_decomposition — ${ingestion.source?.filings.length ?? 0} parallel filing_decomposition map(s) + reduce\n`);
    const decomposed = await subagentTool.execute({
      subagent: "revenue_decomposition", modelId,
      task: `Decompose ${symbol}'s consolidated revenue into non-overlapping economic drivers (product line, geography, or segment) using each filing's disclosed tables.`,
    }, OWNER);
    if (decomposed.error) throw new Error(`revenue_decomposition failed: ${decomposed.error.code}: ${decomposed.error.message}`);
    decompositionSummary = (decomposed.generation_context!.data as JsonObject)["decomposition"] as JsonObject;
    const candidates = (decompositionSummary["candidates"] ?? []) as Array<JsonObject>;
    const driverSchemeId = decompositionSummary["driverSchemeId"] as string | null;
    const diagnostics = (decompositionSummary["diagnostics"] ?? []) as string[];
    process.stdout.write(`      ${candidates.length} candidate scheme(s), driver ${driverSchemeId ?? "none"}, ${diagnostics.length} diagnostic(s)\n`);
    for (const candidate of candidates) {
      const children = (candidate["children"] ?? []) as Array<JsonObject>;
      process.stdout.write(`        [${candidate["candidateSchemeId"] === driverSchemeId ? "DRIVER" : "      "}] ${String(candidate["label"])}`
        + ` (axis ${String(candidate["axisHint"])}) → ${children.map((child) => child["label"]).join(" | ")}\n`);
      process.stdout.write(`                 residuals ${JSON.stringify(candidate["residualRatioByPeriod"])}`
        + ` flags ${JSON.stringify(candidate["flags"])}\n`);
    }
    for (const line of diagnostics) process.stdout.write(`        diag: ${line}\n`);
    await writeJson(join(outputDirectory, "revenue-decomposition.json"), decompositionSummary);

    process.stdout.write(`\n[4/5] apply_revenue_decomposition — materialize + premap layer 2b\n`);
    if (!driverSchemeId) {
      process.stdout.write(`      no driver scheme; nothing to apply\n`);
    } else {
      const applied = await modelTools.get("apply_revenue_decomposition")!.execute({
        modelId, acceptedSchemeIds: [driverSchemeId], driverSchemeId,
        rationale: "Smoke run accepts the reduce agent's ranked driver scheme.",
      }, OWNER);
      if (applied.error) throw new Error(`apply_revenue_decomposition failed: ${applied.error.code}: ${applied.error.message}`);
      applySummary = applied.generation_context!.data as JsonObject;
      const appliedPremap = applySummary["premap"] as JsonObject | null;
      const appliedMapped = (appliedPremap?.["mapped"] ?? []) as Array<JsonObject>;
      const streams = appliedMapped.filter((entry) => String(entry["targetLineItemId"]).startsWith("revenue."));
      process.stdout.write(`      revision ${String(applySummary["revision"])}; premap now maps ${appliedMapped.length} target(s), `
        + `${streams.length} revenue stream(s); demoted ${((applySummary["demoted"] ?? []) as unknown[]).length}\n`);
      for (const stream of streams) {
        process.stdout.write(`        ${String(stream["targetLineItemId"]).padEnd(38)} [${String(stream["basis"])}, `
          + `${((stream["periodIds"] ?? []) as unknown[]).length}p]\n`);
      }
      await writeJson(join(outputDirectory, "apply-revenue-decomposition.json"), applySummary);
    }
  }

  process.stdout.write(`\n[5/5] mapping_review — agent audits the premap\n`);
  const reviewStartedAt = new Date().toISOString();
  const review = await subagentTool.execute({
    subagent: "mapping_review",
    modelId,
    task: `The engine already pre-mapped ${symbol}'s face statements. Audit that premap: confirm what is right, remap what is wrong (with a reason), add the unmapped rows that belong in the DCF, and split any combined row that needs it.`,
  }, OWNER);
  const proposal = (review.generation_context?.data as JsonObject | undefined)?.["proposal"] as JsonObject | undefined;
  const payload = proposal?.["payload"] as JsonObject | undefined;
  const plans = (payload?.["statementMappingPlans"] ?? []) as Array<JsonObject>;
  const categories = (payload?.["categoryLineItems"] ?? []) as Array<JsonObject>;
  const groups = (payload?.["categoryGroups"] ?? []) as Array<JsonObject>;
  const mappedTargets = new Set(mapped.map((entry) => String(entry["targetLineItemId"])));
  const remaps = plans.filter((plan) => mappedTargets.has(String(plan["targetLineItemId"])));
  process.stdout.write(review.error
    ? `      ERROR ${review.error.code}: ${review.error.message}\n`
    : `      ${plans.length} plan(s) proposed — ${remaps.length} remap engine targets, ${plans.length - remaps.length} new; `
      + `${categories.length} new category line item(s), ${groups.length} group(s)\n`);
  for (const plan of plans) {
    const members = (plan["members"] ?? []) as Array<JsonObject>;
    process.stdout.write(`        ${mappedTargets.has(String(plan["targetLineItemId"])) ? "REMAP" : "ADD  "} `
      + `${String(plan["targetLineItemId"]).padEnd(38)} ← ${members.map((member) => member["sourceLineItemId"]).join(", ")}\n`);
  }
  if (proposal?.["rationale"]) process.stdout.write(`      rationale: ${String(proposal["rationale"]).slice(0, 400)}\n`);

  const manifest = {
    createdAt: runTimestamp, symbol, historyYears, skipInsights, skipDecomposition, ingestionRunId, modelId, outputDirectory,
    decomposition: decompositionSummary === null ? null : {
      driverSchemeId: decompositionSummary["driverSchemeId"] ?? null,
      candidateCount: ((decompositionSummary["candidates"] ?? []) as unknown[]).length,
      diagnostics: decompositionSummary["diagnostics"] ?? [],
    },
    applyRevision: applySummary?.["revision"] ?? null,
    premapCounts: {
      mapped: mapped.length,
      unmappedSpineTargets: ((unmapped["spineTargets"] ?? []) as unknown[]).length,
      unmappedSourceRows: ((unmapped["sourceRows"] ?? []) as unknown[]).length,
      demoted: demoted.length,
    },
    mappingReview: {
      startedAt: reviewStartedAt, completedAt: new Date().toISOString(),
      error: review.error ?? null, summary: review.summary,
      planCount: plans.length, remapCount: remaps.length,
      categoryLineItemCount: categories.length, categoryGroupCount: groups.length,
      rationale: proposal?.["rationale"] ?? null,
    },
  };
  await writeJson(join(outputDirectory, "mapping-review-proposal.json"), { manifest, proposal: proposal ?? null });
  await writeJson(join(outputDirectory, "manifest.json"), manifest);
  process.stdout.write(`\n${JSON.stringify(manifest, null, 2)}\n`);
  if (review.error) process.exitCode = 1;
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
