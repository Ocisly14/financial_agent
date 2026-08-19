import type { SubagentDefinition } from "../../framework/subagent.ts";
import { dcfBehavior } from "../financial-modeling/dcfBehavior.ts";
import { DELEGATE_TO_AGENT } from "../../framework/delegation.ts";
import { SKILL_FRAMEWORK_TOOLS } from "../../framework/skillTools.ts";
import { financialModelingSubagentPrompt, marketDataSubagentPrompt, marketResearchSubagentPrompt,
  spineMappingSubagentPrompt, statementUnificationSubagentPrompt, tradingOperationsSubagentPrompt } from "../prompts/subagentPrompts.ts";
import { FINANCIAL_MODELING_TOOLS, MARKET_DATA_TOOLS, MARKET_RESEARCH_TOOLS, TRADING_OPERATIONS_TOOLS } from "../../../mcp_tools/registerTools.ts";
import { STATEMENT_EXTRACTION_TOOL } from "../../../mcp_tools/financial-model/statementExtractionTool.ts";

/** A mapping run is load, judge, draft in statement-sized batches, validate, then correct. The
 * remaining budget absorbs a schema retry, an extra correction, or an issuer with several useful
 * dimension axes. */
const MAPPING_AGENT_STEPS = 18;

/**
 * Every agent, what it may call, and who it may hand work to — in one place.
 *
 * The three used to be spread out: the tool pool here, the delegation edges implied by a hardcoded
 * enum inside run_dcf_subagent, and "who may dispatch whom" left entirely to whoever held a
 * Dispatcher. Reading one agent's reach meant reading three files and inferring the third.
 *
 * The orchestrator is deliberately absent. It is the root — it may dispatch any registered agent —
 * so it has no edges to declare and no pool of its own to gate.
 *
 * `assertAgentTopology` checks this list at startup: unknown or duplicate edges, self-delegation,
 * cycles, edges into an agent that never opted in with `delegable`, and a roster that disagrees
 * with whether the agent actually carries the delegation tool.
 */
export const AGENT_TOPOLOGY: readonly SubagentDefinition[] = [
  {
    name: "financial_modeling",
    description: "Hierarchical DCF Agent that owns one revisioned model workflow and delegates statement extraction and mapping to private subagents, then authors the forecast and valuation itself. Dispatch it for a DCF, intrinsic value, fair value, or any fundamentals-based valuation of a specific company; it runs for several rounds, so continue its thread rather than starting a new one.",
    modelClass: "MEDIUM",
    // ask_user is the one subagent that gets it: a DCF runs for many turns on
    // judgment calls only the user can settle (which segment basis, whose
    // guidance to trust), and relaying those up through a task summary and back
    // down through a re-dispatch loses the question. The dispatcher removes it
    // again when no human is watching the stream.
    //
    // Append only, never insert or reorder. Tool declaration order is part of the cached prefix,
    // ahead of the messages: reordering this list re-bills the whole prompt on every step of every
    // DCF while changing nothing a test would notice.
    defaultTools: [...FINANCIAL_MODELING_TOOLS, STATEMENT_EXTRACTION_TOOL,
      "financial_search", "ask_user",
      ...SKILL_FRAMEWORK_TOOLS, DELEGATE_TO_AGENT],
    // 方法论归它自己取:invoke_skill 拿六阶段地图,再按阶段 read_skill_reference
    // 取 playbook。不靠 orchestrator 转达,所以中途换 orchestrator 也不会丢。
    skills: ["dcf-modeling"],
    delegatesTo: ["market_research", "statement_unification", "spine_mapping"],
    // A full DCF runs the data foundation, then serial mutation batches (each revision change must
    // be a solo step) for the forecast, WACC inputs, and stage advances, with delegate rounds nested
    // along the way. Progress is a bounded, deduplicated projection, so a higher cap does not grow
    // the context without limit; the resumable pause remains the runaway guard.
    maxToolSteps: 60,
    // A DCF round is not one lookup: 60 tool steps, several nesting whole delegate rounds (a
    // mapping delegate alone may take 10 minutes). The timeout does not cancel — see the
    // dispatcher — so the ceiling is generous rather than tight.
    taskTimeoutMs: 30 * 60_000,
    // The DCF runtime hooks: its own progress projection, mutation seriality, model auto-refresh,
    // resumable-pause summary. Declared here so this node is the whole account of the agent.
    behavior: dcfBehavior,
    systemPrompt: financialModelingSubagentPrompt,
  },
  {
    name: "market_data",
    description:
      "Stock market data agent for live quotes, charts, and independently selected technical-indicator calculations backed by the stock bar database.",
    modelClass: "MEDIUM",
    defaultTools: [...MARKET_DATA_TOOLS],
    systemPrompt: marketDataSubagentPrompt,
  },
  {
    name: "market_research",
    description:
      "Company and cross-market research agent for official SEC filings and XBRL facts, financial news, current events, macro themes, institutional activity, and asset-specific research.",
    modelClass: "MEDIUM",
    defaultTools: [...MARKET_RESEARCH_TOOLS],
    // Summary only. Its task result's data is every search payload it collected, and handing that
    // to a DCF agent would put the raw text of each search into the one context delegating exists
    // to keep small. What the caller needs is the account, which is what finish writes.
    delegable: { returns: "summary", timeoutMs: 5 * 60_000 },
    // Raised from the default 5, which was sized for the orchestrator's one-shot lookups. A
    // delegated round resolves the filer, runs two or three searches and then synthesises; at 5 it
    // runs out mid-round, and an exhausted run has no finish summary — which for a summary-only
    // delegate means the caller gets nothing at all.
    maxToolSteps: 8,
    systemPrompt: marketResearchSubagentPrompt,
  },
  {
    name: "trading_operations",
    description:
      "US stock and ETF strategy agent for creating, approving, monitoring, pausing, resuming, and cancelling paper/shadow strategies driven by price or technical indicators.",
    modelClass: "MEDIUM",
    defaultTools: [...TRADING_OPERATIONS_TOOLS],
    // No `delegable`: it raises approvals a blocked caller has no way to wait on, so it is reached
    // by orchestrator dispatch only. That absence is the whole gate — assertAgentTopology refuses
    // any edge into an agent that has not opted in.
    //
    // Above the generic default because activating a strategy waits on a human approval.
    taskTimeoutMs: 16 * 60_000,
    systemPrompt: tradingOperationsSubagentPrompt,
  },
  // The two mapping agents report to financial_modeling rather than to the orchestrator — that is a
  // reporting line, not a different kind of thing. Same runtime, same tools shape, same session
  // events, same delegation path. Their tools keep per-task working state internally (the model
  // loaded, the draft submitted so far), keyed by the task id every call carries.
  {
    name: "statement_unification",
    description:
      "Aligns one issuer's XBRL face-statement concepts across filings into unified multi-year statements in the issuer's own structure. financial_modeling delegates to it during a DCF; it needs a model whose filings are already extracted.",
    modelClass: "MEDIUM",
    // No skills, and none of the skill framework tools: this agent's methodology is inline in its
    // prompt, where it rides the cached prefix instead of being re-sent as progress every step.
    defaultTools: ["load_concept_inventory", "list_dimension_axes", "get_axis_breakdown",
      "start_unification_draft", "patch_unification_decision", "validate_unification_decision",
      "submit_unification_decision"],
    delegable: { returns: "summary", timeoutMs: 10 * 60_000 },
    maxToolSteps: MAPPING_AGENT_STEPS,
    systemPrompt: statementUnificationSubagentPrompt,
  },
  {
    name: "spine_mapping",
    description:
      "Places an issuer's unified statement rows onto the DCF engine's canonical spine. financial_modeling delegates to it during a DCF; it needs unified statements statement_unification has already stored.",
    modelClass: "MEDIUM",
    // Inline methodology, no skills — see statement_unification above.
    defaultTools: ["load_unified_statements", "submit_spine_decision", "patch_spine_decision"],
    delegable: { returns: "summary", timeoutMs: 10 * 60_000 },
    maxToolSteps: MAPPING_AGENT_STEPS,
    systemPrompt: spineMappingSubagentPrompt,
  },
];
