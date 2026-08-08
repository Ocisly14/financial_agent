import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import type { LoopTool } from "../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import { loadWorkingSet } from "./loadWorkingSet.ts";
import { createLogger } from "../../infra/logger/logger.ts";
import { correctionInstruction, dimensionBreakdownsInstruction, schemaCorrectionInstruction,
  statementUnificationCorrectionPrompt, statementUnificationEnvelope } from "../prompts/dcfSubagentPrompts.ts";
import type { JsonSchema, JsonValue } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { Period } from "../../financial-model/types.ts";
import { buildConceptInventory } from "../../infra/xbrl/conceptInventory.ts";
import { materializeBreakdowns } from "../../infra/xbrl/dimensionInventory.ts";
import { applyUnificationPatch, buildUnifiedStatements, checkUnificationCompleteness,
  type UnificationDecision, type UnificationPatch, type UnifiedStatementsArtifact } from "../../infra/xbrl/unifiedStatements.ts";
import type { PresentationExtract } from "../../infra/xbrl/types.ts";
import type { FilingTable } from "../../infra/xbrl/tableTypes.ts";
import { exploreDimensions } from "./dimensionExploration.ts";

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

const ROW: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rowId", "statement", "label", "components", "rationale"],
  properties: { rowId: { type: "string" }, statement: { type: "string" }, label: { type: "string" },
    components: { type: "array", items: COMPONENT }, perYearOverrides: { type: "array", items: OVERRIDE },
    breakdowns: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["axisQName", "conceptQName", "rationale"],
      properties: { axisQName: { type: "string" }, conceptQName: { type: "string" }, rationale: { type: "string" },
        members: { type: "array", items: { type: "object", additionalProperties: false, required: ["memberQName"],
          properties: { memberQName: { type: "string" }, parentMemberQName: { type: "string" } } } } } } },
    rationale: { type: "string" } } };

const DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["rows"], properties: {
  rows: { type: "array", items: ROW },
  excluded: HELD_OUT({}, []),
  supplemental: HELD_OUT({ label: { type: "string" } }, ["label"]),
  notes: { type: "string" },
} };

const PATCH_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: [], properties: {
  upsertRows: { type: "array", items: ROW },
  deleteRowIds: { type: "array", items: { type: "string" } },
  excluded: HELD_OUT({}, []),
  supplemental: HELD_OUT({ label: { type: "string" } }, ["label"]),
  notes: { type: "string" },
} };

export type StatementUnificationRun = {
  decision: UnificationDecision;
  /** The subagent's own short account of what it did, for the DCF orchestrator. */
  notes: string;
  /** Stage ②/③ output; `unresolvedFindings` filled by this loop. Empty on a clean run, never silently empty on a dirty one. */
  artifact: UnifiedStatementsArtifact;
};

export async function runStatementUnificationAgent(input: {
  modelRouter: ModelRouter;
  /** The registry definition's prompt: new DcfSubagentRegistry().get("statement_unification").prompt. */
  systemPrompt: string;
  /** The orchestrator's instruction. Names the ticker the subagent loads through its tool. */
  task: string;
  /** From createStatementUnificationTools: the subagent's initialization tool. */
  tools: Map<string, LoopTool>;
  filings: readonly PresentationExtract[];
  requestedPeriods: readonly Period[];
  /** Segment/dimension tables for the same filings; enables the exploration phase and breakdown materialization. */
  tables?: readonly FilingTable[];
  /** Initial run + findings-driven re-runs. Spec §3: 3 (initial + 2). */
  maxRuns?: number;
}): Promise<StatementUnificationRun> {
  // The subagent asks for its own working set. What comes back is the store's inventory; the copy
  // below is the same build over the same extracts, kept so the host can verify the decision against
  // an inventory the subagent had no hand in producing.
  await loadWorkingSet({ modelRouter: input.modelRouter, subagent: "statement_unification",
    systemPrompt: input.systemPrompt, task: input.task, tools: input.tools });
  const tables = input.tables ?? [];
  const digest = input.tools.has("list_dimension_axes") && tables.length > 0
    ? (await exploreDimensions({ modelRouter: input.modelRouter, subagent: "statement_unification",
        systemPrompt: input.systemPrompt, task: input.task, tools: input.tools })).digest
    : "";
  const inventory = buildConceptInventory({ filings: input.filings, requestedPeriods: input.requestedPeriods });
  const maxRuns = input.maxRuns ?? 3;
  let findings: string[] = [];
  let last: StatementUnificationRun | undefined;

  let decision: UnificationDecision | undefined;
  for (let run = 1; run <= maxRuns; run += 1) {
    // First run states the whole decision; later runs only correct it. A hundred-row decision costs
    // minutes to regenerate and drifts between runs, while the fix for a handful of findings is a
    // few rows long.
    decision = decision === undefined
      ? await requestDecision(input.modelRouter, input.systemPrompt, inventory, input.requestedPeriods, digest)
      : applyUnificationPatch(decision,
        await requestPatch(input.modelRouter, input.systemPrompt, inventory, input.requestedPeriods, decision, findings, digest));
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
    const bd = materializeBreakdowns({ decision, tables, requestedPeriods: input.requestedPeriods,
      parentValues: Object.fromEntries(artifact.rows.map((row) => [row.rowId, row.values])) });
    if (bd.findings.length > 0) logFindings(`run ${run}/${maxRuns} breakdowns`, bd.findings);
    findings = [...completeness, ...artifact.findings, ...bd.findings];
    last = { decision, notes: decision.notes ?? "",
      artifact: { ...artifact, breakdownRows: bd.breakdownRows, unresolvedFindings: findings } };
    if (findings.length === 0) {
      log.info(`run ${run}/${maxRuns}: clean`);
      return last;
    }
  }
  if (!last) throw new Error(`statement_unification completeness check failed on all ${maxRuns} runs:\n${findings.join("\n")}`);
  return last;
}

const context = (inventory: unknown, requestedPeriods: readonly Period[], digest: string) =>
  `[REQUESTED PERIODS]\n${JSON.stringify(requestedPeriods.map((p) => p.id))}\n\n[CONCEPT INVENTORY]\n${JSON.stringify(inventory)}`
  + (digest.length > 0 ? `\n\n[DIMENSION BREAKDOWNS EXPLORED]\n${digest}` : "");

// The DIMENSION BREAKDOWNS paragraph tells the model it explored the issuer's axes and that the
// digest is available to read — true only when exploration actually ran (same condition `context`
// uses for the digest itself). Appending it unconditionally would claim exploration happened when
// there was no tableStore, and the model's `breakdowns` declarations would then find no facts.
const withDimensionInstruction = (systemPrompt: string, digest: string): string =>
  digest.length > 0 ? `${systemPrompt}\n\n${dimensionBreakdownsInstruction}` : systemPrompt;

function requestDecision(modelRouter: ModelRouter, systemPrompt: string, inventory: unknown,
  requestedPeriods: readonly Period[], digest: string): Promise<UnificationDecision> {
  return request(modelRouter, DECISION_SCHEMA, [
    { role: "system", content: `${withDimensionInstruction(systemPrompt, digest)}\n\n${statementUnificationEnvelope}` },
    { role: "user", content: context(inventory, requestedPeriods, digest) },
  ]);
}

function requestPatch(modelRouter: ModelRouter, systemPrompt: string, inventory: unknown,
  requestedPeriods: readonly Period[], previous: UnificationDecision,
  findings: readonly string[], digest: string): Promise<UnificationPatch> {
  return request(modelRouter, PATCH_SCHEMA, [
    { role: "system", content: `${withDimensionInstruction(systemPrompt, digest)}\n\n${statementUnificationCorrectionPrompt}` },
    { role: "user", content: `${context(inventory, requestedPeriods, digest)}

[YOUR PREVIOUS DECISION]
${JSON.stringify(previous)}

[FINDINGS AGAINST IT]
${findings.join("\n")}

${correctionInstruction}` },
  ]);
}

async function request<T>(modelRouter: ModelRouter, schema: JsonSchema, messages: LlmMessage[]): Promise<T> {
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
      validate(parsed, schema, "$", true);
      return parsed as T;
    } catch (validationError) {
      const detail = validationError instanceof Error ? validationError.message : String(validationError);
      log.warn(`decision rejected (${completion.metrics.tokens_out} output tokens, retry=${schemaRetried}): ${detail}`);
      if (schemaRetried) throw validationError;
      schemaRetried = true;
      messages.push({ role: "assistant", content: completion.text });
      messages.push({ role: "user", content: `[VALIDATION ERROR]\n${validationError instanceof Error ? validationError.message : String(validationError)}\n\n${schemaCorrectionInstruction}` });
    }
  }
}
