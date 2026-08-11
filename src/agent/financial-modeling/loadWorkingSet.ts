/**
 * The mapping subagents' first turn.
 *
 * The DCF orchestrator's instruction names a ticker and nothing more; the subagent turns that into a
 * working set by calling its initialization tool. The data never travels through the orchestrator, so
 * what a subagent maps is always what extraction persisted — there is no copy in a prompt somewhere
 * that can drift from the store.
 */
import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import type { LoopTool } from "../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import type { JsonObject, JsonSchema, JsonValue } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import { loadInstruction } from "../prompts/dcfSubagentPrompts.ts";

/** One retry: a wrong ticker or a missing prerequisite is worth stating back, not worth a third go. */
const MAX_LOAD_ATTEMPTS = 2;

const callSchema = (toolName: string): JsonSchema => ({
  type: "object", additionalProperties: false, required: ["tool", "input"],
  properties: {
    tool: { type: "string", enum: [toolName] },
    input: { type: "object", additionalProperties: true, properties: {} },
  },
});

export async function loadWorkingSet(input: {
  modelRouter: ModelRouter;
  subagent: string;
  systemPrompt: string;
  /** The orchestrator's instruction, verbatim. It is the only thing naming the issuer. */
  task: string;
  tools: Map<string, LoopTool>;
}): Promise<JsonValue> {
  const [toolName] = [...input.tools.keys()];
  if (toolName === undefined) throw new Error(`${input.subagent} has no initialization tool`);
  const schema = callSchema(toolName);
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.systemPrompt}\n\n${loadInstruction(toolName)}` },
    { role: "user", content: `[ORCHESTRATOR INSTRUCTION]\n${input.task}` },
  ];

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
    const completion = await input.modelRouter.generate(messages,
      { modelClass: "MEDIUM", temperature: 0, metadata: { mode: "dcf_subagent", subagent: input.subagent, phase: "load" } });
    const start = completion.text.indexOf("{");
    const end = completion.text.lastIndexOf("}");
    try {
      if (start < 0 || end < start) throw new Error(`${input.subagent} did not return a tool call`);
      const call = JSON.parse(completion.text.slice(start, end + 1)) as JsonValue;
      validate(call, schema, "$", true);
      const { tool, input: toolInput } = call as { tool: string; input: JsonObject };
      return input.tools.get(tool)!.execute(toolInput);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_LOAD_ATTEMPTS) break;
      messages.push({ role: "assistant", content: completion.text });
      messages.push({ role: "user", content: `[LOAD FAILED]\n${lastError}\n\nCorrect the call and return it alone.` });
    }
  }
  throw new Error(`${input.subagent} could not load its working set: ${lastError}`);
}
