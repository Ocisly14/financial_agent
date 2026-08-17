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
  /** Native tool calls emitted by the preceding assistant turn. Providers that support tool
   * transcripts preserve these instead of flattening the later result into ordinary user text. */
  toolCalls?: LlmToolCall[];
  /** Correlates a native tool result with the assistant call that requested it. */
  toolCallId?: string;
  /** The tool name is redundant for OpenAI-compatible APIs, but required by Gemini's function response. */
  toolName?: string;
  /** Lets providers mark a native tool result as failed without losing the structured payload. */
  toolResultIsError?: boolean;
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
  /** Provider-generated id when available; the runtime supplies one for providers that omit it. */
  id?: string;
  name: string;
  input: JsonObject;
  /** Opaque provider token that must be handed back verbatim with this call on later turns.
   *  Gemini 3.x mints a `thoughtSignature` per function call and rejects (400) any subsequent
   *  request whose functionCall parts lack it, so the loop has to carry it, not just the args.
   *  Providers that mint no such token leave it unset and it never reaches the wire. */
  signature?: string;
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
    /** Prompt tokens billed at full price. With prompt caching this is only the UNCACHED
     *  remainder — the whole prompt is tokens_in + cache_write + cache_read. */
    tokens_in: number;
    tokens_out: number;
    /** Prompt tokens read from cache, and written to it. Optional because only providers
     *  that do prefix caching report them; absent is "this provider does not say", while
     *  0 is "nothing was cached". */
    cache_read?: number;
    cache_write?: number;
    ms: number;
    model_class: ModelClass;
    provider: string;
  };
};

export type LlmProvider = {
  name: string;
  generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult>;
};

/**
 * A reply the provider could not turn into a usable result — malformed tool-call arguments,
 * a truncated stream, a body that is not the documented shape.
 *
 * `retryable` says whether the *same request* is worth sending again. A sample that came back
 * corrupt is: generation is nondeterministic, so the next one is usually clean. A reply cut off
 * because it hit the output cap is not — the retry reproduces the truncation and burns another
 * full generation to do it. Getting this wrong in either direction is expensive, so providers
 * must decide it from `finish_reason`, never from the parse error alone.
 */
export class MalformedResponseError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MalformedResponseError";
    this.retryable = options.retryable;
  }
}

/**
 * Per-class model ids for one provider, read from `<PREFIX>_MODEL_{SMALL,MEDIUM,LARGE}`.
 *
 * Overrides are namespaced per provider rather than shared: a single global override
 * would hand whichever provider is selected another vendor's model ids, which they
 * reject outright. `prefixes` is tried in order, so a provider can accept a family-wide
 * fallback (Vertex reads VERTEX_MODEL_*, then GOOGLE_MODEL_*).
 *
 * A declared-but-empty variable counts as unset — `.env` files carry blank placeholders,
 * and forwarding "" as a model id fails at the API.
 */
export function resolveModelMap(
  defaults: Record<ModelClass, string>,
  prefixes: string[],
  env: Record<string, string | undefined> = process.env,
): Record<ModelClass, string> {
  const resolve = (modelClass: ModelClass): string => {
    for (const prefix of prefixes) {
      const value = env[`${prefix}_MODEL_${modelClass}`];
      if (value) return value;
    }
    return defaults[modelClass];
  };
  return { SMALL: resolve("SMALL"), MEDIUM: resolve("MEDIUM"), LARGE: resolve("LARGE") };
}

/**
 * A cached prompt is billed in three tiers, and reading only one of them misleads. Anthropic bills a
 * cache read at ~0.1x the input price and a cache WRITE at ~1.25x — above full price — so a change
 * that moves tokens out of `tokens_in` can still cost more. Weighting them here gives one number an
 * optimization can be judged on; `tokens_in` alone cannot.
 */
const CACHE_READ_PRICE = 0.1;
const CACHE_WRITE_PRICE = 1.25;

export type LlmCostRow = {
  calls: number; tokens_in: number; cache_read: number; cache_write: number; tokens_out: number;
};

/** Per-label prompt totals for this process, accumulated by every ModelRouter. */
const costByLabel = new Map<string, LlmCostRow>();

/**
 * What each agent's prompts cost so far, with the weighted input total that says whether a caching
 * change actually paid. `cache_read_write_ratio` is the health signal: below 1 the run is writing
 * entries it never reads back, which is the failure mode that looks like a win in `tokens_in`.
 */
export function llmCostReport(): Record<string, LlmCostRow & {
  equivalent_input_tokens: number; cache_read_write_ratio: number | null;
}> {
  const report: Record<string, LlmCostRow & { equivalent_input_tokens: number; cache_read_write_ratio: number | null }> = {};
  for (const [label, row] of costByLabel) {
    report[label] = { ...row,
      equivalent_input_tokens: Math.round(
        row.tokens_in + row.cache_read * CACHE_READ_PRICE + row.cache_write * CACHE_WRITE_PRICE),
      cache_read_write_ratio: row.cache_write === 0 ? null : Number((row.cache_read / row.cache_write).toFixed(2)) };
  }
  return report;
}

/** Clears the totals. For tests, and for a harness that reports per run rather than per process. */
export function resetLlmCostReport(): void {
  costByLabel.clear();
}

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
    const result = await this.generateWithRetries(messages, options, label, start);
    const ms = Date.now() - start;
    const preview = result.toolCalls?.length
      ? `tool_calls=[${result.toolCalls.map((c) => c.name).join(",")}]`
      : (result.text.length > 200 ? result.text.slice(0, 200) + "…" : result.text);
    // `in=` is the uncached remainder, so on a caching provider it reads far below the real prompt.
    // Print the cache halves next to it or the line invites exactly that misreading.
    const { cache_read: cacheRead, cache_write: cacheWrite } = result.metrics;
    const row = costByLabel.get(label)
      ?? { calls: 0, tokens_in: 0, cache_read: 0, cache_write: 0, tokens_out: 0 };
    costByLabel.set(label, { calls: row.calls + 1,
      tokens_in: row.tokens_in + result.metrics.tokens_in,
      cache_read: row.cache_read + (cacheRead ?? 0),
      cache_write: row.cache_write + (cacheWrite ?? 0),
      tokens_out: row.tokens_out + result.metrics.tokens_out });
    const cache = cacheRead === undefined && cacheWrite === undefined
      ? "" : ` cache_r=${cacheRead ?? 0} cache_w=${cacheWrite ?? 0}`;
    log.info(`[${label}] ${ms}ms | in=${result.metrics.tokens_in}${cache} out=${result.metrics.tokens_out} | ${preview}`);
    return result;
  }

  /**
   * Sends the request, re-sending it when the provider returns a corrupt sample.
   *
   * A malformed reply used to be fatal: one bad byte in a streamed tool-call argument threw a
   * bare `SyntaxError` out of the provider, past the subagent loop, and ended a 40-minute DCF
   * run with nine revisions of committed work still on the floor. The reply is a draw from a
   * distribution, so re-drawing it is the whole fix — but only for faults that are properties
   * of the sample. `MalformedResponseError.retryable` is what carries that distinction; every
   * other error (auth, rate limits, a 400 on the request itself) is the caller's to handle and
   * passes straight through, because re-sending it just pays for the same failure twice.
   */
  private async generateWithRetries(
    messages: LlmMessage[],
    options: GenerateOptions,
    label: string,
    start: number,
  ): Promise<GenerateResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.provider.generate(messages, options);
      } catch (error) {
        const retryable = error instanceof MalformedResponseError && error.retryable
          && attempt < MAX_MALFORMED_ATTEMPTS && options.signal?.aborted !== true;
        if (!retryable) {
          // Callers see only `error.message` — for ai-sdk that is a bare "Invalid JSON response",
          // which hides the status code and provider body needed to tell a 429 from a 400.
          log.error(`[${label}] failed after ${Date.now() - start}ms | ${JSON.stringify(describeProviderError(error))}`);
          throw error;
        }
        log.warn(`[${label}] malformed reply on attempt ${attempt}/${MAX_MALFORMED_ATTEMPTS}, resending`
          + ` | ${(error as Error).message}`);
      }
    }
  }
}

/** Attempts spent on one call before a corrupt reply is allowed to fail it. */
const MAX_MALFORMED_ATTEMPTS = 3;

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
