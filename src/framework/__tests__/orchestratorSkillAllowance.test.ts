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
 * Regression guard for the ordering fix: the skill's granted tools must be
 * installed before `skills.invoke()` runs, because a code-backed workflow
 * dispatches from inside `invoke()`. Before the fix the grant only landed on
 * the *next* loop iteration, so that first dispatch ran without it.
 */
test("a dispatch issued from inside a skill's workflow uses the agent's own declared pool", async () => {
  const skillsRoot = await mkdtemp(path.join(tmpdir(), "skill-allowance-"));
  await mkdir(path.join(skillsRoot, "granting-skill"));
  await writeFile(
    path.join(skillsRoot, "granting-skill", "granting-skill.md"),
    [
      "---",
      "name: granting-skill",
      "description: runs a workflow that dispatches",
      "workflow: granting-workflow",
      "---",
      "",
      "Body text.",
      "",
    ].join("\n"),
  );

  const skills = new SkillRegistry();
  await skills.loadFromDirectory(skillsRoot);

  const seen: { request: TaskRequest; allowedTools: { name: string }[] }[] = [];
  skills.registerWorkflow("granting-workflow", async (skill, context) => {
    await context.dispatcher!.dispatch([{ agent: "market_data", task: "from inside the workflow" }]);
    return { skill: skill.name, status: "ok", summary: "workflow ran" };
  });

  const subagents = new SubagentRegistry();
  for (const name of ["market_data", "trading_operations"] as const) {
    subagents.register({
      name,
      description: "d",
      modelClass: "MEDIUM",
      defaultTools: name === "market_data" ? ["own_tool"] : [],
      systemPrompt: { system: "", prompt: "" },
    });
  }
  const subagentRuntime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest; allowedTools: { name: string }[] }) => {
      seen.push({ request: ctx.request, allowedTools: ctx.allowedTools });
    },
  };

  const dispatchTools = new McpToolRegistry();
  dispatchTools.register({ name: "own_tool", description: "d", category: "non_trading",
    inputSchema: { type: "object" }, execute: async () => ({ summary: "ok" }) });

  const sessions = new SessionRegistry();
  const dispatcherFactory = (sessionId: string, tenantId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime as never, dispatchTools, sessions.getExisting(sessionId), tenantId);

  let call = 0;
  const provider: LlmProvider = {
    name: "stub",
    async generate(_messages: LlmMessage[], _options: GenerateOptions): Promise<GenerateResult> {
      call += 1;
      if (call === 1) {
        return { text: "loading the method",
          toolCalls: [{ id: "t1", name: "invoke_skill", input: { skill: "granting-skill" } }],
          metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "LARGE", provider: "stub" } };
      }
      return { text: "done", metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "LARGE", provider: "stub" } };
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

  await orchestrator.run({ tenantId: "agent-1", sessionId: "s1", userMessage: "go" });

  assert.equal(seen.length, 1, "the workflow's dispatch must reach the subagent runtime");
  // Skills no longer widen anyone's pool: the workflow's dispatch runs the agent exactly as the
  // topology declares it. (The legacy `skill` step field in the fixture also proves the fold-in
  // tolerance drives the same path.)
  assert.deepEqual(seen[0]!.allowedTools.map((tool) => tool.name), ["own_tool"],
    "the agent's own declared pool, nothing added");

  await rm(skillsRoot, { recursive: true, force: true });
});
