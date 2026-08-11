import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCase, scoreMultiCase, generateStrategyCall, type NlCase, type NlMultiCase } from "./evals/nlDsl.ts";
import { pct } from "./lib/metrics.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = 10;

function loadJsonl<T>(file: string): T[] {
  const text = readFileSync(join(DIR, "datasets", file), "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

/** Run fn over items with at most `limit` in flight; results stay in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function runSinglePhase(): Promise<void> {
  const cases = loadJsonl<NlCase>("nl-dsl.jsonl");
  const scored = await mapLimit(cases, CONCURRENCY, async (c) => ({ c, r: scoreCase(await generateStrategyCall(c.input), c.gold) }));

  let intentMatches = 0;
  let toolMatches = 0;
  const fieldTotals: Record<string, { ok: number; n: number }> = {};
  for (const { c, r } of scored) {
    if (r.intentMatch) intentMatches++;
    if (r.toolMatch) toolMatches++;
    for (const [k, ok] of Object.entries(r.fields)) {
      fieldTotals[k] ??= { ok: 0, n: 0 };
      fieldTotals[k].n++;
      if (ok) fieldTotals[k].ok++;
    }
    console.log(`${r.intentMatch ? "✔" : "✘"} ${c.id}: ${c.input}`);
  }
  const n = cases.length;
  console.log("\n=== ① NL→DSL fidelity — single-phase (configured LLM) ===");
  console.log(`① nl-dsl:   intent-match ${pct(intentMatches / n)} · tool-select ${pct(toolMatches / n)}  (n=${n})`);
  for (const [k, v] of Object.entries(fieldTotals)) {
    console.log(`   ${k}: ${pct(v.ok / v.n)}`);
  }
}

async function runMultiPhase(): Promise<void> {
  const cases = loadJsonl<NlMultiCase>("nl-dsl-multiphase.jsonl");
  const scored = await mapLimit(cases, CONCURRENCY, async (c) => ({ c, r: scoreMultiCase(await generateStrategyCall(c.input), c.gold) }));

  let intentMatches = 0;
  let toolMatches = 0;
  let phaseCountMatches = 0;
  let phasesMatched = 0;
  let phasesTotal = 0;
  let guardrailCases = 0;
  let guardrailHits = 0;
  for (const { c, r } of scored) {
    if (r.intentMatch) intentMatches++;
    if (r.toolMatch) toolMatches++;
    if (r.phaseCountMatch) phaseCountMatches++;
    phasesMatched += r.phasesMatched;
    phasesTotal += r.phasesTotal;
    if (c.gold.guardrails) { guardrailCases++; if (r.guardrailsMatch) guardrailHits++; }
    console.log(`${r.intentMatch ? "✔" : "✘"} ${c.id} (${r.phasesMatched}/${r.phasesTotal} phases): ${c.input}`);
  }
  const n = cases.length;
  console.log("\n=== ① NL→DSL fidelity — multi-phase (configured LLM) ===");
  console.log(`① multi:    intent-match ${pct(intentMatches / n)} · tool-select ${pct(toolMatches / n)}  (n=${n})`);
  console.log(`   phase-count-correct: ${pct(phaseCountMatches / n)}`);
  console.log(`   per-phase fidelity:  ${pct(phasesMatched / phasesTotal)} (${phasesMatched}/${phasesTotal} phases)`);
  console.log(`   guardrails correct:  ${guardrailCases === 0 ? "n/a" : pct(guardrailHits / guardrailCases)} (${guardrailHits}/${guardrailCases})`);
}

async function main(): Promise<void> {
  console.log(`Running NL→DSL eval with concurrency ${CONCURRENCY}...`);
  await runSinglePhase();
  await runMultiPhase();
}

main().catch((err) => { console.error(err); process.exit(1); });
