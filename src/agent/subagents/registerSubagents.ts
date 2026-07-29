import { SubagentRegistry } from "../../framework/subagent.ts";
import { marketDataSubagentPrompt, marketResearchSubagentPrompt, tradingOperationsSubagentPrompt } from "../prompts/subagentPrompts.ts";
import { MARKET_DATA_TOOLS, MARKET_RESEARCH_TOOLS, TRADING_OPERATIONS_TOOLS } from "../../../mcp_tools/registerTools.ts";

export function createSubagentRegistry(): SubagentRegistry {
  const registry = new SubagentRegistry();
  registry.register({
    name: "market_data",
    description:
      "Cross-market data agent for live stock and digital-asset prices, technical analysis, charts, market microstructure, and supporting data lookup.",
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
      "Trading operations agent for order previews, approvals, balances, positions, orders, fills, PnL, and automated strategy lifecycle tasks across supported venues.",
    modelClass: "MEDIUM",
    defaultTools: [...TRADING_OPERATIONS_TOOLS],
    systemPrompt: tradingOperationsSubagentPrompt,
  });
  return registry;
}
