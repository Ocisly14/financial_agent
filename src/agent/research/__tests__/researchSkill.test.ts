import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, type GenerateOptions, type LlmMessage, type LlmProvider } from "../../../infra/llm/provider.ts";
import { SessionRegistry } from "../../../framework/sessionState.ts";
import { InMemoryEventStore } from "../../../framework/eventStore.ts";
import type { CompactionCache } from "../../../framework/eventStore.ts";
import { SkillRegistry } from "../../../framework/skill.ts";
import type { SkillDefinition } from "../../../framework/skill.ts";
import type { SkillLayer } from "../../../framework/types.ts";
import type { ResearchMember, TopicChartPreferenceRow, TopicSummary } from "../../../infra/db/sqliteEventStore.ts";
import type { McpToolRegistry } from "../../../../mcp_tools/toolRegistry.ts";
import { researchPrompt } from "../researchPrompt.ts";
import { ResearchRuntime, parseResearchStep, type ResearchRunInput, type ResearchRuntimeStore } from "../researchRuntime.ts";
import type { TopicOrchestrator } from "../tools.ts";

// ── doubles for the runtime-level skill tests ──────────────────────────────

/** A store with no members: `buildMemberContext` short-circuits before ever
 *  touching charts/compaction, so nothing else needs implementing here. */
class EmptyResearchStore implements ResearchRuntimeStore {
  createTopic(_agentId: string, topicId: string, name: string, createdAt = Date.now()): TopicSummary {
    return {
      id: topicId, name, leadSymbol: null, subjectSymbols: [], createdAt, lastMessage: null, messageCount: 0,
      summary: null, category: null, categoryLocked: false,
    };
  }
  listTopics(): TopicSummary[] {
    return [];
  }
  listTopicCharts(): TopicChartPreferenceRow[] {
    return [];
  }
  replaceTopicCharts(): void {}
  listResearchMembers(): ResearchMember[] {
    return [];
  }
  replaceResearchMembers(): void {}
  setMemberSeenTurn(): void {}
  async loadCompaction(): Promise<CompactionCache | undefined> {
    return undefined;
  }
}

/** Builds a `SkillRegistry` carrying exactly one skill, without touching disk —
 *  the registry's own loader only reads from a directory, so the test injects
 *  the definition directly onto its private map. */
function registryWith(spec: {
  name: string;
  layer: SkillLayer;
  body: string;
  topicSection?: string;
  description?: string;
}): SkillRegistry {
  const registry = new SkillRegistry();
  const skill: SkillDefinition = {
    name: spec.name,
    description: spec.description ?? `A ${spec.name} skill.`,
    path: `/virtual/${spec.name}/${spec.name}.md`,
    dir: `/virtual/${spec.name}`,
    layer: spec.layer,
    body: spec.body,
    agentSections: {},
  };
  if (spec.topicSection !== undefined) skill.topicSection = spec.topicSection;
  (registry as unknown as { skills: Map<string, SkillDefinition> }).skills.set(skill.name, skill);
  return registry;
}

/** A fixed, minimal turn input — the tests only care about what happens
 *  inside the run loop, not about the input's own field values. */
function runInput(): ResearchRunInput {
  return {
    agentId: "default",
    researchId: "res_1",
    researchName: "半导体估值",
    userMessage: "半导体这一批怎么看？",
    emit: () => {},
  };
}

type RuntimeHarness = {
  run: (input: ResearchRunInput) => Promise<{ response: string }>;
  lastPrompts: string[];
  topicRuns: Array<{ sessionId: string; userMessage: string; allowUserInput?: boolean }>;
  protocolErrors: string[];
};

/** Wires a `ResearchRuntime` to a scripted model (one completion per step, the
 *  last one repeats if the loop runs longer) and a fake Topic orchestrator
 *  that just records what it was asked — same construction style as
 *  `tools.test.ts`'s `harness()`. */
function makeRuntime(options: { completions: string[]; skills: SkillRegistry }): RuntimeHarness {
  const lastPrompts: string[] = [];
  let call = 0;
  const provider: LlmProvider = {
    name: "fake",
    async generate(messages: LlmMessage[], genOptions: GenerateOptions) {
      const text = options.completions[call] ?? options.completions.at(-1) ?? '{"reply":"","tool_calls":null}';
      call += 1;
      const userContent = messages.find((m) => m.role === "user")?.content ?? "";
      lastPrompts.push(String(userContent));
      return {
        text,
        metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: genOptions.modelClass, provider: "fake" },
      };
    },
  };
  const modelRouter = new ModelRouter(provider);

  const store = new EmptyResearchStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const topicRuns: Array<{ sessionId: string; userMessage: string; allowUserInput?: boolean }> = [];
  const topicOrchestrator: TopicOrchestrator = {
    async run(input) {
      topicRuns.push(input);
      return { response: `reply to ${input.userMessage}` };
    },
    async consult(input) {
      return { response: `consultation for ${input.question}` };
    },
  };
  const tools = {} as unknown as McpToolRegistry; // unused by these tests: no ask_user call is scripted

  const runtime = new ResearchRuntime({
    prompt: researchPrompt,
    modelRouter,
    store,
    sessions,
    topicOrchestrator,
    tools,
    skills: options.skills,
  });

  const protocolErrors: string[] = [];

  return {
    async run(input: ResearchRunInput) {
      const result = await runtime.run(input);
      const state = await sessions.getOrCreate(input.researchId);
      protocolErrors.push(
        ...state
          .allEvents()
          .filter((e) => e.kind === "error" && e.payload.scope === "protocol")
          .map((e) => String(e.payload.message)),
      );
      return result;
    },
    lastPrompts,
    topicRuns,
    protocolErrors,
  };
}

test("a step carrying only a skill parses with no tool calls", () => {
  const step = parseResearchStep('{"reply":"好的","skill":"top-down-research","tool_calls":null}');
  assert.equal(step.skill, "top-down-research");
  assert.deepEqual(step.toolCalls, []);
});

test("skill is null when absent", () => {
  const step = parseResearchStep('{"reply":"好的","tool_calls":null}');
  assert.equal(step.skill, null);
});

test("a non-string skill is treated as absent", () => {
  const step = parseResearchStep('{"reply":"好的","skill":42,"tool_calls":null}');
  assert.equal(step.skill, null);
});

test("an empty skill string is treated as absent", () => {
  const step = parseResearchStep('{"reply":"好的","skill":"   ","tool_calls":null}');
  assert.equal(step.skill, null);
});

test("skill and tool_calls both parse; the runtime, not the parser, rejects the pair", () => {
  const step = parseResearchStep(
    '{"reply":"好的","skill":"top-down-research","tool_calls":[{"name":"focus","input":{"topic_id":"t1"}}]}',
  );
  assert.equal(step.skill, "top-down-research");
  assert.equal(step.toolCalls.length, 1);
});

// ── runtime: invoking a research-layer skill ────────────────────────────────

test("invoking a research-layer skill records skill_result and installs the topic section", async () => {
  // 模型脚本:第 1 步只 invoke 技能;第 2 步驱动一个 member;第 3 步收口。
  const runtime = makeRuntime({
    completions: [
      '{"reply":"读取方法后开始","skill":"probe","tool_calls":null}',
      '{"reply":"正在查","tool_calls":[{"name":"dispatch_task","input":{"topic_id":"room_a","message":"半导体怎么样？"}}]}',
      '{"reply":"结论如下","tool_calls":null}',
    ],
    skills: registryWith({
      name: "probe",
      layer: "research",
      body: "Probe body.",
      topicSection: "请给出具体读数和日期。",
    }),
  });

  await runtime.run(runInput());

  // 技能正文进入了下一步的历史投影
  assert.match(runtime.lastPrompts[1]!, /Probe body\./);
  // 小节确实落到了发给 member 的文字上
  assert.equal(
    runtime.topicRuns[0]!.userMessage,
    "半导体怎么样？\n\n请给出具体读数和日期。",
  );
});

test("skill and tool_calls in one step is a protocol error and runs nothing", async () => {
  const runtime = makeRuntime({
    completions: [
      '{"reply":"两个一起","skill":"probe","tool_calls":[{"name":"dispatch_task","input":{"topic_id":"room_a","message":"喂"}}]}',
      '{"reply":"收口","tool_calls":null}',
    ],
    skills: registryWith({ name: "probe", layer: "research", body: "Probe body.", topicSection: "请给出读数。" }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.topicRuns.length, 0);
  assert.equal(runtime.protocolErrors.length, 1);
  assert.match(runtime.protocolErrors[0]!, /exclusive/i);
});

test("an unknown skill name is a protocol error naming the available skills", async () => {
  const runtime = makeRuntime({
    completions: [
      '{"reply":"试试","skill":"nope","tool_calls":null}',
      '{"reply":"收口","tool_calls":null}',
    ],
    skills: registryWith({ name: "probe", layer: "research", body: "Probe body." }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.protocolErrors.length, 1);
  assert.match(runtime.protocolErrors[0]!, /probe/);
});

test("a topic-layer skill is invisible to the research controller", async () => {
  const runtime = makeRuntime({
    completions: [
      '{"reply":"试试","skill":"stock-analysis","tool_calls":null}',
      '{"reply":"收口","tool_calls":null}',
    ],
    skills: registryWith({ name: "stock-analysis", layer: "topic", body: "Topic body." }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.protocolErrors.length, 1);
});
