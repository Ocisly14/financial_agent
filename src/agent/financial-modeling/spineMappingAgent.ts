import { createSpineDeliveryTools } from "../../../mcp_tools/financial-model/spineDeliveryTools.ts";
import { McpToolRegistry, type RegisteredTool } from "../../../mcp_tools/toolRegistry.ts";
import { createLogger } from "../../infra/logger/logger.ts";
import type { SubagentDefinition, SubagentRuntime } from "../../framework/subagent.ts";
import type { SessionState } from "../../framework/sessionState.ts";
import type { Fact } from "../../financial-model/types.ts";
import { CANONICAL_MAPPING_IDS, REQUIRED_MAPPING_IDS } from "../../financial-model/skeleton.ts";
import type { SpineDecision } from "../../infra/xbrl/spineFromUnified.ts";
import type { UnifiedStatementsArtifact } from "../../infra/xbrl/unifiedStatements.ts";

const log = createLogger("spine_mapping");

export type SpineMappingRun = {
  decision: SpineDecision;
  /**
   * What the agent wrote when it called finish — its own account of the work, composed after it had
   * seen the host's verdict on the submission. This is the single channel back to the DCF
   * orchestrator, so it is also the agent's judgment that the task is done.
   */
  summary: string;
  facts: Fact[];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  /** Empty on a clean run. Never silently empty on a dirty one. */
  unresolvedFindings: string[];
};

/**
 * Host for the spine_mapping agent — the same shape as statement_unification's: build the run's
 * tools, run the shared SubagentRuntime, read back the delivery. The sequence is the agent's,
 * described by its skill; the checks stay here, where the model cannot reach them.
 */
export async function runSpineMappingAgent(input: {
  subagentRuntime: SubagentRuntime;
  definition: SubagentDefinition;
  state: SessionState;
  sessionId: string;
  agentId: string;
  task: string;
  /** From createSpineMappingTools: the read side, pinned to this run's model. */
  readTools: RegisteredTool[];
  unified: UnifiedStatementsArtifact;
  spineIds?: readonly string[];
}): Promise<SpineMappingRun> {
  const spineIds: ReadonlySet<string> = new Set(input.spineIds ?? [...CANONICAL_MAPPING_IDS]);
  const requiredIds: ReadonlySet<string> = new Set([...REQUIRED_MAPPING_IDS].filter((id) => spineIds.has(id)));
  const delivery = createSpineDeliveryTools({ unified: input.unified, spineIds, requiredIds });

  const runTools = [...input.readTools, ...delivery.tools];
  const registry = new McpToolRegistry();
  for (const tool of runTools) registry.register(tool);

  const threadId = input.state.openThread("spine_mapping");
  const taskId = input.state.recordDispatch("spine_mapping", input.task, threadId).event_id;
  const task = await input.subagentRuntime.run(input.definition, {
    sessionId: input.sessionId, agentId: input.agentId, taskId, threadId, state: input.state,
    request: { agent: "spine_mapping", task: input.task },
    allowedTools: runTools.map(({ execute: _execute, ...definition }) => definition),
    toolRegistry: registry,
  });

  const delivered = delivery.delivered();
  if (!delivered) throw new Error(`spine_mapping finished without submitting a mapping: ${input.task}`);
  log.info(`mapping produced ${delivered.facts.length} facts, ${delivered.coverageGaps.length} coverage gaps, ${delivered.findings.length} unresolved findings`);
  return { decision: delivered.decision, summary: task?.summary ?? "", facts: delivered.facts,
    coverageGaps: delivered.coverageGaps, unresolvedFindings: delivered.findings };
}
