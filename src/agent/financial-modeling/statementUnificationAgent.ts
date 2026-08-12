import { createUnificationDeliveryTools } from "../../../mcp_tools/financial-model/unificationDeliveryTools.ts";
import { McpToolRegistry, type RegisteredTool } from "../../../mcp_tools/toolRegistry.ts";
import { createLogger } from "../../infra/logger/logger.ts";
import type { SubagentDefinition, SubagentRuntime } from "../../framework/subagent.ts";
import type { SessionState } from "../../framework/sessionState.ts";
import type { Period } from "../../financial-model/types.ts";
import { buildConceptInventory } from "../../infra/xbrl/conceptInventory.ts";
import type { UnificationDecision, UnifiedStatementsArtifact } from "../../infra/xbrl/unifiedStatements.ts";
import type { PresentationExtract } from "../../infra/xbrl/types.ts";
import type { FilingTable } from "../../infra/xbrl/tableTypes.ts";

const log = createLogger("statement_unification");

// Findings run to hundreds of lines (one per inventory row per period), so a raw dump buries
// the signal. Bucket by finding kind, then show the first few of each.
const FINDING_KIND = /^(dangling|double-count|row "[^"]*" references|row "[^"]*" is)/;
const SAMPLE_PER_KIND = 3;

export function logFindings(label: string, findings: readonly string[]): void {
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

export type StatementUnificationRun = {
  decision: UnificationDecision;
  /**
   * What the agent wrote when it called finish — its own account of the work, composed after it had
   * seen the host's verdict on the submission. This is the single channel back to the DCF
   * orchestrator, so it is also the agent's judgment that the task is done.
   */
  summary: string;
  /** `unresolvedFindings` is empty on a clean run, never silently empty on a dirty one. */
  artifact: UnifiedStatementsArtifact;
};

/**
 * Host for the statement_unification agent. It builds the run's tools, hands the agent to the shared
 * SubagentRuntime, and reads back what was delivered.
 *
 * It does NOT sequence the work. Loading the inventory, exploring dimension axes, submitting a
 * decision and correcting it against findings used to be four hard-coded phases here; they are now
 * four tools, and the agent's own skill tells it how to use them. The phases were invisible to the
 * model, which is how a complete decision produced during the exploration phase came to be discarded
 * as an unknown tool call.
 *
 * The host keeps what only a host can do: it builds its OWN concept inventory over the same extracts,
 * so every check runs against material the agent had no hand in producing.
 */
export async function runStatementUnificationAgent(input: {
  subagentRuntime: SubagentRuntime;
  definition: SubagentDefinition;
  state: SessionState;
  sessionId: string;
  agentId: string;
  /** The DCF Agent's instruction. Names the ticker; the agent loads its own working set by it. */
  task: string;
  /** From createStatementUnificationTools: the read side, pinned to this run's model. */
  readTools: RegisteredTool[];
  filings: readonly PresentationExtract[];
  requestedPeriods: readonly Period[];
  tables?: readonly FilingTable[];
}): Promise<StatementUnificationRun> {
  const inventory = buildConceptInventory({ filings: input.filings, requestedPeriods: input.requestedPeriods });
  const tables = input.tables ?? [];
  const delivery = createUnificationDeliveryTools({ filings: input.filings,
    requestedPeriods: input.requestedPeriods, inventory, tables });

  const runTools = [...input.readTools, ...delivery.tools];
  const registry = new McpToolRegistry();
  for (const tool of runTools) registry.register(tool);

  const threadId = input.state.openThread("statement_unification");
  const taskId = input.state.recordDispatch("statement_unification", input.task, threadId).event_id;
  const task = await input.subagentRuntime.run(input.definition, {
    sessionId: input.sessionId, agentId: input.agentId, taskId, threadId, state: input.state,
    request: { agent: "statement_unification", task: input.task },
    allowedTools: runTools.map(({ execute: _execute, ...definition }) => definition),
    toolRegistry: registry,
  });

  const delivered = delivery.delivered();
  if (!delivered) {
    // Nothing was submitted: there is no partial artifact to salvage, and shipping an empty one would
    // read downstream as "this issuer has no statements" rather than "the agent never delivered".
    throw new Error(`statement_unification finished without submitting a decision: ${input.task}`);
  }
  if (delivered.findings.length > 0) logFindings("unresolved", delivered.findings);
  log.info(`decision has ${delivered.artifact.rows.length} rows, ${delivered.artifact.breakdownRows?.length ?? 0} breakdown rows`);
  return { decision: delivered.decision, summary: task?.summary ?? "", artifact: delivered.artifact };
}
