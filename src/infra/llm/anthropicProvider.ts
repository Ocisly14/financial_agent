import { resolveModelMap, type LlmMessage, type LlmProvider, type LlmToolCall, type GenerateOptions, type GenerateResult } from "./provider.ts";
import type { JsonObject } from "../../framework/types.ts";

// Override with ANTHROPIC_MODEL_{SMALL,MEDIUM,LARGE}.
const MODEL_MAP = resolveModelMap({
  SMALL: "claude-haiku-4-5-20251001",
  MEDIUM: "claude-sonnet-5",
  LARGE: "claude-opus-5",
}, ["ANTHROPIC"]);

type AnthropicTextBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type AnthropicToolUseBlock = { type: "tool_use"; id: string; name: string; input: JsonObject };
type AnthropicToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

/** Fold conversation messages into alternating-role block messages, stamping a
 * cache breakpoint on each block whose source message ended a cacheable prefix.
 * A breakpoint caches the entire request prefix before it (tools + system +
 * earlier blocks), so the growing tail is the only full-price part per step. */
function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = message.role === "tool"
      ? [{ type: "tool_result", tool_use_id: message.toolCallId ?? message.toolName ?? "tool", content: message.content,
        ...(message.toolResultIsError ? { is_error: true } : {}) }]
      : [
        ...(message.content === "" ? [] : [{ type: "text" as const, text: message.content,
          ...(message.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }]),
        ...(message.toolCalls ?? []).map((call, index): AnthropicToolUseBlock => ({
          type: "tool_use", id: call.id ?? `toolcall_${index}`, name: call.name, input: call.input,
        })),
      ];
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

// Claude 5 and later reject `temperature` outright ("`temperature` is deprecated for this model").
// Learned per model id at runtime rather than from a hardcoded list, so a newer model that also
// drops the parameter costs one retry instead of a 400 that kills the caller's loop.
const temperatureDeprecated = new Set<string>();

// max_tokens is mandatory, so "no limit" means each model's own ceiling. We ask for more than any
// model allows and let the 400 tell us the real number (it states it verbatim), rather than
// maintaining a per-model table that goes stale. Claude 5 thinks adaptively and charges thinking
// against this budget, so a low cap silently yields a reply with zero text blocks.
const REQUESTED_MAX_TOKENS = Number(process.env["LLM_MAX_TOKENS"] || 200_000);
const modelMaxTokens = new Map<string, number>();
const MAX_TOKENS_CEILING = /max_tokens:\s*\d+\s*>\s*(\d+)/;

export class AnthropicProvider implements LlmProvider {
  name = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const start = Date.now();
    const model = MODEL_MAP[options.modelClass] ?? MODEL_MAP["MEDIUM"]!;

    // Split system message from conversation messages
    const systemMsg = messages.find((m) => m.role === "system");
    const conversation = toAnthropicMessages(messages.filter((m) => m.role !== "system"));

    const post = () => fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: modelMaxTokens.get(model) ?? REQUESTED_MAX_TOKENS,
        ...(temperatureDeprecated.has(model) ? {} : { temperature: options.temperature ?? 0.2 }),
        ...(systemMsg
          ? { system: systemMsg.cache
            ? [{ type: "text", text: systemMsg.content, cache_control: { type: "ephemeral" } }]
            : systemMsg.content }
          : {}),
        // Native function calling: the schema constrains decoding, so tool inputs
        // arrive as guaranteed-parseable JSON instead of hand-written text.
        // tool_choice stays "auto", never "any": forced tool use disables adaptive
        // thinking, which in practice collapses planning into reflexive repeat calls.
        ...(options.tools?.length
          ? {
            tools: options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
            tool_choice: { type: "auto" },
          }
          : {}),
        messages: conversation,
        // Always stream, even with no onToken subscriber. A non-streamed request sends no headers
        // until generation finishes, and undici gives up at 300s — which a long adaptive-thinking
        // reply routinely exceeds. Streaming returns headers immediately, so wall-clock stops
        // mattering; the deltas are simply accumulated when nobody is listening.
        stream: true,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    // Both corrections are learned once per model per process, so steady state is a single request.
    let response = await post();
    for (let attempt = 0; attempt < 2 && !response.ok; attempt += 1) {
      const err = await response.text();
      if (response.status !== 400) throw new Error(`Anthropic API error ${response.status}: ${err}`);
      const ceiling = MAX_TOKENS_CEILING.exec(err);
      if (ceiling) modelMaxTokens.set(model, Number(ceiling[1]));
      else if (/`?temperature`? is deprecated/i.test(err)) temperatureDeprecated.add(model);
      else throw new Error(`Anthropic API error 400: ${err}`);
      response = await post();
    }
    if (!response.ok) throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);

    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    // `input_tokens` counts only what missed the cache, so these two are the rest of the prompt —
    // without them a cached step looks like it sent almost nothing.
    let cacheWrite = 0;
    let cacheRead = 0;
    const toolCalls: LlmToolCall[] = [];

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let stopReason = "?";
      const blockTypes: string[] = [];
      // tool_use inputs stream as input_json_delta chunks per block index; the
      // accumulated string is complete JSON once the block stops.
      const toolBlocks = new Map<number, { id?: string; name: string; json: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data) as Record<string, unknown>;
            if (event.type === "content_block_delta") {
              // Only text_delta carries `text`; thinking_delta carries `thinking`, so thinking blocks
              // are skipped here exactly as the non-streamed path filters them out of `content`.
              const eventDelta = event.delta as Record<string, unknown> | undefined;
              const delta = eventDelta?.text as string | undefined;
              if (delta) {
                text += delta;
                options.onToken?.(delta);
              }
              const partialJson = eventDelta?.type === "input_json_delta" ? eventDelta.partial_json as string | undefined : undefined;
              const block = toolBlocks.get(event.index as number);
              if (partialJson !== undefined && block) block.json += partialJson;
            } else if (event.type === "content_block_start") {
              const contentBlock = event.content_block as Record<string, unknown> | undefined;
              const type = contentBlock?.type as string | undefined;
              if (type) blockTypes.push(type);
              if (type === "tool_use") {
                const id = contentBlock?.id as string | undefined;
                toolBlocks.set(event.index as number, { ...(id ? { id } : {}),
                  name: contentBlock?.name as string, json: "" });
              }
            } else if (event.type === "content_block_stop") {
              const block = toolBlocks.get(event.index as number);
              if (block) {
                toolCalls.push({ ...(block.id ? { id: block.id } : {}), name: block.name,
                  input: block.json.trim() === "" ? {} : JSON.parse(block.json) as JsonObject });
                toolBlocks.delete(event.index as number);
              }
            } else if (event.type === "message_start") {
              const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
              tokensIn = usage?.input_tokens ?? 0;
              cacheWrite = usage?.cache_creation_input_tokens ?? 0;
              cacheRead = usage?.cache_read_input_tokens ?? 0;
            } else if (event.type === "message_delta") {
              const usage = (event.usage as Record<string, number> | undefined);
              tokensOut = usage?.output_tokens ?? 0;
              const reason = (event.delta as Record<string, unknown>)?.stop_reason as string | undefined;
              if (reason) stopReason = reason;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
      if (text === "" && toolCalls.length === 0) {
        // Claude 5 thinks adaptively, and thinking blocks draw from the same max_tokens budget.
        // Callers parse `text` as JSON, so an all-thinking reply would surface as their own
        // "did not return JSON" — name the real cause here instead.
        throw new Error(`Anthropic returned no text block (model=${model} stop_reason=${stopReason} max_tokens=${modelMaxTokens.get(model) ?? REQUESTED_MAX_TOKENS} output_tokens=${tokensOut} blocks=[${blockTypes.join(",")}])`);
      }
    } else {
      const json = (await response.json()) as {
        content: Array<{ type: string; id?: string; text?: string; name?: string; input?: JsonObject }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number;
          cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
      };
      text = json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      for (const block of json.content) {
        if (block.type === "tool_use" && block.name) toolCalls.push({ ...(block.id ? { id: block.id } : {}),
          name: block.name, input: block.input ?? {} });
      }
      tokensIn = json.usage?.input_tokens ?? 0;
      tokensOut = json.usage?.output_tokens ?? 0;
      cacheWrite = json.usage?.cache_creation_input_tokens ?? 0;
      cacheRead = json.usage?.cache_read_input_tokens ?? 0;
      if (text === "" && toolCalls.length === 0) {
        // Claude 5 thinks adaptively, and thinking blocks draw from the same max_tokens budget.
        // Callers parse `text` as JSON, so an all-thinking reply would surface as their own
        // "did not return JSON" — name the real cause here instead.
        throw new Error(`Anthropic returned no text block (model=${model} stop_reason=${json.stop_reason ?? "?"} max_tokens=${modelMaxTokens.get(model) ?? REQUESTED_MAX_TOKENS} output_tokens=${tokensOut} blocks=[${json.content.map((b) => b.type).join(",")}])`);
      }
    }

    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      metrics: {
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cache_read: cacheRead,
        cache_write: cacheWrite,
        ms: Date.now() - start,
        model_class: options.modelClass,
        provider: this.name,
      },
    };
  }
}
