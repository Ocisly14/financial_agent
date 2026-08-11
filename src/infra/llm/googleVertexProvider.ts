import { createVertex } from "@ai-sdk/google-vertex";
import { generateText, jsonSchema, streamText, type CoreMessage, type CoreTool } from "ai";
import type {
  GenerateOptions,
  GenerateResult,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  ModelClass,
} from "./provider.ts";
import type { JsonObject } from "../../framework/types.ts";
import { googleApplicationCredentialsFromSetting } from "./googleVertexCredentials.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("llm");

// Resolve per-class model names. Honors both naming schemes: the reference
// repo's `*_GOOGLE_MODEL` / `GOOGLE_MODEL`, and this project's `LLM_MODEL_*`.
function resolveModel(googleVar: string, projectVar: string, fallback: string): string {
  return (
    process.env[googleVar] ||
    process.env["GOOGLE_MODEL"] ||
    process.env[projectVar] ||
    fallback
  );
}

const MODEL_MAP: Record<ModelClass, string> = {
  SMALL: resolveModel("SMALL_GOOGLE_MODEL", "LLM_MODEL_SMALL", "gemini-2.5-flash"),
  MEDIUM: resolveModel("MEDIUM_GOOGLE_MODEL", "LLM_MODEL_MEDIUM", "gemini-2.5-flash"),
  LARGE: resolveModel("LARGE_GOOGLE_MODEL", "LLM_MODEL_LARGE", "gemini-2.5-pro"),
};

/**
 * Gemini via Vertex AI, using `@ai-sdk/google-vertex` (Vercel AI SDK).
 *
 * Auth is service-account JSON only (Vertex), NOT a consumer API key. Set:
 *   GOOGLE_VERTEX_PROJECT             — GCP project ID
 *   GOOGLE_VERTEX_LOCATION            — e.g. `global` (default for Gemini access)
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON — entire service account JSON, one line
 */
export class GoogleVertexProvider implements LlmProvider {
  name = "google-vertex";
  private readonly vertex: ReturnType<typeof createVertex>;

  constructor() {
    const project = process.env["GOOGLE_VERTEX_PROJECT"] ?? "";
    const location = process.env["GOOGLE_VERTEX_LOCATION"] ?? "global";
    const host =
      location === "global"
        ? "aiplatform.googleapis.com"
        : `${location}-aiplatform.googleapis.com`;

    this.vertex = createVertex({
      project,
      location,
      baseURL: `https://${host}/v1/projects/${project}/locations/${location}/publishers/google`,
      googleAuthOptions: {
        credentials: googleApplicationCredentialsFromSetting(
          process.env["GOOGLE_APPLICATION_CREDENTIALS_JSON"],
        ),
      },
    });
  }

  async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
    const start = Date.now();
    const model = MODEL_MAP[options.modelClass] ?? MODEL_MAP.MEDIUM;

    // Split system out; the AI SDK takes it as a top-level `system` string.
    const systemPrompt = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const coreMessages: CoreMessage[] = [];
    for (const m of messages.filter((entry) => entry.role !== "system")) {
      // Gemini knows user/assistant. Map tool → user input. Consecutive
      // same-role messages (e.g. a cacheable prefix split) merge into one turn.
      const role = m.role === "assistant" ? "assistant" as const : "user" as const;
      const last = coreMessages[coreMessages.length - 1];
      if (last && last.role === role && typeof last.content === "string") {
        last.content = `${last.content}\n\n${m.content}`;
      } else {
        coreMessages.push({ role, content: m.content });
      }
    }

    const streaming = typeof options.onToken === "function";

    // Native function calling via ai-sdk: schema-constrained tool args. toolChoice
    // "auto", not "required": forcing a call suppresses the model's reasoning and
    // collapses planning into reflexive repeat calls.
    const toolParams = options.tools?.length
      ? {
        tools: Object.fromEntries(options.tools.map((t): [string, CoreTool] => [
          t.name, { description: t.description, parameters: jsonSchema(t.inputSchema) },
        ])),
        toolChoice: "auto" as const,
      }
      : {};

    if (streaming) {
      log.debug(`Google Vertex STREAMING model=${model}`);
      const result = streamText({
        model: this.vertex(model),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: coreMessages,
        temperature: options.temperature ?? 0.2,
        ...(options.signal ? { abortSignal: options.signal } : {}),
        ...toolParams,
      });

      let text = "";
      for await (const delta of result.textStream) {
        text += delta;
        options.onToken!(delta);
      }
      const usage = await result.usage;
      const calls = (await result.toolCalls).map((c): LlmToolCall => ({ name: c.toolName, input: c.args as JsonObject }));

      return this.toResult(text, calls, usage, options, start);
    }

    log.debug(`Google Vertex model=${model}`);
    const result = await generateText({
      model: this.vertex(model),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: coreMessages,
      temperature: options.temperature ?? 0.2,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      ...toolParams,
    });

    const calls = result.toolCalls.map((c): LlmToolCall => ({ name: c.toolName, input: c.args as JsonObject }));
    return this.toResult(result.text, calls, result.usage, options, start);
  }

  private toResult(
    text: string,
    toolCalls: LlmToolCall[],
    usage: { promptTokens?: number; completionTokens?: number } | undefined,
    options: GenerateOptions,
    start: number,
  ): GenerateResult {
    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      metrics: {
        tokens_in: usage?.promptTokens ?? 0,
        tokens_out: usage?.completionTokens ?? 0,
        ms: Date.now() - start,
        model_class: options.modelClass,
        provider: this.name,
      },
    };
  }
}
