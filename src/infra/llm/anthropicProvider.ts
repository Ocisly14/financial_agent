import type { LlmMessage, LlmProvider, GenerateOptions, GenerateResult } from "./provider.ts";

const MODEL_MAP: Record<string, string> = {
  SMALL:  process.env["LLM_MODEL_SMALL"]  ?? "claude-haiku-4-5-20251001",
  MEDIUM: process.env["LLM_MODEL_MEDIUM"] ?? "claude-sonnet-4-6",
  LARGE:  process.env["LLM_MODEL_LARGE"]  ?? "claude-opus-4-8",
};

type AnthropicMessage = { role: "user" | "assistant"; content: string };

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

    const body = {
      model,
      max_tokens: 4096,
      temperature: options.temperature ?? 0.2,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: conversation,
      stream: options.onToken ? true : false,
    };

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;

    if (options.onToken && response.body) {
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
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data) as Record<string, unknown>;
            if (event.type === "content_block_delta") {
              const delta = (event.delta as Record<string, unknown>)?.text as string | undefined;
              if (delta) {
                text += delta;
                options.onToken(delta);
              }
            } else if (event.type === "message_start") {
              const usage = (event.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
              tokensIn = usage?.input_tokens ?? 0;
            } else if (event.type === "message_delta") {
              const usage = (event.usage as Record<string, number> | undefined);
              tokensOut = usage?.output_tokens ?? 0;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } else {
      const json = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      text = json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      tokensIn = json.usage?.input_tokens ?? 0;
      tokensOut = json.usage?.output_tokens ?? 0;
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
