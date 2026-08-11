import type { LlmMessage, LlmProvider, LlmToolCall, GenerateOptions, GenerateResult } from "./provider.ts";
import type { JsonObject } from "../../framework/types.ts";

const MODEL_MAP: Record<string, string> = {
  SMALL:  process.env["LLM_MODEL_SMALL"]  ?? "gemini-2.5-flash",
  MEDIUM: process.env["LLM_MODEL_MEDIUM"] ?? "gemini-2.5-flash",
  LARGE:  process.env["LLM_MODEL_LARGE"]  ?? "gemini-2.5-pro",
};

type GeminiPart = { text?: string; functionCall?: { name: string; args?: JsonObject } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

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
      // Gemini only knows "user" and "model". Map assistant→model; everything
      // else (user, tool) is presented as user input. Consecutive same-role
      // messages (e.g. a cacheable prefix split) merge into one turn.
      const role = m.role === "assistant" ? "model" : "user";
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push({ text: m.content });
      else contents.push({ role, parts: [{ text: m.content }] });
    }

    const body = {
      contents,
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      // Native function calling: functionCall args arrive as schema-constrained,
      // guaranteed-parseable JSON. Mode AUTO, not ANY: forcing a call suppresses
      // the model's reasoning and collapses planning into reflexive repeat calls.
      ...(options.tools?.length
        ? {
          tools: [{ functionDeclarations: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        }
        : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: 4096,
      },
    };

    const streaming = Boolean(options.onToken);
    const method = streaming ? "streamGenerateContent" : "generateContent";
    const query = streaming ? "?alt=sse&key=" : "?key=";
    const url = `${this.baseUrl}/v1beta/models/${model}:${method}${query}${this.apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Google API error ${response.status}: ${err}`);
    }

    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
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
              if (part.functionCall) toolCalls.push({ name: part.functionCall.name, input: part.functionCall.args ?? {} });
            }
            if (event.usageMetadata) {
              tokensIn = event.usageMetadata.promptTokenCount ?? tokensIn;
              tokensOut = event.usageMetadata.candidatesTokenCount ?? tokensOut;
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
        if (part.functionCall) toolCalls.push({ name: part.functionCall.name, input: part.functionCall.args ?? {} });
      }
      tokensIn = json.usageMetadata?.promptTokenCount ?? 0;
      tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0;
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
