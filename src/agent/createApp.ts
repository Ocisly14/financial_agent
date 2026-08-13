import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dispatcher } from "../framework/dispatcher.ts";
import { OrchestratorRuntime } from "../framework/orchestrator.ts";
import { assertSubagentSkills, SkillRegistry } from "../framework/skill.ts";
import { createInvokeSkillTool, createReadSkillReferenceTool, createRunSkillScriptTool } from "../framework/skillTools.ts";
import { SubagentRuntime } from "../framework/subagent.ts";
import { MockLlmProvider, ModelRouter, type LlmProvider } from "../infra/llm/provider.ts";
import { AnthropicProvider } from "../infra/llm/anthropicProvider.ts";
import { GoogleProvider } from "../infra/llm/googleProvider.ts";
import { GoogleVertexProvider } from "../infra/llm/googleVertexProvider.ts";
import { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import { registerAllTools } from "../../mcp_tools/registerTools.ts";
import { SessionRegistry } from "../framework/sessionState.ts";
import { SqliteEventStore } from "../infra/db/sqliteEventStore.ts";
import { orchestratorPrompt } from "./prompts/orchestratorPrompt.ts";
import { createSubagentRegistry } from "./subagents/registerSubagents.ts";
import { ResearchRuntime } from "./research/researchRuntime.ts";
import { TopicDigestScheduler } from "../server/topicDigestScheduler.ts";
import { researchPrompt } from "./research/researchPrompt.ts";
import { getDefaultFinancialModelToolDeps } from "../../mcp_tools/financial-model/financialModelTools.ts";
import { createDcfSubagentTool } from "../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { createStatementExtractionTool } from "../../mcp_tools/financial-model/statementExtractionTool.ts";
import { createReadCompactedTaskDataTool } from "../../mcp_tools/session/readCompactedTaskDataTool.ts";

export type FinancialAgentApp = Awaited<ReturnType<typeof createFinancialAgentApp>>;

export async function createFinancialAgentApp() {
  const eventStore = await resolveEventStore();
  const sessions = new SessionRegistry(eventStore);
  const toolRegistry = new McpToolRegistry();
  const modelRouter = new ModelRouter(resolveLlmProvider());
  const financialModelDeps = getDefaultFinancialModelToolDeps();
  registerAllTools(toolRegistry, { financialModelDeps });
  // Both need the router, which registerAllTools has no handle on: extraction for its small-model
  // insight pass, the subagent tool for the subagents themselves.
  toolRegistry.register(createStatementExtractionTool({ modelRouter, financial: financialModelDeps }));
  const subagents = createSubagentRegistry();
  const skills = new SkillRegistry();
  await skills.loadFromDirectory(resolveSkillsPath());
  assertSubagentSkills(subagents.list(), skills);
  const subagentRuntime = new SubagentRuntime(modelRouter, toolRegistry, skills);

  toolRegistry.register(createInvokeSkillTool(skills));
  toolRegistry.register(createReadSkillReferenceTool(skills));
  toolRegistry.register(createRunSkillScriptTool(skills));
  toolRegistry.register(createReadCompactedTaskDataTool(sessions));
  // Registered after the runtime exists: run_dcf_subagent hands work to it. The registry is looked up
  // by name at call time, so registering into it after construction is fine.
  toolRegistry.register(createDcfSubagentTool({ subagentRuntime, subagents, sessions, financial: financialModelDeps }));

  const dispatcherFactory = (sessionId: string, agentId: string, state?: import("../framework/sessionState.ts").SessionState) =>
    new Dispatcher(sessionId, subagents, subagentRuntime, toolRegistry, state ?? sessions.getExisting(sessionId), agentId);

  const orchestrator = new OrchestratorRuntime(
    orchestratorPrompt,
    modelRouter,
    dispatcherFactory,
    subagents,
    skills,
    toolRegistry,
    sessions,
  );

  // Shared by the regular Topic endpoint and Research's dispatch_task
  // route, so the two origins have one digest lifecycle.
  const topicDigests = new TopicDigestScheduler({ store: eventStore, sessions, modelRouter });

  // The Research controller (spec §4). It sits BESIDE the orchestrator, not
  // above it: `dispatch_task` calls `orchestrator.run` — the same method a human
  // turn goes through — so the Topic agent never learns who is asking.
  const researchRuntime = new ResearchRuntime({
    prompt: researchPrompt,
    modelRouter,
    store: eventStore,
    sessions,
    topicOrchestrator: orchestrator,
    topicDigests,
    tools: toolRegistry,
    skills,
  });

  // Keeps every Topic's own summary and category current, in the background.
  // Nothing reads from it — it only writes to `chat_rooms` — so both the
  // sidebar and the Research roster pick the result up through the store.
  return {
    eventStore,
    sessions,
    toolRegistry,
    modelRouter,
    subagents,
    skills,
    orchestrator,
    researchRuntime,
    topicDigests,
    createDispatcher: dispatcherFactory,
  };
}

export function resolveLlmProvider(): LlmProvider {
  const provider = (process.env["LLM_PROVIDER"] ?? "").toLowerCase();
  const googleKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  const hasVertex = Boolean(process.env["GOOGLE_VERTEX_PROJECT"]);

  if (provider === "vertex" || provider === "google-vertex") {
    if (!hasVertex) {
      throw new Error("LLM_PROVIDER=vertex but GOOGLE_VERTEX_PROJECT is not set");
    }
    return new GoogleVertexProvider();
  }

  if (provider === "google" || provider === "gemini") {
    // Prefer Vertex (service-account auth) when configured; fall back to API key.
    if (hasVertex) return new GoogleVertexProvider();
    if (!googleKey) {
      throw new Error(
        "LLM_PROVIDER=google but neither GOOGLE_VERTEX_PROJECT nor GOOGLE_GENERATIVE_AI_API_KEY is set",
      );
    }
    return new GoogleProvider(googleKey);
  }

  if (provider === "anthropic") {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider(key);
  }

  // Auto-detect when LLM_PROVIDER is unset: prefer Vertex, then Google API key, then Anthropic.
  if (!provider) {
    if (hasVertex) return new GoogleVertexProvider();
    if (googleKey) return new GoogleProvider(googleKey);
    if (process.env["ANTHROPIC_API_KEY"]) {
      return new AnthropicProvider(process.env["ANTHROPIC_API_KEY"]!);
    }
  }

  // Default to mock (tests, local dev without an API key)
  return new MockLlmProvider();
}

async function resolveEventStore(): Promise<SqliteEventStore> {
  const databasePath = path.resolve(process.env["SESSION_DB_PATH"] ?? "data/sessions.sqlite");
  const store = SqliteEventStore.open(databasePath);
  console.log(`[sessions] SQLite persistence enabled at ${databasePath}`);
  return store;
}

function resolveSkillsPath(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(current, "../../skills");
}
