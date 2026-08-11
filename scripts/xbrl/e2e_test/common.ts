import type { LoopTool } from "../../../mcp_tools/financial-model/mappingSubagentTools.ts";
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

/**
 * The mapping subagents load their working set through a tool rather than being handed it. These
 * scripts run the agents against fixture files instead of the store, so the tool is stubbed to return
 * what the previous step wrote — the agent still spends its load turn, which is the point: what these
 * scripts exercise is the same code path production takes.
 */
export function fileLoader(toolName: string, payload: unknown): Map<string, LoopTool> {
  const tool: LoopTool = {
    name: toolName, category: "non_trading",
    description: `Load the working set ${toolName.replace("load_", "").replace(/_/g, " ")} for one ticker.`,
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    execute: (input) => {
      console.log(`  [load] ${toolName}(${JSON.stringify(input)})`);
      return payload as never;
    },
  };
  return new Map([[tool.name, tool]]);
}
