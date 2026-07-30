import { SubagentRegistry } from "../../framework/subagent.ts";
import { marketDataSubagentPrompt, marketResearchSubagentPrompt, tradingOperationsSubagentPrompt } from "../prompts/subagentPrompts.ts";
import { MARKET_DATA_TOOLS, MARKET_RESEARCH_TOOLS, TRADING_OPERATIONS_TOOLS } from "../../../mcp_tools/registerTools.ts";

export function createSubagentRegistry(): SubagentRegistry {
  const registry = new SubagentRegistry();
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
      "Cross-market research agent for financial news, current events, macro themes, institutional activity, and asset-specific research.",
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
