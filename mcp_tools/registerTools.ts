import { McpToolRegistry } from "./toolRegistry.ts";

// stock
import { createGetStockPriceTool } from "./stock/getStockPriceTool.ts";
// search
import { createFinancialSearchTool } from "./search/financialSearchTool.ts";
// technical
import { createTechnicalIndicatorTools, TECHNICAL_TOOL_NAMES } from "./technical/technicalIndicatorTools.ts";
// trading
import { createGetBalanceTool } from "./trading/getBalanceTool.ts";
import { createGetOrdersTool } from "./trading/getOrdersTool.ts";
import { createGetFillsTool } from "./trading/getFillsTool.ts";
import { createCexPreviewOrderTool } from "./trading/cexPreviewOrderTool.ts";
import { createCexCreateOrderTool } from "./trading/cexCreateOrderTool.ts";
import { createCancelOrderTool } from "./trading/cancelOrderTool.ts";
import { createGetTickerTool } from "./trading/getTickerTool.ts";
import { createGetOrderbookTool } from "./trading/getOrderbookTool.ts";
import { createGetPositionsTool } from "./trading/getPositionsTool.ts";
import { createGetPnlTool } from "./trading/getPnlTool.ts";
import {
  createCexCreateStrategyTool,
  createCexStartStrategyTool,
  createCexListStrategiesTool,
  createCexManageStrategyTool,
} from "./trading/strategyTools.ts";

export function registerAllTools(registry: McpToolRegistry): void {
  // non_trading tools
  registry.register(createGetStockPriceTool());
  registry.register(createFinancialSearchTool());
  for (const tool of createTechnicalIndicatorTools()) registry.register(tool);
  // trading tools
  registry.register(createGetBalanceTool());
  registry.register(createGetOrdersTool());
  registry.register(createGetFillsTool());
  registry.register(createCexPreviewOrderTool());
  registry.register(createCexCreateOrderTool());
  registry.register(createCancelOrderTool());
  registry.register(createGetTickerTool());
  registry.register(createGetOrderbookTool());
  registry.register(createGetPositionsTool());
  registry.register(createGetPnlTool());
  // auto-trading strategy tools
  registry.register(createCexCreateStrategyTool());
  registry.register(createCexStartStrategyTool());
  registry.register(createCexListStrategiesTool());
  registry.register(createCexManageStrategyTool());
}

export const MARKET_DATA_TOOLS = [
  "get_stock_price",
  ...TECHNICAL_TOOL_NAMES,
] as const;

export const MARKET_RESEARCH_TOOLS = [
  "financial_search",
] as const;

export const TRADING_OPERATIONS_TOOLS = [
  "get_balance",
  "get_orders",
  "get_fills",
  "cex_prepare_order",
  "cex_create_order",
  "cancel_order",
  "get_ticker",
  "get_orderbook",
  "get_positions",
  "get_pnl",
  "cex_create_strategy",
  "cex_start_strategy",
  "cex_list_strategies",
  "cex_manage_strategy",
] as const;
