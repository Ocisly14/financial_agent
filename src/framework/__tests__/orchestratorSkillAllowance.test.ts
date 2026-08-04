import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrchestratorRuntime } from "../orchestrator.ts";
import { SkillRegistry } from "../skill.ts";
import { SubagentRegistry } from "../subagent.ts";
import { Dispatcher } from "../dispatcher.ts";
import { SessionRegistry } from "../sessionState.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateOptions, GenerateResult, LlmMessage, LlmProvider } from "../../infra/llm/provider.ts";
import type { TaskRequest } from "../types.ts";

/**
 * Regression guard for the ordering fix: the allowance must be installed
 * before `skills.invoke()` runs, because a code-backed workflow dispatches
 * from inside `invoke()`. Before the fix, a workflow could dispatch to an
 * agent outside its skill's `agents:` list and it would go straight through
 * — the allowance was only installed on the *next* loop iteration, after the
 * damage was already done.
 */
test("a dispatch issued from inside a skill's workflow is subject to that skill's own allowance", async () => {
  const skillsRoot = await mkdtemp(path.join(tmpdir(), "skill-allowance-"));
  await mkdir(path.join(skillsRoot, "narrow-skill"));
  await writeFile(
    path.join(skillsRoot, "narrow-skill", "narrow-skill.md"),
    [
      "---",
      "name: narrow-skill",
      "description: only ever touches market_data",
      "agents: [market_data]",
      "workflow: narrow-workflow",
      "---",
      "",
      "Body text.",
      "",
    ].join("\n"),
  );

  const skills = new SkillRegistry();
  await skills.loadFromDirectory(skillsRoot);

  const seen: TaskRequest[] = [];
  skills.registerWorkflow("narrow-workflow", async (skill, context) => {
    // Declares only market_data — this dispatch to trading_operations must be
    // refused by the allowance, not silently executed.
    await context.dispatcher.dispatch([{ agent: "trading_operations", task: "should be blocked" }]);
    return { skill: skill.name, status: "ok", summary: "workflow ran" };
  });

  const subagents = new SubagentRegistry();
  for (const name of ["market_data", "trading_operations"] as const) {
    subagents.register({
      name,
      description: "d",
      modelClass: "MEDIUM",
      defaultTools: [],
      systemPrompt: { system: "", prompt: "" },
    });
  }
  const subagentRuntime = { run: async (_definition: unknown, ctx: { request: TaskRequest }) => { seen.push(ctx.request); } };

  const sessions = new SessionRegistry();
  const dispatcherFactory = (sessionId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime as never, new McpToolRegistry(), sessions.getExisting(sessionId));

  let call = 0;
  const provider: LlmProvider = {
    name: "stub",
    async generate(_messages: LlmMessage[], _options: GenerateOptions): Promise<GenerateResult> {
      call += 1;
      const text =
        call === 1
          ? JSON.stringify({ reply: "", dispatch: null, skill: "narrow-skill", tool_call: null })
          : JSON.stringify({ reply: "done", dispatch: null, skill: null, tool_call: null });
      return { text, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "LARGE", provider: "stub" } };
    },
  };

  const orchestrator = new OrchestratorRuntime(
    { system: "", prompt: "" },
    new ModelRouter(provider),
    dispatcherFactory,
    subagents,
    skills,
    new McpToolRegistry(),
    sessions,
  );

  await orchestrator.run({ sessionId: "s1", userMessage: "go" });

  assert.equal(seen.length, 0, "the workflow's dispatch to an undeclared agent must never reach the subagent runtime");

  await rm(skillsRoot, { recursive: true, force: true });
});
