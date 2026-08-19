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
import { ResearchRuntime, type ResearchRunInput, type ResearchRuntimeStore } from "../researchRuntime.ts";
import type { TopicOrchestrator } from "../tools.ts";

// ── doubles for the runtime-level skill tests ──────────────────────────────

/** A store with no members: `buildMemberContext` short-circuits before ever
 *  touching charts/compaction, so nothing else needs implementing here. */
class EmptyResearchStore implements ResearchRuntimeStore {
  createTopic(_tenantId: string, topicId: string, name: string, createdAt = Date.now()): TopicSummary {
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
    tenantId: "default",
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
type FakeCompletion = { text: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, never> | Record<string, string> }> };

function makeRuntime(options: { completions: FakeCompletion[]; skills: SkillRegistry }): RuntimeHarness {
  const lastPrompts: string[] = [];
  let call = 0;
  const provider: LlmProvider = {
    name: "fake",
    async generate(messages: LlmMessage[], genOptions: GenerateOptions) {
      const step = options.completions[call] ?? options.completions.at(-1) ?? { text: "" };
      call += 1;
      const userContent = messages.find((m) => m.role === "user")?.content ?? "";
      lastPrompts.push(String(userContent));
      return {
        text: step.text,
        ...(step.toolCalls ? { toolCalls: step.toolCalls } : {}),
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







// ── runtime: invoking a research-layer skill ────────────────────────────────

test("invoking a research-layer skill lands its guidance in the controller's own progress, and nothing is appended to member drives", async () => {
  // 模型脚本:第 1 步 invoke 技能(规范形态);第 2 步驱动一个 member;第 3 步收口。
  const runtime = makeRuntime({
    completions: [
      { text: "读取方法后开始", toolCalls: [{ id: "t1", name: "invoke_skill", input: { skill: "probe" } }] },
      { text: "正在查", toolCalls: [{ id: "t2", name: "dispatch_task", input: { topic_id: "room_a", message: "半导体怎么样？" } }] },
      { text: "结论如下" },
    ],
    skills: registryWith({
      name: "probe",
      layer: "research",
      body: "Probe body.",
      topicSection: "请给出具体读数和日期。",
    }),
  });

  await runtime.run(runInput());

  // 技能正文进入了下一步的历史投影——这是它唯一的作用点：控制器自己。
  assert.match(runtime.lastPrompts[1]!, /Probe body\./);
  // member 收到的就是控制器写的字，framework 不再背着它追加任何东西。
  assert.equal(runtime.topicRuns[0]!.userMessage, "半导体怎么样？");
});

test("invoke_skill beside another call is a protocol error and runs nothing", async () => {
  const runtime = makeRuntime({
    completions: [
      { text: "两个一起", toolCalls: [
        { id: "t1", name: "invoke_skill", input: { skill: "probe" } },
        { id: "t2", name: "dispatch_task", input: { topic_id: "room_a", message: "喂" } },
      ] },
      { text: "收口" },
    ],
    skills: registryWith({ name: "probe", layer: "research", body: "Probe body." }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.topicRuns.length, 0);
  assert.equal(runtime.protocolErrors.length, 1);
  assert.match(runtime.protocolErrors[0]!, /only call/);
});

test("an unknown skill name is a protocol error naming the available skills", async () => {
  const runtime = makeRuntime({
    completions: [
      { text: "试试", toolCalls: [{ id: "t1", name: "invoke_skill", input: { skill: "nope" } }] },
      { text: "收口" },
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
      { text: "试试", toolCalls: [{ id: "t1", name: "invoke_skill", input: { skill: "stock-analysis" } }] },
      { text: "收口" },
    ],
    skills: registryWith({ name: "stock-analysis", layer: "topic", body: "Topic body." }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.protocolErrors.length, 1);
});
