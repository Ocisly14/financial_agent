import { reviewInputSchema, validate } from "../../../mcp_tools/financial-model/schemas.ts";
import { formatAllowedTools, parseSubagentStep } from "../../framework/subagent.ts";
import type { JsonObject, JsonSchema, JsonValue, ToolDefinition } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { FilingTableStore } from "../../infra/xbrl/filingTableStore.ts";
import type { SourceReviewArtifact } from "../../infra/xbrl/sourceReviewStore.ts";
import type { ColumnConflictWaiver } from "../../infra/xbrl/tableTypes.ts";
import type { DcfSubagentProjection } from "./subagents.ts";

type MappingTool = ToolDefinition & { execute(input: JsonObject): JsonValue };

const MAX_STEPS = 24;
const MAX_DETAIL_ROWS = 20;

/** Tool-driven source review with durable row/column titles and full loop memory. */
export async function runHistoricalMappingLoop(input: {
  modelRouter: ModelRouter;
  projection: DcfSubagentProjection;
  sourceReview: SourceReviewArtifact;
  tableStore: FilingTableStore;
  task: string;
  systemPrompt: string;
  maxSteps?: number;
}): Promise<JsonObject> {
  const tools = createHistoricalMappingTools(input.sourceReview, input.tableStore);
  const toolBlock = formatAllowedTools([...tools.values()]);
  const payloadSchema = historicalMappingPayloadSchema();
  const factsByLine = factsByLineItem(input.sourceReview);
  const tableById = new Map(input.sourceReview.curatedTables.map((table) => [table.sourceTableId, table]));
  const baseContext = {
    subagent: input.projection.subagent,
    modelId: input.projection.modelId,
    baseRevision: input.projection.baseRevision,
    lifecycleStage: input.projection.lifecycleStage,
    workbook: input.projection.workbook,
    filingInsights: input.projection.filingInsights,
    sourceStatements: Object.fromEntries(Object.entries(input.sourceReview.statementViews).map(([statement, view]) => [statement, {
      columns: view.candidate.periods.map((period) => ({ id: period.id, title: period.label, start: period.start, end: period.end, class: period.cls })),
      rows: view.candidate.rows.map((row) => ({ sourceLineItemId: row.sourceLineItemId, title: row.label,
        conceptQName: row.conceptQName, unit: row.unit, depth: row.depth, parentSourceLineItemId: row.parentSourceLineItemId,
        availablePeriodIds: [...new Set((factsByLine.get(row.sourceLineItemId) ?? []).map((fact) => fact.periodId))] })),
    }])),
    sourceReview: {
      filings: input.sourceReview.filings,
      coverage: input.sourceReview.coverage,
      selectedTables: input.sourceReview.curations,
      factCount: input.sourceReview.facts.length,
      columnConflicts: (input.sourceReview.verification?.columnConflicts ?? []).map((conflict) => {
        const table = tableById.get(conflict.sourceTableId);
        const row = table?.rows.find((candidate) => candidate.order === conflict.rowOrder);
        const column = table?.columns.find((candidate) => candidate.index === conflict.columnIndex);
        return { ...conflict, tableHeading: table?.heading ?? "", rowTitle: row?.labelText ?? "",
          columnTitle: column?.headerText ?? "" };
      }),
      waivedColumnConflicts: input.tableStore.listColumnConflictWaivers(input.sourceReview.ingestionRunId),
    },
  };
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.systemPrompt}\n\nAll normalized source-statement row titles and period columns are permanently present in BASE CONTEXT. Do not ask to list them. Call get_statement_rows only for exact rows whose values, factIds, units, or provenance you need. Review any injected column conflicts; waiver calls may run in parallel with independent exact-row reads. The complete conversation and every tool result remain available on later steps.\n\nAllowed private tools:\n${toolBlock}\n\nOutput contract — return EXACTLY one JSON object and nothing else. Field names are literal:\n- Tool step: {"action":"call_tool","calls":[{"tool":"<allowed-tool-name>","input":{}}]}\n- Final proposal: {"rationale":"...","payload":{},"sourceRefs":[]}\nNever use toolName, tool_name, args, function, or arguments. Independent calls may share one calls array.\n\nThe final payload schema is review_financial_model_history with modelId and expectedRevision omitted:\n${JSON.stringify(payloadSchema)}` },
    { role: "user", content: `${input.task}\n\n[BASE CONTEXT — ROW/COLUMN TITLES, NO SOURCE VALUES]\n${JSON.stringify(baseContext)}\n\nOutput the next exact-row tool step or final proposal using the contract.` },
  ];
  for (let step = 1; step <= (input.maxSteps ?? MAX_STEPS); step += 1) {
    let completion;
    try {
      completion = await input.modelRouter.generate(messages,
        { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "historical_mapping" } });
    } catch (firstError) {
      try {
        completion = await input.modelRouter.generate(messages,
          { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "historical_mapping", retry: "malformed_response" } });
      } catch { throw firstError; }
    }
    const parsed = parseObject(completion.text);
    if (parsed["action"] !== "call_tool") return parsed;
    const action = parseSubagentStep(completion.text);
    if (action.action !== "call_tool") throw new Error("historical_mapping returned an invalid tool envelope; expected calls[].tool and calls[].input");
    const toolResults = action.calls.map((call) => {
      const tool = tools.get(call.tool);
      if (!tool) return { tool: call.tool, error: { code: "invalid_tool", message: `unknown tool: ${call.tool}` } };
      try { return { tool: call.tool, result: tool.execute(call.input) }; }
      catch (error) { return { tool: call.tool, error: { code: "invalid_tool_input", message: error instanceof Error ? error.message : String(error) } }; }
    });
    messages.push({ role: "assistant", content: completion.text });
    messages.push({ role: "user", content: `[TOOL RESULTS]\n${JSON.stringify(toolResults)}\n\nContinue with another exact-row tool step or the final proposal.` });
  }
  throw new Error(`historical_mapping did not produce a proposal after ${input.maxSteps ?? MAX_STEPS} tool steps`);
}

export function createHistoricalMappingTools(source: SourceReviewArtifact, tableStore: FilingTableStore): Map<string, MappingTool> {
  const string = (): JsonSchema => ({ type: "string" });
  const strings: JsonSchema = { type: "array", items: string() };
  const number: JsonSchema = { type: "number" };
  const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
    ({ type: "object", properties, required, additionalProperties: false });
  const factsByLine = factsByLineItem(source);
  const rows = Object.values(source.statementViews).flatMap((view) => view.candidate.rows);
  const rowById = new Map(rows.map((row) => [row.sourceLineItemId, row]));
  const tools: MappingTool[] = [
    {
      name: "get_statement_rows", category: "non_trading",
      description: `Read values and provenance for up to ${MAX_DETAIL_ROWS} exact sourceLineItemIds. Results are grouped by row so shared metadata is not repeated per fact.`,
      inputSchema: object({ sourceLineItemIds: strings }, ["sourceLineItemIds"]),
      execute(raw) {
        validate(raw, this.inputSchema, "$", true);
        const ids = [...new Set(raw["sourceLineItemIds"] as string[])];
        if (ids.length === 0 || ids.length > MAX_DETAIL_ROWS) throw new Error(`sourceLineItemIds must contain 1-${MAX_DETAIL_ROWS} ids`);
        const unknown = ids.filter((id) => !rowById.has(id));
        return { rows: ids.flatMap((id) => { const row = rowById.get(id); return row ? [{
          sourceLineItemId: id, statement: row.statement, title: row.label, conceptQName: row.conceptQName,
          unit: row.unit, facts: (factsByLine.get(id) ?? []).map((fact) => ({ factId: fact.factId, periodId: fact.periodId,
            value: fact.value, sourceAnchor: fact.provenance.sourceRefs[0] ?? "", asOfDate: fact.provenance.asOfDate,
            accession: fact.provenance.accession, concept: fact.provenance.concept })),
        }] : []; }), unknown } as unknown as JsonValue;
      },
    },
    {
      name: "waive_column_conflicts", category: "non_trading",
      description: "Record a reasoned waiver for exact conflicts injected in base context. Invented coordinates are rejected.",
      inputSchema: object({ waivers: { type: "array", items: object({ sourceTableId: string(), rowOrder: number, columnIndex: number,
        rationale: string() }, ["sourceTableId", "rowOrder", "columnIndex", "rationale"]) } }, ["waivers"]),
      execute(raw) {
        validate(raw, this.inputSchema, "$", true);
        const conflicts = source.verification?.columnConflicts ?? [];
        const applied: ColumnConflictWaiver[] = [];
        const errors: JsonValue[] = [];
        for (const waiver of raw["waivers"] as unknown as ColumnConflictWaiver[]) {
          const exists = conflicts.some((conflict) => conflict.sourceTableId === waiver.sourceTableId
            && conflict.rowOrder === waiver.rowOrder && conflict.columnIndex === waiver.columnIndex);
          if (!exists) { errors.push({ ...waiver, code: "column_conflict_not_found" }); continue; }
          if (!waiver.rationale.trim()) { errors.push({ ...waiver, code: "missing_rationale" }); continue; }
          tableStore.saveColumnConflictWaiver(source.ingestionRunId, waiver); applied.push(waiver);
        }
        return { applied, errors } as unknown as JsonValue;
      },
    },
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function parseObject(text: string): JsonObject {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("historical_mapping did not return JSON");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("historical_mapping response must be an object");
  return parsed as JsonObject;
}

function historicalMappingPayloadSchema(): JsonSchema {
  const properties = { ...(reviewInputSchema.properties ?? {}) };
  delete properties["modelId"];
  delete properties["expectedRevision"];
  return { ...reviewInputSchema, properties,
    required: (reviewInputSchema.required ?? []).filter((field) => field !== "modelId" && field !== "expectedRevision") };
}

function factsByLineItem(source: SourceReviewArtifact): Map<string, typeof source.facts> {
  const result = new Map<string, typeof source.facts>();
  for (const fact of source.facts) {
    if (!fact.lineItemId) continue;
    const facts = result.get(fact.lineItemId) ?? [];
    facts.push(fact); result.set(fact.lineItemId, facts);
  }
  return result;
}
