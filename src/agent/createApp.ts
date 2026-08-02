import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dispatcher } from "../framework/dispatcher.ts";
import { OrchestratorRuntime } from "../framework/orchestrator.ts";
import { SkillRegistry } from "../framework/skill.ts";
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

export type FinancialAgentApp = Awaited<ReturnType<typeof createFinancialAgentApp>>;

export async function createFinancialAgentApp() {
  const eventStore = await resolveEventStore();
  const sessions = new SessionRegistry(eventStore);
  const toolRegistry = new McpToolRegistry();
  registerAllTools(toolRegistry);

  const modelRouter = new ModelRouter(resolveLlmProvider());
  const subagents = createSubagentRegistry();
  const subagentRuntime = new SubagentRuntime(modelRouter, toolRegistry);
  const skills = new SkillRegistry();
  await skills.loadFromDirectory(resolveSkillsPath());

  const dispatcherFactory = (sessionId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime, toolRegistry, sessions.getExisting(sessionId));

  const orchestrator = new OrchestratorRuntime(
    orchestratorPrompt,
    modelRouter,
    dispatcherFactory,
    subagents,
    skills,
    toolRegistry,
    sessions,
  );

  // The Research controller (spec §4). It sits BESIDE the orchestrator, not
  // above it: `ask_topic` calls `orchestrator.run` — the same method a human
  // turn goes through — so the Topic agent never learns who is asking.
  const researchRuntime = new ResearchRuntime({
    prompt: researchPrompt,
    modelRouter,
    store: eventStore,
    sessions,
    topicOrchestrator: orchestrator,
  });

  // Keeps every Topic's own summary and category current, in the background.
  // Nothing reads from it — it only writes to `chat_rooms` — so both the
  // sidebar and the Research roster pick the result up through the store.
  const topicDigests = new TopicDigestScheduler({ store: eventStore, sessions, modelRouter });

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
