import type { GenerationContext, JsonObject, JsonValue } from "../../src/framework/types.ts";
import type { SessionRegistry } from "../../src/framework/sessionState.ts";
import type { RegisteredTool } from "../toolRegistry.ts";

const EVENT_ID_MAX_LENGTH = 128;
const MAX_PATHS = 12;
const MAX_PATH_SEGMENTS = 8;
const MAX_RESULT_CHARS = 40_000;
const PATH_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)$/;

function failure(message: string) {
  return { summary: message, error: { code: "invalid_compacted_task_read", message } };
}

function readPaths(input: JsonObject): string[] | undefined {
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_PATHS) return undefined;
  const paths = input.paths.filter((path): path is string => typeof path === "string").map((path) => path.trim());
  if (paths.length !== input.paths.length || paths.some((path) => !path || path.split(".").length > MAX_PATH_SEGMENTS
    || path.split(".").some((segment) => !PATH_SEGMENT.test(segment)))) return undefined;
  return [...new Set(paths)];
}

function atPath(data: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = data;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index]!;
    } else if (current && typeof current === "object") {
      if (!(segment in current)) return undefined;
      current = current[segment]!;
    } else return undefined;
  }
  return current;
}

/** Reads exact facts only after an agent has deliberately selected a compacted
 * task-result index. It is session-scoped, so event ids cannot cross Topics. */
export function createReadCompactedTaskDataTool(sessions: Pick<SessionRegistry, "loadEvents">): RegisteredTool {
  return {
    name: "read_compacted_task_data",
    description: "Read exact fields from a prior compacted task result in this Topic. Use only a source_event_id shown in [DATA FROM EARLIER TASKS], and request narrow dot paths from its data_keys/data_shape (for example active_model_context.model_id).",
    category: "main",
    inputSchema: {
      type: "object",
      required: ["source_event_id", "paths"],
      properties: {
        source_event_id: { type: "string", description: "source_event_id from a compacted task-result index in this Topic." },
        paths: { type: "array", description: "1-12 exact dot paths to retrieve; narrow reads only.", items: { type: "string" } },
      },
    },
    execute: async (input, context) => {
      const eventId = typeof input.source_event_id === "string" ? input.source_event_id.trim() : "";
      const paths = readPaths(input);
      if (!eventId || eventId.length > EVENT_ID_MAX_LENGTH) return failure("source_event_id must be a non-empty event id.");
      if (!paths) return failure("paths must contain 1-12 valid dot paths.");

      const event = (await sessions.loadEvents(context.sessionId)).find(
        (candidate) => candidate.event_id === eventId && candidate.kind === "task_result",
      );
      const generation = event?.payload.generation_context as GenerationContext | undefined;
      if (!event || !generation?.data) return failure("No task result with generation data exists for that source_event_id in this Topic.");

      const values: JsonObject = {};
      const missing: string[] = [];
      for (const path of paths) {
        const value = atPath(generation.data, path);
        if (value === undefined) missing.push(path);
        else values[path] = value;
      }
      if (JSON.stringify(values).length > MAX_RESULT_CHARS) {
        return failure("Requested fields exceed the 40,000-character read budget; request more specific paths.");
      }
      return {
        summary: `Read ${Object.keys(values).length} exact field${Object.keys(values).length === 1 ? "" : "s"} from compacted task result.${missing.length ? ` ${missing.length} path${missing.length === 1 ? " was" : "s were"} not found.` : ""}`,
        generation_context: { data: { source_event_id: eventId, values, ...(missing.length ? { missing_paths: missing } : {}) } },
      };
    },
  };
}
