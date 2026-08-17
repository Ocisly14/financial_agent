import { resolveModelMap, type LlmMessage, type LlmProvider, type LlmToolCall, type GenerateOptions, type GenerateResult } from "./provider.ts";
import type { JsonObject } from "../../framework/types.ts";

// Override with GOOGLE_MODEL_{SMALL,MEDIUM,LARGE}.
const MODEL_MAP = resolveModelMap({
  SMALL: "gemini-2.5-flash",
  MEDIUM: "gemini-2.5-flash",
  LARGE: "gemini-2.5-pro",
}, ["GOOGLE"]);

type GeminiPart = { text?: string; functionCall?: { id?: string; name: string; args?: JsonObject };
  functionResponse?: { id?: string; name: string; response: JsonObject };
  // Gemini 3.x returns an opaque signature alongside each functionCall and requires it back,
  // verbatim, on every later turn that replays the call. See LlmToolCall.signature.
  thoughtSignature?: string };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  // Gemini reports the implicit-cache hit inside promptTokenCount, so the uncached remainder this
  // codebase calls tokens_in is promptTokenCount MINUS cachedContentTokenCount. Reporting the whole
  // prompt as tokens_in would hide every cache hit the run gets. Implicit caching has no write fee —
  // only an explicit cachedContents resource is billed for storage — so cache_write stays 0.
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
};

function toolResponse(content: string, isError = false): JsonObject {
  try {
    const parsed = JSON.parse(content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return isError ? { error: parsed } : parsed as JsonObject;
    }
    return isError ? { error: parsed } : { result: parsed };
  } catch {
    return isError ? { error: content } : { result: content };
  }
}

// The Generative Language API takes an OpenAPI-subset Schema, not full JSON Schema, and rejects the
// whole request (400 INVALID_ARGUMENT, "Unknown name") on any field outside that subset rather than
// ignoring it. Zod emits `additionalProperties: false` on every object, so an untouched tool schema
// fails before the model is ever reached. The Vertex path never hit this because the AI SDK's
// `jsonSchema()` strips it there.
// The 3.x flash/pro ceiling is 65536; DeepSeek here asks for 64000 on the same reasoning.
const MAX_OUTPUT_TOKENS = Number(process.env["GOOGLE_MAX_OUTPUT_TOKENS"] || 64_000);

// 429 (rate limited) and 5xx (overloaded / transient) are the server declining to answer right now.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = Number(process.env["GOOGLE_MAX_RETRIES"] || 4);
const RETRY_BASE_MS = 1_000;

const UNSUPPORTED_SCHEMA_KEYS = new Set(["additionalProperties", "$schema"]);

// `oneOf` is the worse case: the subset knows `anyOf` and simply DROPS `oneOf`, with no error at all.
// A discriminated union then reaches the model as "an object, contents unknown", and it invents field
// names to fill the hole. Measured directly against gemini-3.7-flash with this repo's own operations
// schema: under `oneOf` it produced {startPeriod, endPeriod, expression} — none of which exist — and
// with the identical schema under `anyOf` it produced {lineItemId, appliesTo, source, periodIds},
// correct on the first try. Every field description inside a variant is dropped with it, which is how
// an AMZN run spent 7 of its 30 steps guessing shapes and then wrote its terminal exit multiple as a
// bare constant through set_formula — the one operation whose shape it had finally learned.
//
// The two keywords differ only when more than one variant matches. These unions are discriminated by
// a `kind` enum, so exactly one ever matches and the rename is lossless.
export function toGeminiSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema) as T;
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key === "oneOf" ? "anyOf" : key] = toGeminiSchema(value);
  }
  return out as T;
}

/**
 * Gemini provider via the Google AI Studio (Generative Language) REST API.
 * Auth is the simple `?key=` query param using GOOGLE_GENERATIVE_AI_API_KEY —
 * no OAuth / service-account token minting (that is the Vertex path).
 */
export class GoogleProvider implements LlmProvider {
  name = "google";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://generativelanguage.googleapis.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const start = Date.now();
    const model = MODEL_MAP[options.modelClass] ?? MODEL_MAP["MEDIUM"]!;

    // Split system message out; Gemini takes it as `systemInstruction`.
    const systemMsg = messages.find((m) => m.role === "system");
    const contents: GeminiContent[] = [];
    for (const m of messages.filter((entry) => entry.role !== "system")) {
      // Gemini represents a tool result as a user functionResponse. The function name (and id on
      // models that emit one) preserves the association instead of making the response prose.
      const role = m.role === "assistant" ? "model" : "user";
      const parts: GeminiPart[] = m.role === "tool"
        ? [{ functionResponse: { ...(m.toolCallId ? { id: m.toolCallId } : {}),
          name: m.toolName ?? "tool", response: toolResponse(m.content, m.toolResultIsError) } }]
        : [
          ...(m.content === "" ? [] : [{ text: m.content }]),
          ...(m.toolCalls ?? []).map((call) => ({
            functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args: call.input },
            ...(call.signature ? { thoughtSignature: call.signature } : {}),
          })),
        ];
      if (parts.length === 0) continue;
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    }

    const body = {
      contents,
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      // Native function calling: functionCall args arrive as schema-constrained,
      // guaranteed-parseable JSON. Mode AUTO, not ANY: forcing a call suppresses
      // the model's reasoning and collapses planning into reflexive repeat calls.
      ...(options.tools?.length
        ? {
          tools: [{ functionDeclarations: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.inputSchema) })) }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        }
        : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        // 4096 truncated this agent's real steps: a batched patch call plus 3.x thinking tokens,
        // which count against the same budget, exceeded it mid-call. The step came back as prose,
        // the loop nudged it to act, and it truncated again — 8 wasted steps at 41k input each in
        // one TSLA run. Match the other providers: ask for the model's own ceiling.
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    };

    const streaming = Boolean(options.onToken);
    const method = streaming ? "streamGenerateContent" : "generateContent";
    const query = streaming ? "?alt=sse&key=" : "?key=";
    const url = `${this.baseUrl}/v1beta/models/${model}:${method}${query}${this.apiKey}`;

    // A dispatch is one long thread: the loop has no way to resume a step, so an error here throws
    // away every step before it. A single 503 "high demand" at step 21 of a TSLA run discarded four
    // minutes and 1.3M input tokens of committed work. Retry the errors that are the server saying
    // "not now" — never a 4xx, which would fail identically however many times it is sent.
    let response: Response | undefined;
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (response.ok) break;
      const err = await response.text();
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= MAX_RETRIES) {
        throw new Error(`Google API error ${response.status}: ${err}`);
      }
      // Exponential backoff with jitter, so several agents that hit the same spike do not all
      // come back at the same instant and recreate it.
      const delay = Math.round(RETRY_BASE_MS * 2 ** attempt * (1 + Math.random()));
      await new Promise((resolveDelay, rejectDelay) => {
        const timer = setTimeout(resolveDelay, delay);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); rejectDelay(new Error("aborted")); },
          { once: true });
      });
    }

    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    const toolCalls: LlmToolCall[] = [];

    if (streaming && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const event = JSON.parse(data) as GeminiResponse;
            const parts = event.candidates?.[0]?.content?.parts ?? [];
            const delta = parts.map((p) => p.text ?? "").join("");
            if (delta) {
              text += delta;
              options.onToken!(delta);
            }
            for (const part of parts) {
              if (part.functionCall) toolCalls.push({ ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
                name: part.functionCall.name, input: part.functionCall.args ?? {},
                ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) });
            }
            if (event.usageMetadata) {
              tokensIn = event.usageMetadata.promptTokenCount ?? tokensIn;
              tokensOut = event.usageMetadata.candidatesTokenCount ?? tokensOut;
              cacheRead = event.usageMetadata.cachedContentTokenCount ?? cacheRead;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } else {
      const json = (await response.json()) as GeminiResponse;
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      text = parts.map((p) => p.text ?? "").join("");
      for (const part of parts) {
        if (part.functionCall) toolCalls.push({ ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
          name: part.functionCall.name, input: part.functionCall.args ?? {},
          ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) });
      }
      tokensIn = json.usageMetadata?.promptTokenCount ?? 0;
      tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0;
      cacheRead = json.usageMetadata?.cachedContentTokenCount ?? 0;
    }

    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      metrics: {
        tokens_in: Math.max(0, tokensIn - cacheRead),
        tokens_out: tokensOut,
        cache_read: cacheRead,
        cache_write: 0,
        ms: Date.now() - start,
        model_class: options.modelClass,
        provider: this.name,
      },
    };
  }
}
