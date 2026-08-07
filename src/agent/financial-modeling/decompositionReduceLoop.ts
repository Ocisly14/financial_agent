import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import { createDecompositionReduceTools, summarizeScheme, type WorkingSchemesRef } from "../../../mcp_tools/financial-model/decompositionSubagentTools.ts";
import { formatAllowedTools, parseSubagentStep } from "../../framework/subagent.ts";
import type { JsonObject, JsonSchema } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { DecompositionStore } from "../../infra/xbrl/decompositionStore.ts";
import type { CandidateScheme, ReduceDecision } from "../../infra/xbrl/decompositionTypes.ts";

const MAX_STEPS = 12;

const DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rationale", "payload", "sourceRefs"], properties: {
    rationale: { type: "string" }, sourceRefs: { type: "array", items: { type: "string" } },
    payload: { type: "object", additionalProperties: false, required: ["ranked", "driverSchemeId"], properties: {
      ranked: { type: "array", items: { type: "string" } },
      driverSchemeId: { type: "any" },
    } } } };

/** Tool-driven reduce loop: picks/ranks candidate revenue-decomposition schemes and may merge children. */
export async function runDecompositionReduceLoop(input: {
  modelRouter: ModelRouter; runId: string; candidates: readonly CandidateScheme[]; store: DecompositionStore;
  task: string; systemPrompt: string; maxSteps?: number;
  /** Face row values per period, so merge_children can recompute residual ratios (spec §4.2/§4.3). */
  faceValues?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}): Promise<{ decision: ReduceDecision; candidates: CandidateScheme[] }> {
  const working: WorkingSchemesRef = { current: input.candidates.map((candidate) => structuredClone(candidate)) };
  const tools = createDecompositionReduceTools(input.runId, input.store, working, input.faceValues);
  const baseContext = working.current.map((scheme) => summarizeScheme(scheme));
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.systemPrompt}\n\nAllowed private tools:\n${formatAllowedTools([...tools.values()])}\n\nOutput contract — return EXACTLY one JSON object and nothing else:\n- Tool step: {"action":"call_tool","calls":[{"tool":"<name>","input":{}}]}\n- Final decision: {"rationale":"...","payload":{"ranked":["cs-..."],"driverSchemeId":"cs-..."|null},"sourceRefs":[]}\nEvery id in ranked must be a known candidateSchemeId. driverSchemeId must be ranked[0] or null. Ranking may drop schemes (dropped = not in ranked).` },
    { role: "user", content: `${input.task}\n\n[BASE CONTEXT — NO VALUES]\n${JSON.stringify(baseContext)}\n\nOutput the next tool step or the final decision.` },
  ];
  let schemaRetried = false;
  for (let step = 1; step <= (input.maxSteps ?? MAX_STEPS); step += 1) {
    let completion;
    try { completion = await input.modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "decomposition_reduce" } }); }
    catch (firstError) {
      // Transient provider errors (rate-limit bodies that are not JSON) need spacing, not an instant retry.
      await backoff();
      try { completion = await input.modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "decomposition_reduce", retry: "malformed_response" } }); }
      catch { throw firstError; }
    }
    const parsed = parseObject(completion.text);
    if (parsed["action"] !== "call_tool") {
      let payload: { ranked: string[]; driverSchemeId: string | null };
      try {
        validate(parsed, DECISION_SCHEMA, "$", true);
        payload = parsed["payload"] as { ranked: string[]; driverSchemeId: string | null };
        const known = new Set(working.current.map((scheme) => scheme.candidateSchemeId));
        for (const id of payload.ranked) if (!known.has(id)) throw new Error(`unknown candidateSchemeId: ${id}`);
        if (payload.driverSchemeId !== null && payload.driverSchemeId !== payload.ranked[0]) {
          throw new Error("driverSchemeId must be ranked[0] or null");
        }
      } catch (validationError) {
        // One in-band correction round: feed the exact validation failure back instead of aborting the reduce.
        if (schemaRetried) throw validationError;
        schemaRetried = true;
        messages.push({ role: "assistant", content: completion.text });
        messages.push({ role: "user", content: `[VALIDATION ERROR]\n${validationError instanceof Error ? validationError.message : String(validationError)}\n\nRe-emit the FULL corrected final decision as one JSON object matching the output contract exactly.` });
        continue;
      }
      const decision: ReduceDecision = { ranked: payload.ranked, driverSchemeId: payload.driverSchemeId, rationale: String(parsed["rationale"]) };
      input.store.saveReduceDecision(input.runId, decision);
      return { decision, candidates: working.current };
    }
    const action = parseSubagentStep(completion.text);
    if (action.action !== "call_tool") throw new Error("decomposition_reduce returned an invalid tool envelope");
    const toolResults = action.calls.map((call) => {
      const tool = tools.get(call.tool);
      if (!tool) return { tool: call.tool, error: { code: "invalid_tool", message: `unknown tool: ${call.tool}` } };
      try { return { tool: call.tool, result: tool.execute(call.input) }; }
      catch (error) { return { tool: call.tool, error: { code: "invalid_tool_input", message: error instanceof Error ? error.message : String(error) } }; }
    });
    messages.push({ role: "assistant", content: completion.text });
    messages.push({ role: "user", content: `[TOOL RESULTS]\n${JSON.stringify(toolResults)}\n\nContinue with another tool step or the final decision.` });
  }
  throw new Error(`decomposition_reduce did not produce a decision after ${input.maxSteps ?? MAX_STEPS} tool steps`);
}

function backoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_000 + Math.floor(Math.random() * 2_000)));
}

function parseObject(text: string): JsonObject {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("decomposition_reduce did not return JSON");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("decomposition_reduce response must be an object");
  return parsed as JsonObject;
}
