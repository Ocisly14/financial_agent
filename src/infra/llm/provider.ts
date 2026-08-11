import type { JsonObject } from "../../framework/types.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("llm");

export type ModelClass = "SMALL" | "MEDIUM" | "LARGE";

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Marks the end of a cacheable prefix: everything up to and including this
   * message is stable across calls and worth a provider-side cache breakpoint.
   * Providers without prompt caching ignore it. */
  cache?: boolean;
};

/** Native function-calling tool spec: schema-constrained decoding makes the
 * provider guarantee well-formed JSON arguments, eliminating the class of
 * "model hand-wrote JSON and dropped a brace" failures. */
export type LlmToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

export type LlmToolCall = {
  name: string;
  input: JsonObject;
};

export type GenerateOptions = {
  modelClass: ModelClass;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: JsonObject;
  onToken?: (delta: string) => void;
  /** When set, the provider MUST answer with tool calls (tool_choice=any/required). */
  tools?: LlmToolSpec[];
};

export type GenerateResult = {
  text: string;
  /** Present when `options.tools` was set and the provider returned tool calls. */
  toolCalls?: LlmToolCall[];
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
    let result: GenerateResult;
    try {
      result = await this.provider.generate(messages, options);
    } catch (error) {
      // Callers see only `error.message` — for ai-sdk that is a bare "Invalid JSON response",
      // which hides the status code and provider body needed to tell a 429 from a 400.
      log.error(`[${label}] failed after ${Date.now() - start}ms | ${JSON.stringify(describeProviderError(error))}`);
      throw error;
    }
    const ms = Date.now() - start;
    const preview = result.toolCalls?.length
      ? `tool_calls=[${result.toolCalls.map((c) => c.name).join(",")}]`
      : (result.text.length > 200 ? result.text.slice(0, 200) + "…" : result.text);
    log.info(`[${label}] ${ms}ms | in=${result.metrics.tokens_in} out=${result.metrics.tokens_out} | ${preview}`);
    return result;
  }
}

/** Flattens a provider error (ai-sdk, fetch, or ours) into the fields that identify the failure. */
export function describeProviderError(error: unknown): Record<string, unknown> {
  const described: Record<string, unknown> = {};
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== "object") {
      described[key(described, "value")] = String(current);
      break;
    }
    const record = current as Record<string, unknown>;
    if (current instanceof Error) {
      described[key(described, "name")] = current.name;
      described[key(described, "message")] = current.message;
    }
    // ai-sdk APICallError carries the HTTP status and the verbatim body it could not parse.
    for (const field of ["statusCode", "status", "url", "isRetryable", "responseBody", "data", "type", "code"]) {
      const value = record[field];
      if (value === undefined) continue;
      described[key(described, field)] = typeof value === "string" ? truncate(value) : value;
    }
    const headers = record["responseHeaders"];
    if (headers && typeof headers === "object") {
      const relevant: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        // Rate-limit and quota answers live in these headers; the rest is noise.
        if (/retry-after|ratelimit|quota/i.test(name)) relevant[name] = value;
      }
      if (Object.keys(relevant).length > 0) described[key(described, "responseHeaders")] = relevant;
    }
    current = record["cause"];
  }
  return described;
}

/** Keeps a cause's field instead of overwriting the outer error's, e.g. `message` then `cause.message`. */
function key(described: Record<string, unknown>, field: string): string {
  if (!(field in described)) return field;
  let suffix = 2;
  while (`${field}.${suffix}` in described) suffix += 1;
  return `${field}.${suffix}`;
}

function truncate(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…[${value.length} chars]` : value;
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
