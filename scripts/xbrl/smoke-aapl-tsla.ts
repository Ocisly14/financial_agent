import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FinancialModelSnapshot } from "../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../src/financial-model/snapshotCodec.ts";
import { SqliteModelStore } from "../../src/financial-model/store.ts";
import { SqliteFilingInsightStore } from "../../src/infra/filing-insights/store.ts";
import { resolveLlmProvider } from "../../src/agent/createApp.ts";
import { createDcfSubagentTool } from "../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { ModelRouter } from "../../src/infra/llm/provider.ts";
import { createArelleProcessRunner } from "../../src/infra/xbrl/arelleAdapter.ts";
import { SqliteFilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import { createPreparedStatementProvider } from "../../src/infra/xbrl/preparedStatementProvider.ts";
import { SqliteSourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import { createFinancialModelTools } from "../../mcp_tools/financial-model/financialModelTools.ts";

// Only the interpreter is a local choice; the adapter resolves the companion script itself.
const command = process.env["ARELLE_ADAPTER_COMMAND"]?.trim() || "python3";
const historyYears = boundedInteger(process.env["SMOKE_HISTORY_YEARS"], 3, 2, 5);
const symbols = smokeSymbols(process.env["SMOKE_SYMBOLS"]);
const skipInsights = process.env["SMOKE_SKIP_INSIGHTS"] === "1";
const runTimestamp = new Date().toISOString();
const outputDirectory = resolve(process.env["SMOKE_OUTPUT_DIR"]?.trim()
  || join("data", "smoke", "xbrl", runTimestamp.replaceAll(":", "-").replaceAll(".", "-")));
const databasePath = join(outputDirectory, "financial-models.sqlite");
const provider = createPreparedStatementProvider({
  arelle: createArelleProcessRunner({ command, timeoutMs: 300_000 }),
});

await mkdir(outputDirectory, { recursive: true });
const modelStore = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(databasePath, financialModelSnapshotCodec);
const insightStore = SqliteFilingInsightStore.open(databasePath);
const sourceStore = SqliteSourceReviewStore.open(databasePath);
const tableStore = SqliteFilingTableStore.open(databasePath);
const financialDeps = {
  modelStore,
  insightStore,
  sourceReviewStore: sourceStore,
  ingestionStore: sourceStore,
};
const createTool = createFinancialModelTools(financialDeps).find((tool) => tool.name === "create_financial_model")!;
const extractionTool = createDcfSubagentTool({
  modelRouter: new ModelRouter(resolveLlmProvider()),
  financial: financialDeps,
  provider,
  tableStore,
  ...(skipInsights ? { generateInsights: async () => ({ insights: [] }) } : {}),
});
const summaries: Array<Record<string, unknown>> = [];

try {
  for (const symbol of symbols) {
    const companyDirectory = join(outputDirectory, symbol.toLowerCase());
    await mkdir(companyDirectory, { recursive: true });
    const extracted = await extractionTool.execute({ subagent: "statement_extraction", symbol, historyYears, forecastYears: 3 }, {
      tenantId: "smoke-owner",
      sessionId: "smoke-session",
    });
    if (extracted.error) throw new Error(`${symbol} statement extraction failed: ${extracted.error.code}: ${extracted.error.message}`);
    const extractionData = extracted.generation_context!.data as Record<string, unknown>;
    const ingestionRunId = String(extractionData["ingestionRunId"]);
    const ingestion = sourceStore.getIngestion(ingestionRunId)!;
    if (!ingestion.source || !ingestion.prepared) throw new Error(`${symbol} curation did not produce prepared statements`);
    const modelId = ingestion.modelId;
    const source = ingestion.source;
    const prepared = ingestion.prepared;

    // Persist both the complete extracted catalog and the curated normalized statements.
    await writeJson(join(companyDirectory, "prepared-statements.json"), { source, prepared, curation: extractionData["curation"] });
    await writeJson(join(companyDirectory, "statement-tables.json"), {
      symbol,
      tables: tableStore.listTables(ingestionRunId, { tier: "all" }).entries,
      curations: ingestion.curations,
      curatedTables: ingestion.curatedTables,
      diagnostics: ingestion.diagnostics,
    });

    const created = await createTool.execute({ symbol, ingestionRunId }, {
      tenantId: "smoke-owner",
      sessionId: "smoke-session",
    });
    if (created.error) throw new Error(`${symbol} initial DCF creation failed: ${created.error.code}: ${created.error.message}`);
    const revisions = modelStore.listRevisionHeaders(modelId);
    const persistedRevisions = revisions.map(({ revision }) => {
      const persisted = modelStore.getRevision(modelId, revision)!;
      return {
        ...persisted,
        snapshot: JSON.parse(financialModelSnapshotCodec.encode(persisted.snapshot)) as unknown,
      };
    });
    const workbook = created.generation_context!.data["current_workbook"] as Record<string, unknown>;
    const sections = workbook["sections"] as Record<string, unknown[]>;
    const dcfSections = Object.fromEntries(["history", "metrics", "revenue", "operations", "dcf"].map((section) => [section, {
      rows: sections[section]?.length ?? 0,
      populatedCells: (sections[section] ?? []).flatMap((row) => {
        const cells = (row as { cells?: Record<string, { value?: unknown }> }).cells ?? {};
        return Object.values(cells).filter((cell) => typeof cell.value === "number");
      }).length,
    }]));
    const statements = Object.fromEntries(Object.entries(prepared.statementViews).map(([statement, view]) => [statement, {
      candidateRows: view.candidate.rows.length,
      presentationVersions: view.filingPresentations.length,
      actualPeriodsWithFacts: prepared.coverage.statements.find((entry) => entry.statement === statement)?.availablePeriodIds ?? [],
    }]));
    const summary = {
      symbol,
      selectedReportDates: [...new Set(source.filings.map((filing) => filing.reportDate))].sort(),
      filings: source.filings.map(({ accession, form, filedAt, reportDate }) => ({ accession, form, filedAt, reportDate })),
      facts: prepared.facts.length,
      dimensionalDisclosures: prepared.dimensionalDisclosures.length,
      statements,
      coverageIssues: prepared.coverage.issues,
      diagnostics: ingestion.diagnostics,
      files: {
        preparedStatements: join(companyDirectory, "prepared-statements.json"),
        statementTables: join(companyDirectory, "statement-tables.json"),
        initialDcf: join(companyDirectory, "initial-dcf.json"),
      },
      initialDcf: {
        modelId,
        revisions: revisions.map(({ revision, lifecycleStage }) => ({ revision, lifecycleStage })),
        currentRevision: created.generation_context!.data["revision"],
        lifecycleStage: created.generation_context!.data["lifecycle_stage"],
        workbookMode: workbook["mode"],
        stagedSourceFacts: prepared.facts.length,
        dcfSections,
      },
    };
    await writeJson(join(companyDirectory, "initial-dcf.json"), {
      symbol,
      modelId,
      revisions: persistedRevisions,
      currentWorkbook: workbook,
    });
    summaries.push(summary);
  }

  const manifest = { createdAt: runTimestamp, historyYears, outputDirectory, databasePath, summaries };
  await writeJson(join(outputDirectory, "summary.json"), manifest);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  sourceStore.close();
  tableStore.close();
  insightStore.close();
  modelStore.close();
  }

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`SMOKE_HISTORY_YEARS must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function smokeSymbols(value: string | undefined): string[] {
  const symbols = (value?.trim() || "AAPL,TSLA").split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0 || symbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))) {
    throw new Error("SMOKE_SYMBOLS must be a comma-separated list of ticker symbols");
  }
  return [...new Set(symbols)];
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
