import { resolve } from "node:path";
import type { JsonObject, JsonSchema, JsonValue } from "../../src/framework/types.ts";
import type { ModelRouter } from "../../src/infra/llm/provider.ts";
import { createSmallModelInsightGenerator, type ChunkInsightGenerator } from "../../src/infra/filing-insights/extractor.ts";
import { SqliteFilingTableStore, type FilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import { createPreparedStatementProvider, type FinancialModelSourceRequest, type PreparedStatementProvider } from "../../src/infra/xbrl/preparedStatementProvider.ts";
import { runStatementExtraction } from "../../src/infra/xbrl/statementExtraction.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import type { FinancialModelToolDeps } from "./financialModelTools.ts";
import { validate } from "./schemas.ts";

export const STATEMENT_EXTRACTION_TOOL = "extract_filing_statements";

const INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["symbol"], properties: {
  symbol: { type: "string", description: "Ticker to pull 10-K filings for." },
  historyYears: { type: "number", description: "Historical fiscal years to request, 3..10 (default 5)." },
  forecastYears: { type: "number", description: "Forecast fiscal years to lay out, 3..10 (default 5)." },
  reportingCurrency: { type: "string" },
} };

/**
 * Filing extraction is a tool, not a subagent: Arelle resolves the filings, pulls every table, and
 * persists the tables, face statements, and ingestion run. Nothing here is a modeling decision, so
 * there is no prompt and no proposal — the DCF Agent gets back an ingestionRunId and a count of what
 * landed, and the two mapping subagents work from the stored data afterwards.
 */
export function createStatementExtractionTool(deps: {
  modelRouter: ModelRouter;
  financial: FinancialModelToolDeps;
  provider?: PreparedStatementProvider;
  tableStore?: FilingTableStore;
  generateInsights?: ChunkInsightGenerator;
}): RegisteredTool {
  const provider = deps.provider ?? createPreparedStatementProvider();
  // Opened lazily so constructing the tool never touches the filesystem.
  let tableStore = deps.tableStore;
  const filingTableStore = () => tableStore ??= SqliteFilingTableStore.open(
    resolve(process.env["FINANCIAL_MODEL_DB_PATH"] ?? "data/financial-models.sqlite"));
  return {
    name: STATEMENT_EXTRACTION_TOOL,
    description: "Pull an issuer's 10-K filings through Arelle and persist their statements, tables, and insights as an immutable ingestion run. Returns coverage statistics and the ingestionRunId that create_financial_model consumes.",
    category: "non_trading",
    inputSchema: INPUT_SCHEMA,
    async execute(input, context) {
      // The schema types the fields; these carry the ranges, so both rejections have to land as a
      // tool error rather than escaping execute as a throw.
      let request: FinancialModelSourceRequest;
      try {
        validate(input, INPUT_SCHEMA, "$", true);
        request = { symbol: requiredString(input, "symbol"), historyYears: integer(input["historyYears"], 5, 3, 10),
          forecastYears: integer(input["forecastYears"], 5, 3, 10), filingForms: ["10-K", "10-K/A"],
          ...(typeof input["reportingCurrency"] === "string" ? { reportingCurrency: input["reportingCurrency"] } : {}) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { summary: message, error: { code: "invalid_tool_input", message } };
      }
      const result = await runStatementExtraction({ provider, ingestionStore: deps.financial.ingestionStore,
        insightStore: deps.financial.insightStore,
        generateInsights: deps.generateInsights ?? createSmallModelInsightGenerator(deps.modelRouter),
        tableStore: filingTableStore() }, context.agentId, request);

      if (result.status === "failed") {
        return { summary: result.error?.message ?? "Filing extraction failed.",
          generation_context: { data: { extraction: { ingestionRunId: result.ingestionRunId, status: result.status,
            diagnostics: result.diagnostics } as unknown as JsonObject } },
          error: { code: result.error!.code, message: result.error!.message } };
      }
      // Statistics, not the data: the tables live in the store, and the mapping subagents read them
      // from there. Handing the DCF Agent the rows back would only spend its context.
      const covered = result.statementCoverage?.statements.map((statement) =>
        `${statement.statement} ${statement.availablePeriodIds.length}/${statement.availablePeriodIds.length + statement.missingPeriodIds.length}`) ?? [];
      return {
        summary: `Extracted ${result.accessions.length} filing(s) into ingestion ${result.ingestionRunId}`
          + `${covered.length === 0 ? " with no prepared statements" : `; period coverage ${covered.join(", ")}`}`
          + `${result.diagnostics.length === 0 ? "." : `; ${result.diagnostics.length} diagnostic(s).`}`
          + " Pass ingestionRunId to create_financial_model.",
        generation_context: { data: { extraction: {
          ingestionRunId: result.ingestionRunId,
          accessions: result.accessions,
          curationOutcome: result.curation?.outcome ?? null,
          statementCoverage: result.statementCoverage ?? null,
          filingInsightSetId: result.filingInsights?.insightSetId ?? null,
          diagnostics: result.diagnostics,
        } as unknown as JsonObject } },
      };
    },
  };
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}
function integer(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}..${max}`);
  return value;
}
