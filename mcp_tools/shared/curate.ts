import type { JsonObject, JsonValue } from "../../src/framework/types.ts";

/**
 * Reduce an array of raw records (exchange orders/fills, whale positions, token
 * rows, …) to a small curated set for generation_context.data: keep only the
 * whitelisted keys that are present, capped to `cap` items. The full raw array
 * should be persisted to the local cache separately — never handed to the model.
 */
export function curateRecords(records: unknown[], keys: string[], cap: number): JsonObject[] {
  return records.slice(0, cap).map((record) => {
    const out: JsonObject = {};
    if (record && typeof record === "object") {
      for (const key of keys) {
        const value = (record as Record<string, unknown>)[key];
        if (value !== undefined) out[key] = value as JsonValue;
      }
    }
    return out;
  });
}
