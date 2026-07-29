import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Local disk cache for raw exchange order/fill payloads. These raw arrays must NOT
 * flow into `generation_context` — they bloat the agent context and the
 * generating model never references them point-by-point. Tools curate a small
 * subset for `generation_context.data` and persist the full payload here for
 * debugging and offline inspection.
 *
 * Best-effort: cache failures never break a tool. Dir is `RAW_DATA_CACHE_DIR`
 * (default `./cache/raw`), one JSON file per `<namespace>/<key>.json`.
 */
const CACHE_ROOT = resolve(process.env["RAW_DATA_CACHE_DIR"] ?? "./cache/raw");

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200) || "entry";
}

/** Persist a raw payload. Returns the file path, or null if the write failed. */
export async function cacheRawData(namespace: string, key: string, data: unknown): Promise<string | null> {
  const dir = join(CACHE_ROOT, safeKey(namespace));
  const file = join(dir, `${safeKey(key)}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(data), "utf8");
    return file;
  } catch {
    return null;
  }
}
