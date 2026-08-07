// Shared plumbing for the three-step e2e test (step1-extract → step2-unify → step3-spine).
// Every step writes its artifact to the same directory so each output can be checked
// by hand before the next step consumes it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const symbol = (process.env["E2E_SYMBOL"]?.trim() || process.argv[2]?.trim() || "AAPL").toUpperCase();
export const outputDirectory = resolve(process.env["E2E_OUTPUT_DIR"]?.trim() || join("data", "e2e-test", symbol.toLowerCase()));

export function writeStep(name: string, value: unknown): string {
  mkdirSync(outputDirectory, { recursive: true });
  const path = join(outputDirectory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

export function readStep<T>(name: string): T {
  const path = join(outputDirectory, name);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new Error(`cannot read ${path} — run the previous step first`);
  }
}
