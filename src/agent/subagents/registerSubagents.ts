import { SubagentRegistry } from "../../framework/subagent.ts";
import { SKILL_FRAMEWORK_TOOLS } from "../../framework/skillTools.ts";
import { financialModelingSubagentPrompt, marketDataSubagentPrompt, marketResearchSubagentPrompt,
  spineMappingSubagentPrompt, statementUnificationSubagentPrompt, tradingOperationsSubagentPrompt } from "../prompts/subagentPrompts.ts";
import { FINANCIAL_MODELING_TOOLS, MARKET_DATA_TOOLS, MARKET_RESEARCH_TOOLS, TRADING_OPERATIONS_TOOLS } from "../../../mcp_tools/registerTools.ts";
import { DCF_PRIVATE_SUBAGENT_TOOL } from "../../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { STATEMENT_EXTRACTION_TOOL } from "../../../mcp_tools/financial-model/statementExtractionTool.ts";

/** A mapping run is load, judge, submit, correct — 8-10 rounds in practice. The rest absorbs a schema
 *  retry, an extra correction, or an issuer with more dimension axes than Apple. */
const MAPPING_AGENT_STEPS = 15;

export function createSubagentRegistry(): SubagentRegistry {
  const registry = new SubagentRegistry();
  registry.register({
    name: "financial_modeling",
    description: "Hierarchical DCF Agent that owns one revisioned model workflow and delegates statement extraction and mapping to private subagents, then authors the forecast and valuation itself. Dispatch it for a DCF, intrinsic value, fair value, or any fundamentals-based valuation of a specific company; it runs for several rounds, so continue its thread rather than starting a new one.",
    modelClass: "MEDIUM",
    // ask_user is the one subagent that gets it: a DCF runs for many turns on
    // judgment calls only the user can settle (which segment basis, whose
    // guidance to trust), and relaying those up through a task summary and back
    // down through a re-dispatch loses the question. The dispatcher removes it
    // again when no human is watching the stream.
    defaultTools: [...FINANCIAL_MODELING_TOOLS, STATEMENT_EXTRACTION_TOOL,
      DCF_PRIVATE_SUBAGENT_TOOL, "financial_search", "ask_user",
      ...SKILL_FRAMEWORK_TOOLS],
    // 方法论归它自己取:invoke_skill 拿六阶段地图,再按阶段 read_skill_reference
    // 取 playbook。不靠 orchestrator 转达,所以中途换 orchestrator 也不会丢。
    skills: ["dcf-modeling"],
    // A full DCF authored by this agent alone (no drafting subagents) runs ~20-30 steps: 5 for the
    // data foundation, then serial mutation batches (each revision change must be a solo step) for
    // the forecast, WACC inputs, and stage advances. Progress is projected, not accumulated, so a
    // higher cap does not grow the context; the resumable pause remains the runaway guard.
    maxToolSteps: 30,
    systemPrompt: financialModelingSubagentPrompt,
  });
  registry.register({
    name: "market_data",
    description:
      "Stock market data agent for live quotes, charts, and independently selected technical-indicator calculations backed by the stock bar database.",
    modelClass: "MEDIUM",
    defaultTools: [...MARKET_DATA_TOOLS],
    systemPrompt: marketDataSubagentPrompt,
  });
  registry.register({
    name: "market_research",
    description:
      "Company and cross-market research agent for official SEC filings and XBRL facts, financial news, current events, macro themes, institutional activity, and asset-specific research.",
    modelClass: "MEDIUM",
    defaultTools: [...MARKET_RESEARCH_TOOLS],
    systemPrompt: marketResearchSubagentPrompt,
  });
  registry.register({
    name: "trading_operations",
    description:
      "US stock and ETF strategy agent for creating, approving, monitoring, pausing, resuming, and cancelling paper/shadow strategies driven by price or technical indicators.",
    modelClass: "MEDIUM",
    defaultTools: [...TRADING_OPERATIONS_TOOLS],
    systemPrompt: tradingOperationsSubagentPrompt,
  });
  // The two mapping agents report to financial_modeling rather than to the orchestrator — that is a
  // reporting line, not a different kind of thing. Same runtime, same tool shape, same session events.
  // Their tools are run-scoped (pinned to one model, holding the decision submitted so far), so the
  // caller passes them per run rather than registering them process-wide.
  registry.register({
    name: "statement_unification",
    description:
      "Aligns one issuer's XBRL face-statement concepts across filings into unified multi-year statements in the issuer's own structure. financial_modeling delegates to it during a DCF; it needs a model whose filings are already extracted.",
    modelClass: "MEDIUM",
    // No skills, and none of the skill framework tools: this agent's methodology is inline in its
    // prompt, where it rides the cached prefix instead of being re-sent as progress every step.
    defaultTools: ["load_concept_inventory", "list_dimension_axes", "get_axis_breakdown",
      "submit_unification_decision", "patch_unification_decision"],
    maxToolSteps: MAPPING_AGENT_STEPS,
    systemPrompt: statementUnificationSubagentPrompt,
  });
  registry.register({
    name: "spine_mapping",
    description:
      "Places an issuer's unified statement rows onto the DCF engine's canonical spine. financial_modeling delegates to it during a DCF; it needs unified statements statement_unification has already stored.",
    modelClass: "MEDIUM",
    // Inline methodology, no skills — see statement_unification above.
    defaultTools: ["load_unified_statements", "submit_spine_decision", "patch_spine_decision"],
    maxToolSteps: MAPPING_AGENT_STEPS,
    systemPrompt: spineMappingSubagentPrompt,
  });
  return registry;
}
