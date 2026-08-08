import { McpToolRegistry } from "./toolRegistry.ts";

// stock
import { createGetStockPriceTool } from "./stock/getStockPriceTool.ts";
// sector
import { createGetSectorAnalysisTool } from "./sector/getSectorAnalysisTool.ts";
// search
import { createFinancialSearchTool } from "./search/financialSearchTool.ts";
// SEC filings and standardized company facts
import { createSecTools, SEC_TOOL_NAMES } from "./sec/secTools.ts";
// technical
import { createTechnicalIndicatorTools, TECHNICAL_TOOL_NAMES } from "./technical/technicalIndicatorTools.ts";
import {
  createCreateStrategyTool,
  createStartStrategyTool,
  createListStrategiesTool,
  createManageStrategyTool,
} from "./trading/strategyTools.ts";
import { createAskUserTool } from "./user/askUserTool.ts";
import { createFinancialModelTools, FINANCIAL_MODELING_TOOLS, type FinancialModelToolDeps } from "./financial-model/financialModelTools.ts";
import { createWorkbenchTools } from "./financial-model/workbenchTools.ts";

export function registerAllTools(registry: McpToolRegistry, options: { financialModelDeps?: FinancialModelToolDeps } = {}): void {
  registry.register(createAskUserTool());
  // non_trading tools
  registry.register(createGetStockPriceTool());
  registry.register(createGetSectorAnalysisTool());
  registry.register(createFinancialSearchTool());
  for (const tool of createSecTools()) registry.register(tool);
  for (const tool of createTechnicalIndicatorTools()) registry.register(tool);
  for (const tool of createFinancialModelTools(options.financialModelDeps)) registry.register(tool);
  for (const tool of createWorkbenchTools(options.financialModelDeps)) registry.register(tool);
  // Price-driven stock strategy tools. Execution is paper/shadow only until a
  // stock broker adapter is explicitly added.
  registry.register(createCreateStrategyTool());
  registry.register(createStartStrategyTool());
  registry.register(createListStrategiesTool());
  registry.register(createManageStrategyTool());
}

export const MARKET_DATA_TOOLS = [
  "get_stock_price",
  "get_sector_analysis",
  ...TECHNICAL_TOOL_NAMES,
] as const;

export const MARKET_RESEARCH_TOOLS = [
  ...SEC_TOOL_NAMES,
  "financial_search",
] as const;

export const TRADING_OPERATIONS_TOOLS = [
  "create_strategy",
  "start_strategy",
  "list_strategies",
  "manage_strategy",
] as const;

export { FINANCIAL_MODELING_TOOLS };
