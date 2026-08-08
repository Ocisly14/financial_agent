import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import type { JsonSchema, JsonValue } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { Fact } from "../../financial-model/types.ts";
import { CANONICAL_MAPPING_IDS, REQUIRED_MAPPING_IDS } from "../../financial-model/skeleton.ts";
import { correctionInstruction, schemaCorrectionInstruction, spineMappingCorrectionPrompt,
  spineMappingEnvelope } from "../prompts/dcfSubagentPrompts.ts";
import { applySpinePatch, buildSpineFromUnified, checkSpineCompleteness,
  type SpineDecision, type SpinePatch } from "../../infra/xbrl/spineFromUnified.ts";
import type { UnifiedStatementsArtifact } from "../../infra/xbrl/unifiedStatements.ts";

const MAPPING: JsonSchema = { type: "object", additionalProperties: false,
  required: ["targetId", "rowIds", "rationale"],
  properties: { targetId: { type: "string" }, rowIds: { type: "array", items: { type: "string" } },
    rationale: { type: "string" } } };
const DETAIL_ROW: JsonSchema = { type: "object", additionalProperties: false,
  required: ["parentTargetId", "rowId", "rationale"],
  properties: { parentTargetId: { type: "string" }, rowId: { type: "string" }, rationale: { type: "string" } } };
const EXCLUSION: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rowId", "reason"], properties: { rowId: { type: "string" }, reason: { type: "string" } } };
const SPINE_GAP: JsonSchema = { type: "object", additionalProperties: false,
  required: ["targetId", "reason"], properties: { targetId: { type: "string" }, reason: { type: "string" } } };
const idList: JsonSchema = { type: "array", items: { type: "string" } };

const DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["mappings", "detailRows", "excluded", "spineGaps"], properties: {
    mappings: { type: "array", items: MAPPING },
    detailRows: { type: "array", items: DETAIL_ROW },
    excluded: { type: "array", items: EXCLUSION },
    spineGaps: { type: "array", items: SPINE_GAP },
    notes: { type: "string" },
  } };

const PATCH_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: [], properties: {
  upsertMappings: { type: "array", items: MAPPING }, deleteMappingTargetIds: idList,
  upsertDetailRows: { type: "array", items: DETAIL_ROW }, deleteDetailRowIds: idList,
  upsertExcluded: { type: "array", items: EXCLUSION }, deleteExcludedRowIds: idList,
  upsertSpineGaps: { type: "array", items: SPINE_GAP }, deleteSpineGapTargetIds: idList,
  notes: { type: "string" },
} };

export type SpineMappingRun = {
  decision: SpineDecision;
  /** The subagent's own short account of what it did, for the DCF orchestrator. */
  notes: string;
  facts: Fact[];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  /** Findings the ≤maxRuns loop could not clear. Empty on a clean run. Never silently empty on a dirty one. */
  unresolvedFindings: string[];
};

export async function runSpineMappingAgent(input: {
  modelRouter: ModelRouter;
  /** The registry definition's prompt: new DcfSubagentRegistry().get("spine_mapping").prompt. */
  systemPrompt: string;
  unified: UnifiedStatementsArtifact;
  spineIds?: readonly string[];
  /** Initial run + findings-driven re-runs. Spec §5: 3 (initial + 2). */
  maxRuns?: number;
}): Promise<SpineMappingRun> {
  const spineIds: ReadonlySet<string> = new Set(input.spineIds ?? [...CANONICAL_MAPPING_IDS]);
  const requiredIds: ReadonlySet<string> = new Set([...REQUIRED_MAPPING_IDS].filter((id) => spineIds.has(id)));
  const maxRuns = input.maxRuns ?? 3;
  let findings: string[] = [];
  let last: SpineMappingRun | undefined;

  let decision: SpineDecision | undefined;
  for (let run = 1; run <= maxRuns; run += 1) {
    // First run states the whole mapping; later runs only correct it, against what they last decided.
    decision = decision === undefined
      ? await requestDecision(input.modelRouter, input.systemPrompt, input.unified, spineIds, requiredIds)
      : applySpinePatch(decision,
        await requestPatch(input.modelRouter, input.systemPrompt, input.unified, spineIds, requiredIds, decision, findings));
    const completeness = checkSpineCompleteness({ unified: input.unified, decision, spineIds, requiredIds });
    if (completeness.length > 0) {
      findings = completeness;
      // Out of runs: ship the mapping carrying its findings rather than discarding the work.
      if (run < maxRuns) continue;
    }
    const built = buildSpineFromUnified({ decision, unified: input.unified, spineIds, requiredIds });
    findings = [...completeness, ...built.findings];
    last = { decision, notes: decision.notes ?? "", facts: built.facts,
      coverageGaps: built.coverageGaps, unresolvedFindings: findings };
    if (findings.length === 0) return last;
  }
  if (!last) throw new Error(`spine_mapping completeness check failed on all ${maxRuns} runs:\n${findings.join("\n")}`);
  return last;
}

const context = (unified: UnifiedStatementsArtifact, spineIds: ReadonlySet<string>, requiredIds: ReadonlySet<string>) =>
  `[REQUIRED SPINE IDS]\n${JSON.stringify([...requiredIds])}\n\n[OPTIONAL SPINE IDS]\n${JSON.stringify([...spineIds].filter((id) => !requiredIds.has(id)))}\n\n[UNIFIED STATEMENTS]\n${JSON.stringify({ rows: unified.rows, periods: unified.periods })}`;

function requestDecision(modelRouter: ModelRouter, systemPrompt: string, unified: UnifiedStatementsArtifact,
  spineIds: ReadonlySet<string>, requiredIds: ReadonlySet<string>): Promise<SpineDecision> {
  return request(modelRouter, DECISION_SCHEMA, [
    { role: "system", content: `${systemPrompt}\n\n${spineMappingEnvelope}` },
    { role: "user", content: context(unified, spineIds, requiredIds) },
  ]);
}

function requestPatch(modelRouter: ModelRouter, systemPrompt: string, unified: UnifiedStatementsArtifact,
  spineIds: ReadonlySet<string>, requiredIds: ReadonlySet<string>, previous: SpineDecision,
  findings: readonly string[]): Promise<SpinePatch> {
  return request(modelRouter, PATCH_SCHEMA, [
    { role: "system", content: `${systemPrompt}\n\n${spineMappingCorrectionPrompt}` },
    { role: "user", content: `${context(unified, spineIds, requiredIds)}

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
    try { completion = await modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "spine_mapping" } }); }
    catch (firstError) {
      // Transient provider errors need spacing, not an instant retry.
      await new Promise((resolve) => setTimeout(resolve, 2_000 + Math.floor(Math.random() * 2_000)));
      try { completion = await modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "spine_mapping", retry: "malformed_response" } }); }
      catch { throw firstError; }
    }
    const start = completion.text.indexOf("{"); const end = completion.text.lastIndexOf("}");
    try {
      if (start < 0 || end < start) throw new Error("spine_mapping did not return JSON");
      const parsed = JSON.parse(completion.text.slice(start, end + 1)) as JsonValue;
      validate(parsed, schema, "$", true);
      return parsed as T;
    } catch (validationError) {
      if (schemaRetried) throw validationError;
      schemaRetried = true;
      messages.push({ role: "assistant", content: completion.text });
      messages.push({ role: "user", content: `[VALIDATION ERROR]\n${validationError instanceof Error ? validationError.message : String(validationError)}\n\n${schemaCorrectionInstruction}` });
    }
  }
}
