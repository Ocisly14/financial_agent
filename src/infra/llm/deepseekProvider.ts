import { MalformedResponseError, resolveModelMap, type LlmMessage, type LlmProvider, type LlmToolCall, type GenerateOptions, type GenerateResult, type ModelClass } from "./provider.ts";
import type { JsonObject } from "../../framework/types.ts";

// Override with DEEPSEEK_MODEL_{SMALL,MEDIUM,LARGE}. DeepSeek serves two models,
// deepseek-v4-flash and deepseek-v4-pro, both with a 1M context and both able to run with
// or without thinking. Flash covers every class by default; point LARGE at pro to spend
// more on the orchestrator and synthesis turns.
const DEFAULT_MODELS = {
  SMALL: "deepseek-v4-flash",
  MEDIUM: "deepseek-v4-flash",
  LARGE: "deepseek-v4-flash",
} as const;

type DeepSeekMessage = { role: "system" | "user" | "assistant"; content: string };

type ToolCallDelta = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type StreamChunk = {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * DeepSeek provider over its OpenAI-compatible chat completions API.
 *
 * Prompt caching is automatic and server-side (no request-side breakpoints), so the
 * `cache` flag on LlmMessage is deliberately ignored here.
 *
 * Thinking is on by DeepSeek's own default and stays that way: it costs latency and
 * tokens but leaves tool calling intact, and the reasoning stream is dropped rather
 * than surfaced (see the delta handling below).
 */
export class DeepSeekProvider implements LlmProvider {
  name = "deepseek";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly models: Record<ModelClass, string>;
  private readonly thinking: string | undefined;
  private readonly reasoningEffort: string | undefined;
  private readonly maxTokens: number;

  constructor(apiKey: string, baseUrl = "https://api.deepseek.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.models = resolveModelMap(DEFAULT_MODELS, ["DEEPSEEK"]);
    // Unset means "whatever DeepSeek defaults to" (currently enabled), so the field is
    // omitted entirely rather than pinned to a value that could drift from their default.
    this.thinking = process.env["DEEPSEEK_THINKING"] || undefined;
    // low | medium | high. Unset leaves the field off entirely, taking DeepSeek's default.
    // Only meaningful while thinking is on; it shortens the reasoning pass, which on a
    // multi-turn tool loop is re-derived from scratch every turn and dominates wall-clock.
    this.reasoningEffort = process.env["DEEPSEEK_REASONING_EFFORT"] || undefined;
    // Thinking tokens draw from the same budget as the reply, so a tight cap yields a
    // reply that is all reasoning and no content. The models allow up to 384K output;
    // 64K leaves ample room for a long JSON plan without inviting a runaway.
    this.maxTokens = Number(process.env["DEEPSEEK_MAX_TOKENS"] || 64_000);
  }

  async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const start = Date.now();
    const model = this.models[options.modelClass] ?? this.models.MEDIUM;

    // The OpenAI schema reserves `tool` for replies carrying a tool_call_id. Our tool
    // results are plain transcript text, so they are presented as user turns — the same
    // mapping the Anthropic and Google providers use.
    const conversation: DeepSeekMessage[] = messages.map((message) => ({
      role: message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: conversation,
        max_tokens: this.maxTokens,
        temperature: options.temperature ?? 0.2,
        ...(this.thinking ? { thinking: { type: this.thinking } } : {}),
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        // Native function calling: the schema constrains decoding, so tool inputs arrive as
        // guaranteed-parseable JSON. tool_choice stays "auto", never "required": forcing a
        // call collapses planning into reflexive repeat calls.
        ...(options.tools?.length
          ? {
            tools: options.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
            tool_choice: "auto",
          }
          : {}),
        // Always stream, even with no onToken subscriber. A non-streamed request sends no
        // headers until generation finishes, and undici gives up at 300s — which a long
        // reply routinely exceeds. Deltas are simply accumulated when nobody is listening.
        stream: true,
        // Usage is omitted from a stream unless asked for; it arrives on the final chunk.
        stream_options: { include_usage: true },
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error ${response.status}: ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error(`DeepSeek returned no response body (model=${model})`);
    }

    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let finishReason = "?";
    let droppedFrames = 0;
    // Arguments stream as fragments keyed by the call's position in the reply; the
    // accumulated string is complete JSON only once the stream ends.
    const toolBlocks = new Map<number, { name: string; args: string }>();

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
          const chunk = JSON.parse(data) as StreamChunk;
          const choice = chunk.choices?.[0];
          // Only `content` is read: thinking arrives as `reasoning_content` on the same
          // delta and is dropped, so it never reaches onToken or the parsed reply.
          const delta = choice?.delta?.content;
          if (delta) {
            text += delta;
            options.onToken?.(delta);
          }
          for (const call of choice?.delta?.tool_calls ?? []) {
            const block = toolBlocks.get(call.index) ?? { name: "", args: "" };
            if (call.function?.name) block.name = call.function.name;
            if (call.function?.arguments) block.args += call.function.arguments;
            toolBlocks.set(call.index, block);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            tokensIn = chunk.usage.prompt_tokens ?? tokensIn;
            tokensOut = chunk.usage.completion_tokens ?? tokensOut;
          }
        } catch {
          // A frame we cannot read is not harmless: if it carried a tool-argument fragment,
          // the accumulated string loses those bytes and only fails much later, as a JSON
          // syntax error at an offset that points at perfectly good text. Count them so the
          // failure below can name this as the cause instead of blaming the model.
          droppedFrames += 1;
        }
      }
    }

    const toolCalls: LlmToolCall[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => ({
        name: block.name,
        input: parseToolArguments(block, { model, finishReason, droppedFrames, tokensOut, maxTokens: this.maxTokens }),
      }));

    if (text === "" && toolCalls.length === 0) {
      // Callers parse `text` as JSON, so an empty reply would otherwise surface as their own
      // "did not return JSON" — name the real cause here instead. An empty reply that did not
      // hit the cap is a bad draw and worth re-drawing; one that did is the cap, and resending
      // buys another cap-length generation with the same ending.
      throw new MalformedResponseError(
        `DeepSeek returned no content (model=${model} finish_reason=${finishReason}`
        + ` max_tokens=${this.maxTokens} output_tokens=${tokensOut} dropped_frames=${droppedFrames})`,
        { retryable: finishReason !== "length" });
    }

    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      metrics: {
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        ms: Date.now() - start,
        model_class: options.modelClass,
        provider: this.name,
      },
    };
  }
}

/**
 * Turns one tool call's accumulated argument string into its object, or fails with an error
 * that says what actually went wrong.
 *
 * `JSON.parse` alone reports "Expected double-quoted property name at position 1854", which
 * names neither the tool, nor the stream, nor the two ways this string gets damaged — a frame
 * dropped mid-argument, or the reply cut off at the output cap. Both look identical at the
 * parse site and want opposite responses, so the diagnosis is assembled here where the stream
 * state is still in scope, and the retry decision is handed to the router as a flag.
 */
function parseToolArguments(
  block: { name: string; args: string },
  stream: { model: string; finishReason: string; droppedFrames: number; tokensOut: number; maxTokens: number },
): JsonObject {
  if (block.args.trim() === "") return {};
  try {
    return JSON.parse(block.args) as JsonObject;
  } catch (error) {
    const truncated = stream.finishReason === "length";
    const at = Number(/position (\d+)/.exec(String((error as Error).message))?.[1] ?? NaN);
    // The bytes around the offset are the one piece a reader cannot reconstruct from the log,
    // and the offset alone sends them looking at the wrong part of a 40KB argument string.
    const near = Number.isFinite(at)
      ? ` near ${JSON.stringify(block.args.slice(Math.max(0, at - 60), at + 60))}`
      : "";
    throw new MalformedResponseError(
      `DeepSeek returned unparseable arguments for tool "${block.name}"`
      + ` (${(error as Error).message}; model=${stream.model} finish_reason=${stream.finishReason}`
      + ` arg_chars=${block.args.length} dropped_frames=${stream.droppedFrames}`
      + ` output_tokens=${stream.tokensOut} max_tokens=${stream.maxTokens})${near}`,
      { retryable: !truncated, cause: error });
  }
}
