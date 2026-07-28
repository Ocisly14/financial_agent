import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

let tmpCounter = 0;

/** Read JSON; return `fallback` if the file does not exist. Other errors propagate. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/** Atomically write JSON: write a temp file then rename over the target. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

/** Append one JSON line to a .jsonl file (creating dirs/file as needed). */
export async function appendJsonl(path: string, entry: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Read all JSON lines from a .jsonl file; empty array if the file is missing. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
