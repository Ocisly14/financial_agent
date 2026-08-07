import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import { createFilingDecompositionTools } from "../../../mcp_tools/financial-model/decompositionSubagentTools.ts";
import { formatAllowedTools, parseSubagentStep } from "../../framework/subagent.ts";
import type { JsonObject, JsonSchema, JsonValue } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { FilingTableStore } from "../../infra/xbrl/filingTableStore.ts";
import type { FilingDecompositionProposal, MintedTableFact } from "../../infra/xbrl/decompositionTypes.ts";

const MAX_STEPS = 16;

const PROPOSAL_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rationale", "payload", "sourceRefs"], properties: {
    rationale: { type: "string" }, sourceRefs: { type: "array", items: { type: "string" } },
    payload: { type: "object", additionalProperties: false, required: ["schemes"], properties: {
      schemes: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["schemeId", "label", "axisHint", "targetSourceLineItemId", "children"], properties: {
          schemeId: { type: "string" }, label: { type: "string" }, axisHint: { type: "string" },
          targetSourceLineItemId: { type: "string" },
          children: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "factRefs"],
            properties: { label: { type: "string" }, memberHint: { type: "string" },
              factRefs: { type: "array", items: { type: "object", additionalProperties: false,
                required: ["factId", "periodId"], properties: { factId: { type: "string" }, periodId: { type: "string" } } } } } } } } } } } } } };

/** Tool-driven revenue-decomposition discovery over a filing's table catalog. */
export async function runFilingDecompositionLoop(input: {
  modelRouter: ModelRouter; runId: string; accession: string; tableStore: FilingTableStore;
  faceRows: readonly { sourceLineItemId: string; title: string; conceptQName: string }[];
  requestedPeriodIds: readonly string[];
  onMintedFacts: (facts: readonly MintedTableFact[]) => void;
  task: string; systemPrompt: string; maxSteps?: number;
}): Promise<FilingDecompositionProposal> {
  const tools = createFilingDecompositionTools(input.runId, input.accession, input.tableStore, input.onMintedFacts);
  const catalog = drainCatalog(input.tableStore, input.runId, input.accession);
  const baseContext = { accession: input.accession, requestedPeriodIds: input.requestedPeriodIds,
    incomeStatementRows: input.faceRows, tables: catalog };
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.systemPrompt}\n\nAllowed private tools:\n${formatAllowedTools([...tools.values()])}\n\nOutput contract — return EXACTLY one JSON object and nothing else:\n- Tool step: {"action":"call_tool","calls":[{"tool":"<name>","input":{}}]}\n- Final proposal: {"rationale":"...","payload":{"schemes":[{"schemeId":"s1","label":"...","axisHint":"<exact dimension axisQName shared by every child fact, copied from get_table_facts dimensions (e.g. srt:ProductOrServiceAxis, srt:StatementGeographicalAxis, us-gaap:StatementBusinessSegmentsAxis), or presentation-only when the rows carry no dimensions>","targetSourceLineItemId":"<one of incomeStatementRows>","children":[{"label":"...","memberHint":"<the child fact's memberQName on that axis, omit for presentation-only>","factRefs":[{"factId":"...","periodId":"..."}]}]}]},"sourceRefs":["<factId or sourceTableId strings>"]}\nEvery scheme requires all of schemeId (any short unique string), label, axisHint, targetSourceLineItemId, children. axisHint MUST be an axisQName literally present in each child fact's dimensions, or exactly "presentation-only"; semantic labels like "product" or "geography" are rejected. sourceRefs entries must be plain strings. Every factId must come from a get_table_facts result. An empty schemes array is a valid final answer when this filing supports no revenue decomposition.` },
    { role: "user", content: `${input.task}\n\n[BASE CONTEXT — TITLES ONLY, NO VALUES]\n${JSON.stringify(baseContext)}\n\nOutput the next tool step or the final proposal.` },
  ];
  let schemaRetried = false;
  for (let step = 1; step <= (input.maxSteps ?? MAX_STEPS); step += 1) {
    let completion;
    try { completion = await input.modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "filing_decomposition" } }); }
    catch (firstError) {
      // Transient provider errors (rate-limit bodies that are not JSON) need spacing, not an instant retry.
      await backoff();
      try { completion = await input.modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "filing_decomposition", retry: "malformed_response" } }); }
      catch { throw firstError; }
    }
    const parsed = parseObject(completion.text);
    if (parsed["action"] !== "call_tool") {
      try { validate(parsed, PROPOSAL_SCHEMA, "$", true); }
      catch (validationError) {
        // One in-band correction round: feed the exact validation failure back instead of aborting the filing.
        if (schemaRetried) throw validationError;
        schemaRetried = true;
        messages.push({ role: "assistant", content: completion.text });
        messages.push({ role: "user", content: `[VALIDATION ERROR]\n${validationError instanceof Error ? validationError.message : String(validationError)}\n\nRe-emit the FULL corrected final proposal as one JSON object matching the output contract exactly.` });
        continue;
      }
      const payload = parsed["payload"] as { schemes: FilingDecompositionProposal["schemes"] };
      return { accession: input.accession, rationale: String(parsed["rationale"]), schemes: payload.schemes,
        sourceRefs: (parsed["sourceRefs"] as string[]) };
    }
    const action = parseSubagentStep(completion.text);
    if (action.action !== "call_tool") throw new Error("filing_decomposition returned an invalid tool envelope");
    const toolResults = action.calls.map((call) => {
      const tool = tools.get(call.tool);
      if (!tool) return { tool: call.tool, error: { code: "invalid_tool", message: `unknown tool: ${call.tool}` } };
      try { return { tool: call.tool, result: tool.execute(call.input) }; }
      catch (error) { return { tool: call.tool, error: { code: "invalid_tool_input", message: error instanceof Error ? error.message : String(error) } }; }
    });
    messages.push({ role: "assistant", content: completion.text });
    messages.push({ role: "user", content: `[TOOL RESULTS]\n${JSON.stringify(toolResults)}\n\nContinue with another tool step or the final proposal.` });
  }
  throw new Error(`filing_decomposition did not produce a proposal after ${input.maxSteps ?? MAX_STEPS} tool steps`);
}

/** Paginate the filing's table catalog to exhaustion, projected to titles/prescreen only. */
function drainCatalog(tableStore: FilingTableStore, runId: string, accession: string): JsonValue[] {
  const entries: JsonValue[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = tableStore.listTables(runId, { accession, tier: "all", ...(cursor ? { cursor } : {}) });
    for (const entry of page.entries) {
      entries.push({
        sourceTableId: entry.sourceTableId, heading: entry.heading, rowLabels: entry.rowLabels,
        rowLabelsTruncated: entry.rowLabelsTruncated, columnHeaders: entry.columnHeaders,
        prescreen: { tier: entry.prescreen.tier, dimensionlessRatio: entry.prescreen.dimensionlessRatio,
          factCount: entry.prescreen.factCount, periodSpan: entry.prescreen.periodSpan },
      } as unknown as JsonValue);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return entries;
}

function backoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_000 + Math.floor(Math.random() * 2_000)));
}

function parseObject(text: string): JsonObject {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("filing_decomposition did not return JSON");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("filing_decomposition response must be an object");
  return parsed as JsonObject;
}
