import type { JsonObject } from "../../framework/types.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("llm");

export type ModelClass = "SMALL" | "MEDIUM" | "LARGE";

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type GenerateOptions = {
  modelClass: ModelClass;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: JsonObject;
  onToken?: (delta: string) => void;
};

export type GenerateResult = {
  text: string;
  metrics: {
    tokens_in: number;
    tokens_out: number;
    ms: number;
    model_class: ModelClass;
    provider: string;
  };
};

export type LlmProvider = {
  name: string;
  generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult>;
};

export class ModelRouter {
  private readonly provider: LlmProvider;

  constructor(provider: LlmProvider) {
    this.provider = provider;
  }

  async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const meta = options.metadata ?? {};
    const label = meta.mode === "subagent"
      ? `subagent:${meta.agent ?? "?"}`
      : String(meta.mode ?? "llm");
    const start = Date.now();
    const result = await this.provider.generate(messages, options);
    const ms = Date.now() - start;
    const preview = result.text.length > 200 ? result.text.slice(0, 200) + "…" : result.text;
    log.info(`[${label}] ${ms}ms | in=${result.metrics.tokens_in} out=${result.metrics.tokens_out} | ${preview}`);
    return result;
  }
}

export class MockLlmProvider implements LlmProvider {
  name = "mock";

  async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const start = Date.now();
    const user = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const metadata = options.metadata ?? {};
    let text: string;

    if (metadata.mode === "subagent") {
      text = this.subagentResponse(user, metadata);
    } else {
      text = this.mainResponse(user);
    }

    if (options.onToken) {
      for (const token of text.split(/(\s+)/)) {
        if (token) options.onToken(token);
      }
    }

    return {
      text,
      metrics: {
        tokens_in: messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
        tokens_out: estimateTokens(text),
        ms: Date.now() - start,
        model_class: options.modelClass,
        provider: this.name,
      },
    };
  }

  private mainResponse(userPrompt: string): string {
    // The orchestrator runs a loop emitting one OrchestratorStep JSON per turn.
    // Mock behavior: first step dispatches one data task; once that result
    // appears in [CURRENT TURN PROGRESS], the next step is the terminal answer.
    if (userPrompt.includes("[CURRENT TURN PROGRESS]")) {
      return JSON.stringify({
        reply: "Based on the completed tasks, here is the synthesized answer.",
        dispatch: null,
        skill: null,
        tool_call: null,
      });
    }
    return JSON.stringify({
      reply: "Fetching the data needed to answer your request, one moment.",
      dispatch: [{ agent: "market_data", task: "Fetch the data needed to answer the user's request." }],
      skill: null,
      tool_call: null,
    });
  }

  private subagentResponse(userPrompt: string, metadata: JsonObject): string {
    // The subagent runs a tool-calling loop. The mock finishes immediately
    // (no real tool calls) so local/dev runs stay deterministic and offline.
    const task = extractBetween(userPrompt, "<task>", "</task>") || userPrompt;
    const agent = typeof metadata.agent === "string" ? metadata.agent : "market_data";
    return JSON.stringify({
      action: "finish",
      summary: `${agent} completed task: ${task.slice(0, 120)}`,
    });
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function extractBetween(text: string, start: string, end: string): string | null {
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return null;
  const bodyStart = startIndex + start.length;
  const endIndex = text.indexOf(end, bodyStart);
  if (endIndex === -1) return null;
  return text.slice(bodyStart, endIndex).trim();
}
