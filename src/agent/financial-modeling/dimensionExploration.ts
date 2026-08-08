import type { LoopTool } from "../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import { exploreInstruction } from "../prompts/dcfSubagentPrompts.ts";
import { createLogger } from "../../infra/logger/logger.ts";

const log = createLogger("dimension_exploration");
export const MAX_EXPLORATION_STEPS = 8;

export async function exploreDimensions(input: { modelRouter: ModelRouter; subagent: string;
  systemPrompt: string; task: string; tools: Map<string, LoopTool>; maxSteps?: number }): Promise<{ digest: string }> {
  const maxSteps = input.maxSteps ?? MAX_EXPLORATION_STEPS;
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.systemPrompt}\n\n${exploreInstruction([...input.tools.keys()])}` },
    { role: "user", content: `[ORCHESTRATOR INSTRUCTION]\n${input.task}` },
  ];
  const fetched: string[] = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    // Exploration is an enhancement, never a prerequisite: a provider that fails twice in a row costs
    // this run its breakdowns, not the unification itself.
    let completion;
    try { completion = await input.modelRouter.generate(messages,
      { modelClass: "MEDIUM", temperature: 0, metadata: { mode: "dcf_subagent", subagent: input.subagent, phase: "explore" } }); }
    catch (firstError) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 + Math.floor(Math.random() * 2_000)));
      try { completion = await input.modelRouter.generate(messages,
        { modelClass: "MEDIUM", temperature: 0, metadata: { mode: "dcf_subagent", subagent: input.subagent, phase: "explore", retry: "provider_error" } }); }
      catch {
        log.warn(`exploration abandoned at step ${step}: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
        break;
      }
    }
    messages.push({ role: "assistant", content: completion.text });
    const start = completion.text.indexOf("{"); const end = completion.text.lastIndexOf("}");
    let feedback: string;
    try {
      if (start < 0 || end < start) throw new Error("expected one JSON object");
      const parsed = JSON.parse(completion.text.slice(start, end + 1)) as { done?: boolean; tool?: string; input?: object };
      if (parsed.done === true) break;
      const tool = parsed.tool !== undefined ? input.tools.get(parsed.tool) : undefined;
      if (!tool) throw new Error(`unknown tool: ${String(parsed.tool)}`);
      const result = JSON.stringify(tool.execute((parsed.input ?? {}) as never));
      if (tool.name === "get_axis_breakdown") fetched.push(result);
      feedback = `[TOOL RESULT ${tool.name}]\n${result}`;
    } catch (error) {
      // 探索是增强不是前置条件：错误喂回去让它改，或它自己 done。
      feedback = `[EXPLORATION ERROR]\n${error instanceof Error ? error.message : String(error)}`;
    }
    messages.push({ role: "user", content: feedback });
  }
  log.info(`exploration fetched ${fetched.length} breakdown(s)`);
  return { digest: fetched.join("\n") };
}
