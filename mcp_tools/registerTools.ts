import { McpToolRegistry } from "./toolRegistry.ts";

// market
import { createGetCryptoPriceTool } from "./market/getCryptoPriceTool.ts";
// stock
import { createGetStockPriceTool } from "./stock/getStockPriceTool.ts";
// search
import { createWebSearchTool } from "./search/webSearchTool.ts";
import { createCryptoResearchSearchTool } from "./search/cryptoResearchSearchTool.ts";
import { createInstitutionalAdoptionSearchTool } from "./search/institutionalAdoptionSearchTool.ts";
// sentiment
import { createFearGreedAnalysisTool } from "./sentiment/fearGreedAnalysisTool.ts";
// technical
import { createTechnicalAnalysisTool } from "./technical/technicalAnalysisTool.ts";
// onchain
import { createWhaleAlertTool } from "./onchain/whaleAlertTool.ts";
import { createInflowOutflowTool } from "./onchain/inflowOutflowTool.ts";
import { createTransactionVolumeTool } from "./onchain/transactionVolumeTool.ts";
import { createBidAskVolumeTool } from "./onchain/bidAskVolumeTool.ts";
import { createAddressTransactionTool } from "./onchain/addressTransactionTool.ts";
// chart
import { createPriceChartTool } from "./chart/priceChartTool.ts";
// launchpad
import { createTokenMetadataOverviewTool } from "./launchpad/tokenMetadataOverviewTool.ts";
import { createTokenHourlyMetricsTool } from "./launchpad/tokenHourlyMetricsTool.ts";
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
  registry.register(createGetCryptoPriceTool());
  registry.register(createGetStockPriceTool());
  registry.register(createWebSearchTool());
  registry.register(createCryptoResearchSearchTool());
  registry.register(createInstitutionalAdoptionSearchTool());
  registry.register(createFearGreedAnalysisTool());
  registry.register(createTechnicalAnalysisTool());
  registry.register(createWhaleAlertTool());
  registry.register(createInflowOutflowTool());
  registry.register(createTransactionVolumeTool());
  registry.register(createBidAskVolumeTool());
  registry.register(createAddressTransactionTool());
  registry.register(createTokenMetadataOverviewTool());
  registry.register(createTokenHourlyMetricsTool());
  registry.register(createPriceChartTool());
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
  "get_crypto_price",
  "get_stock_price",
  "web_search",
  "technical_analysis",
  "price_chart",
  "whale_alert",
  "inflow_outflow_analysis",
  "transaction_volume_analysis",
  "bid_ask_volume_analysis",
  "address_transaction_data",
  "fear_greed_index_analysis",
  "token_metadata_overview",
  "token_hourly_metrics",
] as const;

export const MARKET_RESEARCH_TOOLS = [
  "web_search",
  "crypto_research_search",
  "institutional_adoption_search",
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
