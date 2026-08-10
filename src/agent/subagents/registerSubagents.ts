import { SubagentRegistry } from "../../framework/subagent.ts";
import { financialModelingSubagentPrompt, marketDataSubagentPrompt, marketResearchSubagentPrompt, tradingOperationsSubagentPrompt } from "../prompts/subagentPrompts.ts";
import { FINANCIAL_MODELING_TOOLS, MARKET_DATA_TOOLS, MARKET_RESEARCH_TOOLS, TRADING_OPERATIONS_TOOLS } from "../../../mcp_tools/registerTools.ts";
import { DCF_PRIVATE_SUBAGENT_TOOL } from "../../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { STATEMENT_EXTRACTION_TOOL } from "../../../mcp_tools/financial-model/statementExtractionTool.ts";

export function createSubagentRegistry(): SubagentRegistry {
  const registry = new SubagentRegistry();
  registry.register({
    name: "financial_modeling",
    description: "Hierarchical DCF Agent that owns one revisioned model workflow and delegates statement extraction, mapping, forecast, and valuation analysis to private subagents.",
    modelClass: "MEDIUM",
    defaultTools: [...FINANCIAL_MODELING_TOOLS, STATEMENT_EXTRACTION_TOOL,
      DCF_PRIVATE_SUBAGENT_TOOL, "financial_search"],
    maxToolSteps: 12,
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
  return registry;
}
