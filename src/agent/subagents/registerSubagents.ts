import { SubagentRegistry } from "../../framework/subagent.ts";
import { newsResearchSubagentPrompt, onchainDataSubagentPrompt, tradeSubagentPrompt } from "../prompts/subagentPrompts.ts";
import { NEWS_RESEARCH_TOOLS, ONCHAIN_DATA_TOOLS, TRADING_TOOLS } from "../../../mcp_tools/registerTools.ts";

export function createSubagentRegistry(): SubagentRegistry {
  const registry = new SubagentRegistry();
  registry.register({
    name: "onchain_data",
    description:
      "Quantitative crypto data agent for live market data, technical analysis, charts, on-chain activity, flow/positioning, launchpad metrics, Fear & Greed market context, and supporting web search.",
    modelClass: "MEDIUM",
    defaultTools: [...ONCHAIN_DATA_TOOLS],
    systemPrompt: onchainDataSubagentPrompt,
  });
  registry.register({
    name: "news_research",
    description:
      "News and research agent for crypto news, web/current-events research, and institutional adoption context.",
    modelClass: "MEDIUM",
    defaultTools: [...NEWS_RESEARCH_TOOLS],
    systemPrompt: newsResearchSubagentPrompt,
  });
  registry.register({
    name: "trade",
    description:
      "CEX trading workflow agent for manual order previews, approval requests, balances, positions, orders, fills, PnL, and price-driven auto-trading strategy draft/create/start/list/manage tasks.",
    modelClass: "MEDIUM",
    defaultTools: [...TRADING_TOOLS],
    systemPrompt: tradeSubagentPrompt,
  });
  return registry;
}
