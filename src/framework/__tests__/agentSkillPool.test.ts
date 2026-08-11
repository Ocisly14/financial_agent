import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertSubagentSkills, SkillRegistry } from "../skill.ts";
import { createInvokeSkillTool } from "../skillTools.ts";
import { assertToolAllowedForAgent } from "../toolAccess.ts";
import { SubagentRuntime, type SubagentDefinition } from "../subagent.ts";
import { SessionState } from "../sessionState.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateOptions, GenerateResult, LlmMessage, LlmProvider, LlmToolSpec } from "../../infra/llm/provider.ts";
import type { JsonObject } from "../types.ts";

/**
 * A subagent owns its skills: it sees its own roster, invokes for itself, and a
 * skill it invokes can hand it tools its pool did not carry.
 */

const AGENT_SKILL = [
  "---",
  "name: demo-modeling",
  "description: How to do the demo work.",
  "layer: agent",
  "tools: [granted_tool]",
  "---",
  "Stage one: do the thing.",
  "",
].join("\n");

async function skillsRoot(content = AGENT_SKILL, name = "demo-modeling"): Promise<SkillRegistry> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-skill-"));
  await mkdir(path.join(root, name));
  await writeFile(path.join(root, name, `${name}.md`), content, "utf8");
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(root);
  return registry;
}

test("invoke_skill returns the agent-layer body and the tools it declares", async () => {
  const skills = await skillsRoot();
  const tool = createInvokeSkillTool(skills);

  const result = await tool.execute({ skill: "demo-modeling" } as JsonObject, {} as never);

  assert.equal(result.error, undefined);
  const data = result.generation_context?.data as Record<string, unknown>;
  assert.match(data["content"] as string, /Stage one: do the thing/);
  assert.deepEqual(data["tools"], ["granted_tool"]);
});

test("invoke_skill refuses a topic-layer name — only agent-layer skills are invokable this way", async () => {
  const skills = await skillsRoot(
    ["---", "name: demo-topic", "description: A topic skill.", "---", "Body.", ""].join("\n"),
    "demo-topic",
  );
  const tool = createInvokeSkillTool(skills);

  const result = await tool.execute({ skill: "demo-topic" } as JsonObject, {} as never);

  assert.equal(result.error?.code, "skill_not_found");
});

test("the skill framework tools are exempt from the category gate", () => {
  // They belong to no domain: gating them by domain would mean no subagent
  // could ever read its own methodology.
  assert.doesNotThrow(() => assertToolAllowedForAgent("financial_modeling", "invoke_skill", "main"));
  assert.doesNotThrow(() => assertToolAllowedForAgent("financial_modeling", "read_skill_reference", "main"));
  assert.throws(() => assertToolAllowedForAgent("financial_modeling", "create_strategy", "trading"));
});

test("assertSubagentSkills rejects an unknown skill name at startup", async () => {
  const skills = await skillsRoot();
  assert.throws(
    () => assertSubagentSkills([{ name: "financial_modeling", skills: ["no-such-skill"] }], skills),
    /declares unknown skill 'no-such-skill'/,
  );
});

test("assertSubagentSkills rejects a topic-layer skill claimed by an agent", async () => {
  const skills = await skillsRoot(
    ["---", "name: demo-topic", "description: A topic skill.", "---", "Body.", ""].join("\n"),
    "demo-topic",
  );
  assert.throws(
    () => assertSubagentSkills([{ name: "financial_modeling", skills: ["demo-topic"] }], skills),
    /which is a topic-layer skill/,
  );
});

test("assertSubagentSkills passes an agent that declares no skills", async () => {
  const skills = await skillsRoot();
  assert.doesNotThrow(() => assertSubagentSkills([{ name: "market_data" }], skills));
});

// ---- the runtime: roster, ownership, and the grant taking effect ----

function runtimeHarness(definitionOverrides: Partial<SubagentDefinition>, skills: SkillRegistry): {
  runtime: SubagentRuntime;
  definition: SubagentDefinition;
  state: SessionState;
  toolSpecsPerStep: string[][];
  systemPrompts: string[];
} {
  const tools = new McpToolRegistry();
  tools.register(createInvokeSkillTool(skills));
  tools.register({ name: "granted_tool", description: "d", category: "non_trading",
    inputSchema: { type: "object" }, execute: async () => ({ summary: "ok" }) });

  const toolSpecsPerStep: string[][] = [];
  const systemPrompts: string[] = [];
  let call = 0;
  const provider: LlmProvider = {
    name: "stub",
    async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
      call += 1;
      toolSpecsPerStep.push(((options.tools ?? []) as LlmToolSpec[]).map((spec) => spec.name));
      systemPrompts.push(messages.map((m) => m.content).join("\n"));
      const toolCalls = call === 1
        ? [{ id: "t1", name: "invoke_skill", input: { skill: "demo-modeling" } }]
        : [{ id: "t2", name: "finish", input: { summary: "done" } }];
      return { text: "note", toolCalls, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };

  const definition: SubagentDefinition = {
    name: "financial_modeling",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: ["invoke_skill"],
    skills: ["demo-modeling"],
    systemPrompt: { system: "Your skills:\n{{skills}}", prompt: "{{task}}\n{{progress}}" },
    maxToolSteps: 4,
    ...definitionOverrides,
  };

  const runtime = new SubagentRuntime(new ModelRouter(provider), tools, skills);
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  return { runtime, definition, state, toolSpecsPerStep, systemPrompts };
}

test("the agent's roster reaches its system prompt, and an invoked skill's tools reach the next step", async () => {
  const skills = await skillsRoot();
  const { runtime, definition, state, toolSpecsPerStep, systemPrompts } = runtimeHarness({}, skills);

  await runtime.run(definition, {
    sessionId: "s", agentId: "a", taskId: "t", threadId: "th", state,
    request: { agent: "financial_modeling", task: "do it" },
    allowedTools: [{ name: "invoke_skill", description: "d", category: "main", inputSchema: { type: "object" } }],
  });

  assert.match(systemPrompts[0]!, /demo-modeling: How to do the demo work\./);
  assert.deepEqual(toolSpecsPerStep[0], ["invoke_skill", "finish"]);
  // The grant is live from the very next step — this is the whole point of the
  // tool set being mutable rather than a snapshot taken at dispatch.
  assert.deepEqual(toolSpecsPerStep[1], ["invoke_skill", "granted_tool", "finish"]);
});

test("a skill outside the agent's roster never reaches the registry", async () => {
  const skills = await skillsRoot();
  const { runtime, definition, state, toolSpecsPerStep } = runtimeHarness({ skills: [] }, skills);

  await runtime.run(definition, {
    sessionId: "s", agentId: "a", taskId: "t", threadId: "th", state,
    request: { agent: "financial_modeling", task: "do it" },
    allowedTools: [{ name: "invoke_skill", description: "d", category: "main", inputSchema: { type: "object" } }],
  });

  const errors = state.subagentToolErrors({ thread: "th" });
  assert.ok(errors.some((e) => e.code === "skill_not_allowed"), "the call must be refused before execution");
  // No grant, so the tool set is unchanged on the following step.
  assert.deepEqual(toolSpecsPerStep[1], ["invoke_skill", "finish"]);
});
