import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createDcfSubagentTool } from "../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { resolveLlmProvider } from "../../src/agent/createApp.ts";
import type { FinancialModelSnapshot } from "../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../src/financial-model/snapshotCodec.ts";
import { SqliteModelStore } from "../../src/financial-model/store.ts";
import { SqliteFilingInsightStore } from "../../src/infra/filing-insights/store.ts";
import { ModelRouter } from "../../src/infra/llm/provider.ts";
import { SqliteDecompositionStore } from "../../src/infra/xbrl/decompositionStore.ts";
import { SqliteSourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import { SqliteFilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";

const runDirectory = resolve(process.env["SMOKE_RUN_DIR"]?.trim()
  || "data/smoke/xbrl/aapl-tsla-table-candidates-2026-08-05-v2");
const symbol = (process.env["SMOKE_SYMBOL"]?.trim() || "AAPL").toUpperCase();
const modelId = process.env["SMOKE_MODEL_ID"]?.trim() || `smoke-${symbol.toLowerCase()}`;
const databasePath = join(runDirectory, "financial-models.sqlite");
const outputPath = join(runDirectory, symbol.toLowerCase(), "mapping-review-proposal.json");

const modelStore = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(
  databasePath,
  financialModelSnapshotCodec,
);
const insightStore = SqliteFilingInsightStore.open(databasePath);
const sourceReviewStore = SqliteSourceReviewStore.open(databasePath);
const tableStore = SqliteFilingTableStore.open(databasePath);
const decompositionStore = SqliteDecompositionStore.open(databasePath);
const tool = createDcfSubagentTool({
  modelRouter: new ModelRouter(resolveLlmProvider()),
  financial: {
    modelStore,
    insightStore,
    sourceReviewStore,
    ingestionStore: sourceReviewStore,
    decompositionStore,
  },
  tableStore,
});

try {
  const startedAt = new Date().toISOString();
  const result = await tool.execute({
    subagent: "mapping_review",
    modelId,
    task: `Use the already-curated filing statements to propose the complete initial historical DCF mapping for ${symbol}.`,
  }, {
    agentId: "smoke-owner",
    sessionId: "smoke-session",
  });
  const artifact = {
    symbol,
    modelId,
    startedAt,
    completedAt: new Date().toISOString(),
    result,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    symbol,
    modelId,
    outputPath,
    summary: result.summary,
    error: result.error ?? null,
  }, null, 2)}\n`);
  if (result.error) process.exitCode = 1;
} catch (error) {
  const failure = {
    symbol,
    modelId,
    failedAt: new Date().toISOString(),
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  throw error;
} finally {
  tableStore.close();
  sourceReviewStore.close();
  insightStore.close();
  modelStore.close();
  decompositionStore.close();
}
