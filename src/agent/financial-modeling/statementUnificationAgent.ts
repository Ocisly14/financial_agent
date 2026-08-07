import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import { createLogger } from "../../infra/logger/logger.ts";
import type { JsonSchema, JsonValue } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { Period } from "../../financial-model/types.ts";
import { buildConceptInventory } from "../../infra/xbrl/conceptInventory.ts";
import { buildUnifiedStatements, checkUnificationCompleteness,
  type UnificationDecision, type UnifiedStatementsArtifact } from "../../infra/xbrl/unifiedStatements.ts";
import type { PresentationExtract } from "../../infra/xbrl/types.ts";

const log = createLogger("statement_unification");

// Findings run to hundreds of lines (one per inventory row per period), so a raw dump buries
// the signal. Bucket by finding kind, then show the first few of each.
const FINDING_KIND = /^(dangling|double-count|row "[^"]*" references|row "[^"]*" is)/;
const SAMPLE_PER_KIND = 3;

function logFindings(label: string, findings: readonly string[]): void {
  const byKind = new Map<string, string[]>();
  for (const finding of findings) {
    const kind = FINDING_KIND.exec(finding)?.[1]?.replace(/ "[^"]*"/, "") ?? "other";
    byKind.set(kind, [...(byKind.get(kind) ?? []), finding]);
  }
  const summary = [...byKind].map(([kind, list]) => `${kind}=${list.length}`).join(" ");
  log.info(`${label}: ${findings.length} findings (${summary})`);
  for (const [kind, list] of byKind) {
    for (const finding of list.slice(0, SAMPLE_PER_KIND)) log.info(`  [${kind}] ${finding}`);
    if (list.length > SAMPLE_PER_KIND) log.info(`  [${kind}] … ${list.length - SAMPLE_PER_KIND} more`);
  }
}

const COMPONENT: JsonSchema = { type: "object", additionalProperties: false, required: ["conceptQName", "weight"],
  properties: { conceptQName: { type: "string" },
    alsoTaggedAs: { type: "array", items: { type: "object", additionalProperties: false, required: ["conceptQName"],
      properties: { conceptQName: { type: "string" }, sign: { type: "number" } } } },
    dimensionSignature: { type: "string" }, openingBalance: { type: "boolean" }, weight: { type: "number" } } };

const OVERRIDE: JsonSchema = { type: "object", additionalProperties: false, required: ["periodId", "components", "reason"],
  properties: { periodId: { type: "string" }, components: { type: "array", items: COMPONENT }, reason: { type: "string" } } };

const HELD_OUT = (extra: Record<string, JsonSchema>, required: string[]): JsonSchema =>
  ({ type: "array", items: { type: "object", additionalProperties: false,
    required: ["conceptQName", "reason", ...required],
    properties: { conceptQName: { type: "string" }, dimensionSignature: { type: "string" },
      openingBalance: { type: "boolean" }, reason: { type: "string" }, ...extra } } });

const DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["rows"], properties: {
  rows: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["rowId", "statement", "label", "components", "rationale"],
    properties: { rowId: { type: "string" }, statement: { type: "string" }, label: { type: "string" },
      components: { type: "array", items: COMPONENT }, perYearOverrides: { type: "array", items: OVERRIDE },
      rationale: { type: "string" } } } },
  excluded: HELD_OUT({}, []),
  supplemental: HELD_OUT({ label: { type: "string" } }, ["label"]),
} };

export type StatementUnificationRun = {
  decision: UnificationDecision;
  /** Stage ②/③ output; `unresolvedFindings` filled by this loop. Empty on a clean run, never silently empty on a dirty one. */
  artifact: UnifiedStatementsArtifact;
};

export async function runStatementUnificationAgent(input: {
  modelRouter: ModelRouter;
  /** The registry definition's prompt: new DcfSubagentRegistry().get("statement_unification").prompt. */
  systemPrompt: string;
  filings: readonly PresentationExtract[];
  requestedPeriods: readonly Period[];
  /** Initial run + findings-driven re-runs. Spec §3: 3 (initial + 2). */
  maxRuns?: number;
}): Promise<StatementUnificationRun> {
  const inventory = buildConceptInventory({ filings: input.filings, requestedPeriods: input.requestedPeriods });
  const maxRuns = input.maxRuns ?? 3;
  let findings: string[] = [];
  let last: StatementUnificationRun | undefined;

  for (let run = 1; run <= maxRuns; run += 1) {
    const decision = await requestDecision(input.modelRouter, input.systemPrompt, inventory, input.requestedPeriods, findings);
    log.info(`run ${run}/${maxRuns}: decision has ${decision.rows.length} rows`);
    const completeness = checkUnificationCompleteness({ inventory, decision, requestedPeriods: input.requestedPeriods });
    if (completeness.length > 0) {
      logFindings(`run ${run}/${maxRuns} completeness`, completeness);
      findings = completeness;
      // Out of runs: ship the decision carrying its findings rather than discarding minutes of work.
      if (run < maxRuns) continue;
    }
    const artifact = buildUnifiedStatements({ decision, filings: input.filings, requestedPeriods: input.requestedPeriods, inventory });
    if (artifact.findings.length > 0) logFindings(`run ${run}/${maxRuns} build`, artifact.findings);
    findings = [...completeness, ...artifact.findings];
    last = { decision, artifact: { ...artifact, unresolvedFindings: findings } };
    if (findings.length === 0) {
      log.info(`run ${run}/${maxRuns}: clean`);
      return last;
    }
  }
  if (!last) throw new Error(`statement_unification completeness check failed on all ${maxRuns} runs:\n${findings.join("\n")}`);
  return last;
}

async function requestDecision(modelRouter: ModelRouter, systemPrompt: string, inventory: unknown,
  requestedPeriods: readonly Period[], priorFindings: readonly string[]): Promise<UnificationDecision> {
  const messages: LlmMessage[] = [
    { role: "system", content: `${systemPrompt}\n\nReturn EXACTLY one JSON object {"rows":[...]} and nothing else.` },
    { role: "user", content: `[REQUESTED PERIODS]\n${JSON.stringify(requestedPeriods.map((p) => p.id))}\n\n[CONCEPT INVENTORY]\n${JSON.stringify(inventory)}${priorFindings.length > 0 ? `\n\n[FINDINGS FROM PREVIOUS RUN]\n${priorFindings.join("\n")}\n\nFix every finding and re-emit the FULL decision.` : ""}` },
  ];
  let schemaRetried = false;
  for (;;) {
    let completion;
    try { completion = await modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "statement_unification" } }); }
    catch (firstError) {
      // Transient provider errors need spacing, not an instant retry.
      await new Promise((resolve) => setTimeout(resolve, 2_000 + Math.floor(Math.random() * 2_000)));
      try { completion = await modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "statement_unification", retry: "malformed_response" } }); }
      catch { throw firstError; }
    }
    const start = completion.text.indexOf("{"); const end = completion.text.lastIndexOf("}");
    try {
      if (start < 0 || end < start) throw new Error("statement_unification did not return JSON");
      const parsed = JSON.parse(completion.text.slice(start, end + 1)) as JsonValue;
      validate(parsed, DECISION_SCHEMA, "$", true);
      return parsed as UnificationDecision;
    } catch (validationError) {
      const detail = validationError instanceof Error ? validationError.message : String(validationError);
      log.warn(`decision rejected (${completion.metrics.tokens_out} output tokens, retry=${schemaRetried}): ${detail}`);
      if (schemaRetried) throw validationError;
      schemaRetried = true;
      messages.push({ role: "assistant", content: completion.text });
      messages.push({ role: "user", content: `[VALIDATION ERROR]\n${validationError instanceof Error ? validationError.message : String(validationError)}\n\nRe-emit the FULL corrected decision as one JSON object.` });
    }
  }
}
