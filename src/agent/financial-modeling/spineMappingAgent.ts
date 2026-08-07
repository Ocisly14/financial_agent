import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import type { JsonSchema, JsonValue } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { Fact } from "../../financial-model/types.ts";
import { CANONICAL_MAPPING_IDS } from "../../financial-model/skeleton.ts";
import { buildSpineFromUnified, checkSpineCompleteness, type SpineDecision } from "../../infra/xbrl/spineFromUnified.ts";
import type { UnifiedStatementsArtifact } from "../../infra/xbrl/unifiedStatements.ts";

const DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["mappings", "detailRows", "excluded", "spineGaps"], properties: {
    mappings: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["targetId", "rowIds", "rationale"],
      properties: { targetId: { type: "string" }, rowIds: { type: "array", items: { type: "string" } },
        rationale: { type: "string" } } } },
    detailRows: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["parentTargetId", "rowId", "rationale"],
      properties: { parentTargetId: { type: "string" }, rowId: { type: "string" }, rationale: { type: "string" } } } },
    excluded: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["rowId", "reason"], properties: { rowId: { type: "string" }, reason: { type: "string" } } } },
    spineGaps: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["targetId", "reason"], properties: { targetId: { type: "string" }, reason: { type: "string" } } } },
  } };

export type SpineMappingRun = {
  decision: SpineDecision;
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
  const maxRuns = input.maxRuns ?? 3;
  let findings: string[] = [];
  let last: SpineMappingRun | undefined;

  for (let run = 1; run <= maxRuns; run += 1) {
    const decision = await requestDecision(input.modelRouter, input.systemPrompt, input.unified, spineIds, findings);
    findings = checkSpineCompleteness({ unified: input.unified, decision, spineIds });
    if (findings.length > 0) continue;
    const built = buildSpineFromUnified({ decision, unified: input.unified, spineIds });
    findings = built.findings;
    last = { decision, facts: built.facts, coverageGaps: built.coverageGaps, unresolvedFindings: findings };
    if (findings.length === 0) return last;
  }
  if (!last) throw new Error(`spine_mapping completeness check failed on all ${maxRuns} runs:\n${findings.join("\n")}`);
  return last;
}

async function requestDecision(modelRouter: ModelRouter, systemPrompt: string, unified: UnifiedStatementsArtifact,
  spineIds: ReadonlySet<string>, priorFindings: readonly string[]): Promise<SpineDecision> {
  const statements = JSON.stringify({ rows: unified.rows, periods: unified.periods });
  const messages: LlmMessage[] = [
    { role: "system", content: `${systemPrompt}\n\nReturn EXACTLY one JSON object: {"mappings":[...],"detailRows":[...],"excluded":[...],"spineGaps":[...]} and nothing else.` },
    { role: "user", content: `[CANONICAL SPINE IDS]\n${JSON.stringify([...spineIds])}\n\n[UNIFIED STATEMENTS]\n${statements}${priorFindings.length > 0 ? `\n\n[FINDINGS FROM PREVIOUS RUN]\n${priorFindings.join("\n")}\n\nFix every finding and re-emit the FULL decision.` : ""}` },
  ];
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
      validate(parsed, DECISION_SCHEMA, "$", true);
      return parsed as SpineDecision;
    } catch (validationError) {
      if (schemaRetried) throw validationError;
      schemaRetried = true;
      messages.push({ role: "assistant", content: completion.text });
      messages.push({ role: "user", content: `[VALIDATION ERROR]\n${validationError instanceof Error ? validationError.message : String(validationError)}\n\nRe-emit the FULL corrected decision as one JSON object.` });
    }
  }
}
