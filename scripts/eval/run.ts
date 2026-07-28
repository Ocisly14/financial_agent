import { runTriggerEval } from "./evals/trigger.ts";
import { runRiskEval } from "./evals/risk.ts";
import { runInvariantsEval } from "./evals/invariants.ts";
import { renderReport } from "./lib/report.ts";

function main(): void {
  const results = [runRiskEval(), runTriggerEval(), runInvariantsEval()];
  const { text, exitCode } = renderReport(results);
  console.log("\n=== Trading Agent Eval Suite (deterministic) ===\n");
  console.log(text);
  process.exit(exitCode);
}

main();
