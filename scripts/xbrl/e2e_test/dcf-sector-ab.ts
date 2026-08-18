// A/B over the sector playbooks: does `skills/dcf-modeling/references/sectors/*` change the DCF the
// agent builds, and is the change worth what it costs to read?
//
// The two arms differ in exactly one thing — the guidance the agent can reach:
//
//   with     the repo's skills tree, verbatim
//   without  a staged copy with references/sectors/ deleted and the two wiring passages that point
//            at it stripped out of dcf-modeling.md and 04-analysis-and-forecast.md
//
// Both arms are staged copies, so neither run is the repo itself and a crash leaves the repo clean.
// The control is built by exact-match removal and THROWS if a marker has moved: a control that
// silently kept the guidance would produce a null result that looks like a real one.
//
// ## Both arms start from the same committed model
//
// Stages 1-3 (extract the filings, unify the statements, map the spine) never read a sector
// playbook, so running them per arm would spend most of the budget on the part of the pipeline the
// experiment cannot affect — and would let two different mappings of the same issuer become the
// loudest difference between the arms. Instead every run RESUMES a seed model already at
// `history_committed`, copied fresh per arm so no arm can see another's mutations. What the arms
// actually exercise is stage 4 (decompose and forecast), 5 (WACC) and 6 (terminal and valuation) —
// exactly the stages the playbooks speak to.
//
// The seed is validated before anything is dispatched: wrong lifecycle, or a seed that already
// carries assumptions, and the script refuses to run rather than measuring a head start.
//
// AMZN is the default because it is the case the routing change was made for. Its reportable
// segments are geographic (North America, International) plus AWS — but the businesses inside them
// are retail, cloud and advertising, with completely different economics. Whether the "with" arm
// reaches past the reportable segments toward those economics, and whether it opens more than one
// playbook, is the question — not the assumption.
//
// Usage:
//   node --env-file=.env --experimental-strip-types --experimental-sqlite \
//     scripts/xbrl/e2e_test/dcf-sector-ab.ts [SYMBOL] [--repeats N] [--fresh] [--arm with|without]
//       [--seed-db PATH] [--seed-model fm_...] [--stage-only]
//
// Env: AB_SYMBOL, AB_REPEATS, AB_OUTPUT_DIR, AB_SEED_DB, AB_SEED_MODEL, plus what dcf-agent-e2e.ts reads.
//
// One run per arm is an anecdote, not a measurement — the agent is nondeterministic and a DCF has
// many defensible answers. --repeats runs each arm N times so the report can show whether a
// difference survives repetition. The report says which signals are mechanical (what was read, how
// many segment drivers exist) and which are judgment calls no script can score.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const symbol = (process.env["AB_SYMBOL"]?.trim() || positional[0]?.trim() || "AMZN").toUpperCase();
const repeats = Number(flag("repeats") ?? process.env["AB_REPEATS"] ?? 1);
const onlyArm = flag("arm");
const fresh = argv.includes("--fresh");
const repoRoot = resolve(import.meta.dirname, "../../..");
const outputRoot = resolve(process.env["AB_OUTPUT_DIR"]?.trim()
  || join(repoRoot, "data", "e2e-test", "dcf-sector-ab", symbol.toLowerCase()));

const seedDb = resolve(flag("seed-db") ?? (process.env["AB_SEED_DB"]?.trim()
  || join(repoRoot, "data", "e2e-test", "dcf-agent", "amzn-deepseek", "financial-models.sqlite")));
const seedModelId = flag("seed-model") ?? process.env["AB_SEED_MODEL"] ?? "fm_6b8f878d-7d04-49f6-87fa-c11f800f92cc";

if (fresh) rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

// ── the seed: one committed model both arms resume from ──────────────────────

/**
 * Refuse to run against a seed that would make the result meaningless. A seed past
 * `history_committed` has already done part of stage 4, and one carrying assumptions has made the
 * judgments the arms are supposed to make differently — either way both arms would inherit the same
 * head start and the experiment would measure whatever is left over.
 */
function validateSeed(): Record<string, unknown> {
  if (!existsSync(seedDb)) throw new Error(`seed database not found: ${seedDb} — pass --seed-db`);
  const db = new DatabaseSync(seedDb, { readOnly: true });
  try {
    const model = db.prepare("SELECT * FROM financial_models WHERE model_id = ?").get(seedModelId) as Record<string, unknown> | undefined;
    if (!model) throw new Error(`seed model ${seedModelId} not in ${seedDb} — pass --seed-model`);
    if (String(model["symbol"]).toUpperCase() !== symbol) {
      throw new Error(`seed model is ${model["symbol"]}, but this run is for ${symbol} — pass a matching --seed-db/--seed-model`);
    }
    const latest = db.prepare(
      "SELECT revision, lifecycle_stage, snapshot_json FROM financial_model_revisions WHERE model_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(seedModelId) as Record<string, unknown>;
    const stage = String(latest["lifecycle_stage"]);
    if (stage !== "history_committed") {
      throw new Error(`seed's latest revision ${latest["revision"]} is "${stage}", not "history_committed" — `
        + `the arms must both start where stage 4 starts, or the experiment measures a head start`);
    }
    const snapshot = JSON.parse(String(latest["snapshot_json"])) as Record<string, unknown>;
    const assumptions = (snapshot["assumptions"] as unknown[] | undefined) ?? [];
    if (assumptions.length > 0) {
      throw new Error(`seed already carries ${assumptions.length} assumption(s) — stage 4's judgments are what the arms differ on, so the seed must have none`);
    }
    const lineItems = (snapshot["lineItems"] as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      seedDb, seedModelId, ownerAgentId: model["owner_agent_id"], revision: latest["revision"], stage,
      lineItemCount: lineItems.length,
      revenueRows: lineItems.map((i) => String(i["id"])).filter((id) => id.startsWith("revenue.")).sort(),
    };
  } finally { db.close(); }
}

const seed = validateSeed();
console.log(`# seed: ${seedModelId} rev ${seed["revision"]} (${seed["stage"]}), `
  + `${seed["lineItemCount"]} line items, revenue rows: ${(seed["revenueRows"] as string[]).join(", ")}`);

// ── staging the two skill trees ──────────────────────────────────────────────

/** The passages that wire the sector playbooks in. Removing these IS the control arm. */
const WIRING = [
  {
    file: join("dcf-modeling", "dcf-modeling.md"),
    // The whole sector block: from its opening sentence up to the line that follows it.
    from: "One more playbook rides alongside stage 4: the sector's.",
    to: "Resuming an existing model: read get_financial_model first",
  },
  {
    file: join("dcf-modeling", "references", "04-analysis-and-forecast.md"),
    from: "Read the sector playbook, or playbooks, the skill map routes this issuer to",
    to: "## Move 1 — decompose where profit comes from",
  },
];

function stageSkills(arm: "with" | "without"): string {
  const staged = join(outputRoot, `skills-${arm}`);
  rmSync(staged, { recursive: true, force: true });
  cpSync(join(repoRoot, "skills"), staged, { recursive: true });
  if (arm === "with") return staged;

  const sectors = join(staged, "dcf-modeling", "references", "sectors");
  if (!existsSync(sectors)) throw new Error(`control arm: ${sectors} is already missing — nothing to remove, so the two arms would be identical`);
  rmSync(sectors, { recursive: true, force: true });

  for (const { file, from, to } of WIRING) {
    const path = join(staged, file);
    const text = readFileSync(path, "utf8");
    const start = text.indexOf(from);
    const end = text.indexOf(to);
    // A moved marker means the control would still carry the guidance and the experiment would
    // quietly compare a tree against itself. Fail instead.
    if (start < 0) throw new Error(`control arm: marker not found in ${file}: "${from.slice(0, 60)}…" — update WIRING in this script`);
    if (end <= start) throw new Error(`control arm: end marker not found after start in ${file} — update WIRING in this script`);
    writeFileSync(path, text.slice(0, start) + text.slice(end), "utf8");
  }

  // Prove the removal actually took: no path into sectors/ may survive anywhere in the control tree.
  const leftovers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".md")) continue;
      if (readFileSync(full, "utf8").includes("sectors/")) leftovers.push(full.slice(staged.length + 1));
    }
  };
  walk(staged);
  if (leftovers.length) throw new Error(`control arm still references sectors/ in: ${leftovers.join(", ")}`);
  return staged;
}

// ── running one arm ──────────────────────────────────────────────────────────

function runArm(arm: "with" | "without", skillsDir: string, iteration: number): string {
  const dir = join(outputRoot, `${arm}-${iteration}`);
  // Own copy of the seed per run. Sharing one database would let the first arm's forecast become the
  // second arm's starting point — the two arms would stop being independent after the first mutation.
  // (--fresh is deliberately NOT passed to the child: it would delete the copy we just placed.)
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const armDb = join(dir, "financial-models.sqlite");
  copyFileSync(seedDb, armDb);

  console.log(`\n${"=".repeat(78)}\n# arm "${arm}" run ${iteration}/${repeats} → ${dir}`);
  console.log(`# resuming ${seedModelId} from rev ${seed["revision"]} (${seed["stage"]}) — stages 4-6 only\n${"=".repeat(78)}`);
  const result = spawnSync(process.execPath, [
    "--env-file=.env", "--experimental-strip-types", "--experimental-sqlite",
    join("scripts", "xbrl", "e2e_test", "dcf-agent-e2e.ts"), symbol,
  ], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      SKILLS_DIR: skillsDir,
      E2E_SYMBOL: symbol,
      E2E_AGENT_OUTPUT_DIR: dir,
      E2E_MODEL_DB_PATH: armDb,
      E2E_RESUME_MODEL_ID: seedModelId,
      // Stages 1-3 are already done, so the round budget only has to cover forecast, WACC and
      // valuation. A lower cap turns a stalled run into a result sooner instead of burning rounds.
      E2E_MAX_ROUNDS: process.env["E2E_MAX_ROUNDS"] ?? "3",
      // A distinct session per run: a shared thread would let the second arm resume the first one's
      // model and inherit exactly the reasoning this experiment is trying to isolate.
      E2E_SESSION_ID: `ab-${symbol.toLowerCase()}-${arm}-${iteration}`,
    },
  });
  // A failed arm is data, not a reason to abort: an agent that stalls short of `valued` in one arm
  // and not the other is itself a finding, and the artifacts are on disk either way.
  if (result.status !== 0) console.log(`\n! arm "${arm}" run ${iteration} exited ${result.status} — reading its artifacts anyway`);
  return dir;
}

// ── reading one run's artifacts into a comparable fingerprint ────────────────

type Json = Record<string, unknown>;
const readJson = (path: string): Json | null => {
  try { return JSON.parse(readFileSync(path, "utf8")) as Json; } catch { return null; }
};

function fingerprint(dir: string): Json {
  const summary = readJson(join(dir, "summary.json"));
  const snapshot = readJson(join(dir, "model", "final-snapshot.json"));

  // Which reference files the agent actually opened — the one signal that directly tests the
  // routing. The per-step files carry the tool input; index.jsonl does not.
  const referencesRead: string[] = [];
  const stepsDir = join(dir, "steps");
  if (existsSync(stepsDir)) {
    for (const name of readdirSync(stepsDir)) {
      if (!name.endsWith(".json") || !name.includes("read_skill_reference")) continue;
      const step = readJson(join(stepsDir, name));
      const path = (step?.["input"] as Json | undefined)?.["path"];
      if (typeof path === "string") referencesRead.push(path);
    }
  }
  const sectorPlaybooksRead = [...new Set(referencesRead.filter((p) => p.includes("sectors/")))].sort();

  const assumptions = (snapshot?.["assumptions"] as Array<Json> | undefined) ?? [];
  const lineItems = (snapshot?.["lineItems"] as Array<Json> | undefined) ?? [];
  const assumptionIds = assumptions.map((a) => String(a["lineItemId"])).sort();
  const valueOf = (id: string): unknown => {
    const found = assumptions.find((a) => a["lineItemId"] === id);
    const payload = found?.["payload"] as Json | undefined;
    return payload?.["kind"] === "values" ? payload["values"] : null;
  };

  // Did the forecast get built per segment, or as one blended chain? Counting drivers is a proxy —
  // it shows the chain's shape, not whether the judgments behind it were any good.
  const perStreamGrowth = assumptionIds.filter((id) => id.startsWith("growth.revenue.") && id !== "growth.revenue.total");
  const segmentMargins = assumptionIds.filter((id) => id.startsWith("gross_margin.") || id.startsWith("margin.") && id !== "margin.operating");
  const revenueRows = lineItems.filter((i) => String(i["id"]).startsWith("revenue.")).map((i) => String(i["id"])).sort();
  const customRows = lineItems.filter((i) => String(i["id"]).startsWith("metric.custom.")).map((i) => String(i["id"])).sort();

  const cost = (summary?.["cost"] ?? {}) as Record<string, Json>;
  let equivalentInputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const row of Object.values(cost)) {
    equivalentInputTokens += Number(row["equivalent_input_tokens"] ?? 0);
    cacheRead += Number(row["cache_read"] ?? 0);
    cacheWrite += Number(row["cache_write"] ?? 0);
  }

  const valuation = (summary?.["valuation"] ?? null) as Record<string, Json> | null;
  return {
    pass: summary?.["pass"] ?? null,
    lifecycle: summary?.["lifecycle"] ?? null,
    reason: summary?.["reason"] ?? null,
    rounds: Array.isArray(summary?.["rounds"]) ? (summary["rounds"] as unknown[]).length : null,
    toolCalls: summary?.["toolCalls"] ?? null,
    wacc: summary?.["wacc"] ?? null,
    perSharePerpetuity: valuation?.["perpetuityGrowth"]?.["impliedValuePerShare"] ?? null,
    perShareExit: valuation?.["exitMultiple"]?.["impliedValuePerShare"] ?? null,
    terminalGrowth: valueOf("terminal_growth"),
    exitMultiple: valueOf("exit_multiple"),
    sectorPlaybooksRead,
    sectorPlaybookCount: sectorPlaybooksRead.length,
    referencesReadCount: referencesRead.length,
    assumptionCount: assumptions.length,
    perStreamGrowthDrivers: perStreamGrowth,
    perStreamGrowthCount: perStreamGrowth.length,
    segmentMarginDrivers: segmentMargins,
    revenueRows,
    revenueRowCount: revenueRows.length,
    customRowCount: customRows.length,
    equivalentInputTokens,
    cacheReadWriteRatio: cacheWrite > 0 ? Number((cacheRead / cacheWrite).toFixed(2)) : null,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────

const arms: Array<"with" | "without"> = onlyArm === "with" ? ["with"]
  : onlyArm === "without" ? ["without"] : ["with", "without"];

const staged: Record<string, string> = {};
for (const arm of arms) {
  staged[arm] = stageSkills(arm);
  console.log(`# staged "${arm}" skills at ${staged[arm]}`);
}

// --stage-only builds and validates both trees without dispatching anything. Run it before spending
// a live run: every way this experiment can be silently wrong lives in the staging step.
if (argv.includes("--stage-only")) {
  for (const arm of arms) {
    const sectors = join(staged[arm]!, "dcf-modeling", "references", "sectors");
    const count = existsSync(sectors) ? readdirSync(sectors).length : 0;
    const map = readFileSync(join(staged[arm]!, "dcf-modeling", "dcf-modeling.md"), "utf8");
    console.log(`  ${arm.padEnd(8)} sectors/=${String(count).padEnd(3)} routing table in skill map=${map.includes("sectors/technology.md")}`);
  }
  console.log("\nstaging validated — rerun without --stage-only to dispatch");
  process.exit(0);
}

// Carry forward any runs a previous invocation already finished. A long A/B gets interrupted — a
// provider dies, a wrapper times out — and resuming with `--arm without` must not erase the arm that
// already completed. Keyed by arm+iteration so a deliberate re-run of the same cell replaces it.
const runs: Array<Json> = (() => {
  const previous = readJson(join(outputRoot, "comparison.json"));
  const kept = ((previous?.["runs"] as Array<Json> | undefined) ?? [])
    .filter((r) => !(arms.includes(r["arm"] as "with" | "without") && Number(r["iteration"]) <= repeats));
  if (kept.length) console.log(`# carrying forward ${kept.length} completed run(s) from a previous invocation`);
  return kept;
})();

for (let i = 1; i <= repeats; i++) {
  for (const arm of arms) {
    const dir = runArm(arm, staged[arm]!, i);
    runs.push({ arm, iteration: i, dir, ...fingerprint(dir) });
    // Written after every run, so a session killed halfway still leaves a readable comparison.
    writeFileSync(join(outputRoot, "comparison.json"),
      JSON.stringify({ symbol, repeats, arms, seed, runs, finishedAt: new Date().toISOString() }, null, 2), "utf8");
  }
}

// ── report ───────────────────────────────────────────────────────────────────

const cell = (v: unknown): string => v === null || v === undefined ? "-"
  : Array.isArray(v) ? (v.length ? v.join("<br>") : "-")
  : typeof v === "number" ? String(Number(v.toFixed(4)))
  : String(v);

const ROWS: Array<[string, string]> = [
  ["reached valued", "pass"],
  ["lifecycle", "lifecycle"],
  ["rounds", "rounds"],
  ["tool calls", "toolCalls"],
  ["sector playbooks read", "sectorPlaybooksRead"],
  ["reference reads (all)", "referencesReadCount"],
  ["revenue rows", "revenueRowCount"],
  ["per-stream growth drivers", "perStreamGrowthCount"],
  ["per-stream driver ids", "perStreamGrowthDrivers"],
  ["segment margin drivers", "segmentMarginDrivers"],
  ["assumptions", "assumptionCount"],
  ["custom analysis rows", "customRowCount"],
  ["WACC", "wacc"],
  ["terminal growth", "terminalGrowth"],
  ["exit multiple", "exitMultiple"],
  ["per share (perpetuity)", "perSharePerpetuity"],
  ["per share (exit)", "perShareExit"],
  ["equivalent input tokens", "equivalentInputTokens"],
  ["cache read/write ratio", "cacheReadWriteRatio"],
];

// Stable column order regardless of which arms this invocation actually ran.
runs.sort((a, b) => Number(a["iteration"]) - Number(b["iteration"])
  || String(a["arm"]).localeCompare(String(b["arm"])));

const header = runs.map((r) => `${r["arm"]} #${r["iteration"]}`);
const lines = [
  `# Sector playbooks A/B — ${symbol}`,
  "",
  `${repeats} run(s) per arm. The arms differ in one thing: whether \`references/sectors/\` and the two`,
  "passages pointing at it exist in the skills tree the agent reads.",
  "",
  `Both arms resume the same seed model \`${seedModelId}\` at revision ${seed["revision"]} (\`${seed["stage"]}\`,`,
  `${seed["lineItemCount"]} line items, no assumptions), each from its own copy. Extraction, unification and`,
  "spine mapping are therefore identical across arms and out of scope: what runs here is stage 4 (decompose",
  "and forecast), stage 5 (WACC) and stage 6 (terminal and valuation).",
  "",
  `Seed revenue rows: ${(seed["revenueRows"] as string[]).join(", ")}. A chain that ends with only these has`,
  "kept the reportable segments; one that adds rows has gone looking for the economics underneath them.",
  "",
  `| | ${header.join(" | ")} |`,
  `| --- | ${header.map(() => "---").join(" | ")} |`,
  ...ROWS.map(([label, key]) => `| ${label} | ${runs.map((r) => cell(r[key])).join(" | ")} |`),
  "",
  "## Reading this",
  "",
  "Mechanical, and safe to read as evidence: which playbooks were opened, how many revenue rows and",
  "per-stream drivers the chain ended up with, token cost, whether the run reached `valued`.",
  "",
  "Not mechanical, and NOT scored here: whether the assumptions are any good. A chain with more",
  "segment drivers is a differently shaped forecast, not a better one — read the rationales in",
  "`model/final-snapshot.json` and the step notes in `notes.jsonl` to judge that. Per-share values",
  "differing between arms is expected and on its own says nothing; two defensible DCFs of the same",
  "issuer routinely differ by more than this experiment's effect.",
  "",
  `With one run per arm this is an anecdote. Re-run with \`--repeats 3\` before believing any`,
  "difference that is not a hard structural one (a playbook read or not, a segment chain or not).",
  "",
];
writeFileSync(join(outputRoot, "comparison.md"), lines.join("\n"), "utf8");

console.log(`\n${lines.join("\n")}`);
console.log(`Artifacts: ${outputRoot}`);
