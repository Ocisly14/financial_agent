import { McpToolRegistry } from "./toolRegistry.ts";

// stock
import { createGetStockPriceTool } from "./stock/getStockPriceTool.ts";
// search
import { createFinancialSearchTool } from "./search/financialSearchTool.ts";
// technical
import { createTechnicalIndicatorTools, TECHNICAL_TOOL_NAMES } from "./technical/technicalIndicatorTools.ts";
import {
  createCreateStrategyTool,
  createStartStrategyTool,
  createListStrategiesTool,
  createManageStrategyTool,
} from "./trading/strategyTools.ts";

export function registerAllTools(registry: McpToolRegistry): void {
  // non_trading tools
  registry.register(createGetStockPriceTool());
  registry.register(createFinancialSearchTool());
  for (const tool of createTechnicalIndicatorTools()) registry.register(tool);
  // Price-driven stock strategy tools. Execution is paper/shadow only until a
  // stock broker adapter is explicitly added.
  registry.register(createCreateStrategyTool());
  registry.register(createStartStrategyTool());
  registry.register(createListStrategiesTool());
  registry.register(createManageStrategyTool());
}

export const MARKET_DATA_TOOLS = [
  "get_stock_price",
  ...TECHNICAL_TOOL_NAMES,
] as const;

export const MARKET_RESEARCH_TOOLS = [
  "financial_search",
] as const;

export const TRADING_OPERATIONS_TOOLS = [
  "create_strategy",
  "start_strategy",
  "list_strategies",
  "manage_strategy",
] as const;
