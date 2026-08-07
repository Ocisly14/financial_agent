import type { LlmMessage, LlmProvider, GenerateOptions, GenerateResult } from "./provider.ts";

// `||`, not `??`: a declared-but-empty LLM_MODEL_* in .env is an unset override, and `??`
// would forward "" as the model id.
const MODEL_MAP: Record<string, string> = {
  SMALL:  process.env["LLM_MODEL_SMALL"]  || "claude-haiku-4-5-20251001",
  MEDIUM: process.env["LLM_MODEL_MEDIUM"] || "claude-sonnet-5",
  LARGE:  process.env["LLM_MODEL_LARGE"]  || "claude-opus-5",
};

type AnthropicMessage = { role: "user" | "assistant"; content: string };

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
    const conversation: AnthropicMessage[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

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
        ...(systemMsg ? { system: systemMsg.content } : {}),
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

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let stopReason = "?";
      const blockTypes: string[] = [];

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
              const delta = (event.delta as Record<string, unknown>)?.text as string | undefined;
              if (delta) {
                text += delta;
                options.onToken?.(delta);
              }
            } else if (event.type === "content_block_start") {
              const type = (event.content_block as Record<string, unknown>)?.type as string | undefined;
              if (type) blockTypes.push(type);
            } else if (event.type === "message_start") {
              const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
              tokensIn = usage?.input_tokens ?? 0;
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
      if (text === "") {
        // Claude 5 thinks adaptively, and thinking blocks draw from the same max_tokens budget.
        // Callers parse `text` as JSON, so an all-thinking reply would surface as their own
        // "did not return JSON" — name the real cause here instead.
        throw new Error(`Anthropic returned no text block (model=${model} stop_reason=${stopReason} max_tokens=${modelMaxTokens.get(model) ?? REQUESTED_MAX_TOKENS} output_tokens=${tokensOut} blocks=[${blockTypes.join(",")}])`);
      }
    } else {
      const json = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      text = json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      tokensIn = json.usage?.input_tokens ?? 0;
      tokensOut = json.usage?.output_tokens ?? 0;
      if (text === "") {
        // Claude 5 thinks adaptively, and thinking blocks draw from the same max_tokens budget.
        // Callers parse `text` as JSON, so an all-thinking reply would surface as their own
        // "did not return JSON" — name the real cause here instead.
        throw new Error(`Anthropic returned no text block (model=${model} stop_reason=${json.stop_reason ?? "?"} max_tokens=${modelMaxTokens.get(model) ?? REQUESTED_MAX_TOKENS} output_tokens=${tokensOut} blocks=[${json.content.map((b) => b.type).join(",")}])`);
      }
    }

    return {
      text,
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
