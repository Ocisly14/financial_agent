type JsonRecord = Record<string, unknown>;

export type TakerVolumePoint = {
  aggregated_buy_volume_usd: number;
  aggregated_sell_volume_usd: number;
  time: number;
  total_volume: number;
  buy_sell_ratio: number;
  buy_dominance: number;
  sell_dominance: number;
};

export type BidAskPoint = {
  aggregated_bids_usd: number;
  aggregated_bids_quantity: number;
  aggregated_asks_usd: number;
  aggregated_asks_quantity: number;
  time: number;
  bid_avg_price: number;
  ask_avg_price: number;
  spread_absolute: number;
  spread_percentage: number;
  total_volume: number;
  total_usd: number;
  bid_volume_dominance: number;
  ask_volume_dominance: number;
  bid_usd_dominance: number;
  ask_usd_dominance: number;
  volume_efficiency: number;
  market_depth_score: number;
  liquidity_quality: number;
  order_size_ratio: number;
};

export type InflowOutflowPoint = {
  aggregated_bids_usd: number;
  aggregated_bids_quantity: number;
  aggregated_asks_usd: number;
  aggregated_asks_quantity: number;
  time: number;
  inflow_dominance: number;
  outflow_dominance: number;
  flow_imbalance: number;
  total_liquidity: number;
  flow_momentum: number;
  liquidity_concentration: number;
  support_strength: number;
  resistance_strength: number;
};

export const DEFAULT_EXCHANGE_INFO = {
  name: "Binance",
  region: "Global",
  tier: "Tier 1",
  type: "Centralized",
};

const CRYPTO_INFO: Record<string, { name: string; category: string; tier: string }> = {
  BTC: { name: "Bitcoin", category: "Digital Currency", tier: "Tier 1" },
  ETH: { name: "Ethereum", category: "Smart Contract Platform", tier: "Tier 1" },
  SOL: { name: "Solana", category: "Smart Contract Platform", tier: "Tier 1" },
  BNB: { name: "BNB", category: "Exchange Token", tier: "Tier 1" },
  XRP: { name: "XRP", category: "Payments", tier: "Tier 1" },
  DOGE: { name: "Dogecoin", category: "Meme Coin", tier: "Tier 2" },
  ADA: { name: "Cardano", category: "Smart Contract Platform", tier: "Tier 1" },
  AVAX: { name: "Avalanche", category: "Smart Contract Platform", tier: "Tier 1" },
  DOT: { name: "Polkadot", category: "Interoperability", tier: "Tier 1" },
  LINK: { name: "Chainlink", category: "Oracle Network", tier: "Tier 1" },
};

export function cryptoInfo(symbol: string): { name: string; category: string; tier: string } {
  const upper = symbol.toUpperCase();
  return CRYPTO_INFO[upper] ?? { name: upper, category: "Cryptocurrency", tier: "Unknown" };
}

export function sortByTime<T extends { time: number }>(points: T[]): T[] {
  return [...points].sort((a, b) => a.time - b.time);
}

export function labelForTime(time: number, shortTerm: boolean): string {
  const date = new Date(time);
  return shortTerm
    ? date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export function compactSeries<T>(points: T[], limit = 120): T[] {
  if (points.length <= limit) return points;
  if (limit <= 2) return points.slice(-limit);
  const stride = Math.ceil(points.length / limit);
  return points.filter((_, index) => index % stride === 0).slice(-limit);
}

export function processTakerVolume(raw: JsonRecord[]): TakerVolumePoint[] {
  return sortByTime(
    raw.map((point) => {
      const buyVol = Number(point.aggregated_buy_volume_usd ?? 0);
      const sellVol = Number(point.aggregated_sell_volume_usd ?? 0);
      const totalVolume = buyVol + sellVol;
      return {
        aggregated_buy_volume_usd: buyVol,
        aggregated_sell_volume_usd: sellVol,
        time: Number(point.time ?? 0),
        total_volume: totalVolume,
        buy_sell_ratio: sellVol > 0 ? buyVol / sellVol : buyVol > 0 ? Number.POSITIVE_INFINITY : 0,
        buy_dominance: totalVolume > 0 ? (buyVol / totalVolume) * 100 : 0,
        sell_dominance: totalVolume > 0 ? (sellVol / totalVolume) * 100 : 0,
      };
    }),
  );
}

export function buildTakerVolumeContext(symbol: string, from: string, to: string, raw: JsonRecord[]): JsonRecord {
  const historicalData = processTakerVolume(raw);
  const latestData = historicalData[historicalData.length - 1] ?? {
    aggregated_buy_volume_usd: 0,
    aggregated_sell_volume_usd: 0,
    time: 0,
    total_volume: 0,
    buy_sell_ratio: 0,
    buy_dominance: 0,
    sell_dominance: 0,
  };
  const buyVolume = historicalData.reduce((sum, point) => sum + point.aggregated_buy_volume_usd, 0);
  const sellVolume = historicalData.reduce((sum, point) => sum + point.aggregated_sell_volume_usd, 0);
  const totalVolume = buyVolume + sellVolume;
  const buyDominance = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 0;
  const sellDominance = totalVolume > 0 ? (sellVolume / totalVolume) * 100 : 0;
  const buySellRatio = sellVolume > 0 ? buyVolume / sellVolume : buyVolume > 0 ? Number.POSITIVE_INFINITY : 0;
  const marketSentiment = buyDominance > 60 ? "BULLISH" : sellDominance > 60 ? "BEARISH" : "NEUTRAL";
  const dominantTrading = buyDominance > 60 ? "BUY DOMINATED" : sellDominance > 60 ? "SELL DOMINATED" : "BALANCED";

  const chartSeries = compactSeries(historicalData);
  return {
    symbol,
    from,
    to,
    exchange: "Binance",
    exchanges: ["Binance"],
    isMultiExchange: false,
    latestData,
    historicalData,
    analysis: {
      marketSentiment,
      dominantTrading,
      buyVolume,
      sellVolume,
      totalVolume,
      buyDominance,
      sellDominance,
      buySellRatio,
      avgVolume: historicalData.length > 0 ? totalVolume / historicalData.length : 0,
      cryptoInfo: cryptoInfo(symbol),
      exchangeInfo: { ...DEFAULT_EXCHANGE_INFO, count: 1, list: ["Binance"] },
    },
    chartData: {
      labels: chartSeries.map((point) => labelForTime(point.time, false)),
      buyVolumeData: chartSeries.map((point) => point.aggregated_buy_volume_usd),
      sellVolumeData: chartSeries.map((point) => point.aggregated_sell_volume_usd),
      ratioData: chartSeries.map((point) =>
        point.buy_sell_ratio === Number.POSITIVE_INFINITY ? 100 : Math.min(100, point.buy_sell_ratio),
      ),
    },
    dataPoints: historicalData.length,
  };
}

export function processBidAsk(raw: JsonRecord[]): BidAskPoint[] {
  return sortByTime(
    raw.map((point) => {
      const aggregatedBidsUsd = Number(point.aggregated_bids_usd ?? 0);
      const aggregatedBidsQuantity = Number(point.aggregated_bids_quantity ?? 0);
      const aggregatedAsksUsd = Number(point.aggregated_asks_usd ?? 0);
      const aggregatedAsksQuantity = Number(point.aggregated_asks_quantity ?? 0);
      const bidAvgPrice = aggregatedBidsQuantity > 0 ? aggregatedBidsUsd / aggregatedBidsQuantity : 0;
      const askAvgPrice = aggregatedAsksQuantity > 0 ? aggregatedAsksUsd / aggregatedAsksQuantity : 0;
      const spreadAbsolute = Math.abs(askAvgPrice - bidAvgPrice);
      const spreadPercentage = bidAvgPrice > 0 ? (spreadAbsolute / bidAvgPrice) * 100 : 0;
      const totalVolume = aggregatedBidsQuantity + aggregatedAsksQuantity;
      const totalUsd = aggregatedBidsUsd + aggregatedAsksUsd;
      const bidVolumeDominance = totalVolume > 0 ? (aggregatedBidsQuantity / totalVolume) * 100 : 50;
      const askVolumeDominance = 100 - bidVolumeDominance;
      const bidUsdDominance = totalUsd > 0 ? (aggregatedBidsUsd / totalUsd) * 100 : 50;
      const askUsdDominance = 100 - bidUsdDominance;
      const avgPriceWeighted = totalVolume > 0 ? totalUsd / totalVolume : 0;
      const midPoint = (bidAvgPrice + askAvgPrice) / 2;
      const volumeEfficiency = midPoint > 0 ? (avgPriceWeighted / midPoint) * 100 : 100;
      const volumeScore = Math.min(100, (totalVolume / 1000) * 10);
      const spreadScore = spreadPercentage < 0.1 ? 100 : Math.max(0, 100 - spreadPercentage * 20);
      const marketDepthScore = totalVolume > 0 ? (volumeScore + spreadScore) / 2 : 0;
      const balanceScore = 100 - Math.abs(bidVolumeDominance - 50) * 2;
      const tightnessScore = spreadPercentage < 0.05 ? 100 : Math.max(0, 100 - spreadPercentage * 50);
      return {
        aggregated_bids_usd: aggregatedBidsUsd,
        aggregated_bids_quantity: aggregatedBidsQuantity,
        aggregated_asks_usd: aggregatedAsksUsd,
        aggregated_asks_quantity: aggregatedAsksQuantity,
        time: Number(point.time ?? 0),
        bid_avg_price: bidAvgPrice,
        ask_avg_price: askAvgPrice,
        spread_absolute: spreadAbsolute,
        spread_percentage: spreadPercentage,
        total_volume: totalVolume,
        total_usd: totalUsd,
        bid_volume_dominance: bidVolumeDominance,
        ask_volume_dominance: askVolumeDominance,
        bid_usd_dominance: bidUsdDominance,
        ask_usd_dominance: askUsdDominance,
        volume_efficiency: volumeEfficiency,
        market_depth_score: marketDepthScore,
        liquidity_quality: (balanceScore + tightnessScore) / 2,
        order_size_ratio: bidAvgPrice > 0 && askAvgPrice > 0 ? bidAvgPrice / askAvgPrice : 1,
      };
    }),
  );
}

export function buildBidAskContext(symbol: string, from: string, to: string, raw: JsonRecord[]): JsonRecord {
  const historicalData = processBidAsk(raw);
  const latestData = historicalData[historicalData.length - 1] ?? processBidAsk([{}])[0]!;
  const bidVolume = latestData.aggregated_bids_quantity;
  const askVolume = latestData.aggregated_asks_quantity;
  const bidUsdAmount = latestData.aggregated_bids_usd;
  const askUsdAmount = latestData.aggregated_asks_usd;
  const avgMetric = (key: keyof BidAskPoint) =>
    historicalData.length > 0 ? historicalData.reduce((sum, point) => sum + Number(point[key] ?? 0), 0) / historicalData.length : 0;
  const trend = halfTrend(historicalData.map((point) => point.total_volume), 10, "VOLUME");
  const marketSentiment =
    latestData.bid_volume_dominance > 60 && latestData.spread_percentage < 0.1
      ? "STRONGLY BULLISH"
      : latestData.bid_volume_dominance > 55
        ? "BULLISH"
        : latestData.ask_volume_dominance > 60 && latestData.spread_percentage < 0.1
          ? "STRONGLY BEARISH"
          : latestData.ask_volume_dominance > 55
            ? "BEARISH"
            : "NEUTRAL";
  const avgOrderSizeBid = bidVolume > 0 ? bidUsdAmount / bidVolume : 0;
  const avgOrderSizeAsk = askVolume > 0 ? askUsdAmount / askVolume : 0;
  const avgOrderSize = (avgOrderSizeBid + avgOrderSizeAsk) / 2;
  const chartSeries = compactSeries(historicalData);

  return {
    symbol,
    from,
    to,
    exchange: "Binance",
    latestData,
    historicalData,
    analysis: {
      marketSentiment,
      volumeTrend: trend,
      bidVolume,
      askVolume,
      bidUsdAmount,
      askUsdAmount,
      avgBidPrice: latestData.bid_avg_price,
      avgAskPrice: latestData.ask_avg_price,
      spreadAbsolute: latestData.spread_absolute,
      spreadPercentage: latestData.spread_percentage,
      volumeDominance:
        latestData.bid_volume_dominance > 60
          ? "BID VOLUME DOMINANCE"
          : latestData.ask_volume_dominance > 60
            ? "ASK VOLUME DOMINANCE"
            : "BALANCED VOLUME",
      usdDominance:
        latestData.bid_usd_dominance > 60
          ? "BID USD DOMINANCE"
          : latestData.ask_usd_dominance > 60
            ? "ASK USD DOMINANCE"
            : "BALANCED USD",
      totalVolume: latestData.total_volume,
      totalUsd: latestData.total_usd,
      avgOrderSizeBid,
      avgOrderSizeAsk,
      marketDepthScore: avgMetric("market_depth_score"),
      liquidityQuality: avgMetric("liquidity_quality"),
      volumeEfficiency: avgMetric("volume_efficiency"),
      marketStructure: marketStructure(avgMetric("market_depth_score")),
      institutionalPresence: institutionalPresence(avgOrderSize),
      retailActivity: retailActivity(avgOrderSize),
      priceDiscovery: priceDiscovery(latestData.spread_percentage),
      cryptoInfo: cryptoInfo(symbol),
      exchangeInfo: DEFAULT_EXCHANGE_INFO,
    },
    chartData: {
      labels: chartSeries.map((point) => labelForTime(point.time, true)),
      bidVolumeData: chartSeries.map((point) => point.aggregated_bids_quantity),
      askVolumeData: chartSeries.map((point) => point.aggregated_asks_quantity),
      bidUsdData: chartSeries.map((point) => point.aggregated_bids_usd / 1_000_000),
      askUsdData: chartSeries.map((point) => point.aggregated_asks_usd / 1_000_000),
      spreadData: chartSeries.map((point) => point.spread_percentage),
      depthScoreData: chartSeries.map((point) => point.market_depth_score),
    },
    dataPoints: historicalData.length,
  };
}

export function processInflowOutflow(raw: JsonRecord[]): InflowOutflowPoint[] {
  const rows = raw.map((point) => ({
    aggregated_bids_usd: Number(point.aggregated_bids_usd ?? 0),
    aggregated_bids_quantity: Number(point.aggregated_bids_quantity ?? 0),
    aggregated_asks_usd: Number(point.aggregated_asks_usd ?? 0),
    aggregated_asks_quantity: Number(point.aggregated_asks_quantity ?? 0),
    time: Number(point.time ?? 0),
  }));
  return sortByTime(rows).map((point, index, points) => {
    const totalLiquidity = point.aggregated_bids_usd + point.aggregated_asks_usd;
    const inflowDominance = totalLiquidity > 0 ? (point.aggregated_bids_usd / totalLiquidity) * 100 : 50;
    const outflowDominance = totalLiquidity > 0 ? (point.aggregated_asks_usd / totalLiquidity) * 100 : 50;
    let flowMomentum = 0;
    let liquidityConcentration = 0;
    if (index > 0) {
      const previous = points[index - 1]!;
      const previousTotal = previous.aggregated_bids_usd + previous.aggregated_asks_usd;
      const previousDominance = previousTotal > 0 ? (previous.aggregated_bids_usd / previousTotal) * 100 : 50;
      flowMomentum = inflowDominance - previousDominance;
      if (index >= 3) {
        const previous3 = points[index - 3]!;
        const previous3Total = previous3.aggregated_bids_usd + previous3.aggregated_asks_usd;
        const dominance3 = previous3Total > 0 ? (previous3.aggregated_bids_usd / previous3Total) * 100 : 50;
        flowMomentum = (inflowDominance - dominance3) / 3;
      }
      liquidityConcentration = previousTotal > 0 ? (totalLiquidity / previousTotal) * 100 - 100 : 0;
    }
    return {
      ...point,
      inflow_dominance: inflowDominance,
      outflow_dominance: outflowDominance,
      flow_imbalance: Math.abs(point.aggregated_bids_usd - point.aggregated_asks_usd),
      total_liquidity: totalLiquidity,
      flow_momentum: flowMomentum,
      liquidity_concentration: liquidityConcentration,
      support_strength: totalLiquidity > 0 ? Math.min(100, (point.aggregated_bids_usd / totalLiquidity) * 200) : 0,
      resistance_strength: totalLiquidity > 0 ? Math.min(100, (point.aggregated_asks_usd / totalLiquidity) * 200) : 0,
    };
  });
}

export function buildInflowOutflowContext(symbol: string, from: string, to: string, raw: JsonRecord[]): JsonRecord {
  const historicalData = processInflowOutflow(raw);
  const latestData = historicalData[historicalData.length - 1] ?? processInflowOutflow([{}])[0]!;
  const avg = (key: keyof InflowOutflowPoint) =>
    historicalData.length > 0 ? historicalData.reduce((sum, point) => sum + Number(point[key] ?? 0), 0) / historicalData.length : 0;
  const avgFlowMomentum = avg("flow_momentum");
  const flowMomentum = latestData.flow_momentum;
  const volatilityIndicator =
    historicalData.length > 0
      ? Math.sqrt(historicalData.reduce((sum, point) => sum + (point.flow_momentum - avgFlowMomentum) ** 2, 0) / historicalData.length)
      : 0;
  const adjustedInflowDominance = latestData.inflow_dominance + (Math.abs(flowMomentum) > 2 ? (flowMomentum > 0 ? 5 : -5) : 0);
  const flowLabels = classifyFlow(adjustedInflowDominance, latestData.outflow_dominance);
  const chartSeries = compactSeries(historicalData);

  return {
    symbol,
    from,
    to,
    exchange: "Binance",
    latestData,
    historicalData,
    analysis: {
      marketSentiment: flowLabels.marketSentiment,
      dominantFlow: flowLabels.dominantFlow,
      inflowSupport: latestData.aggregated_bids_usd,
      outflowResistance: latestData.aggregated_asks_usd,
      flowImbalance: latestData.flow_imbalance,
      inflowDominance: latestData.inflow_dominance,
      outflowDominance: latestData.outflow_dominance,
      liquidityTrend: halfTrend(historicalData.map((point) => point.total_liquidity), 5, "LIQUIDITY"),
      avgLiquidity: avg("total_liquidity"),
      flowDirection: flowLabels.flowDirection,
      flowStrength: flowLabels.flowStrength,
      flowMomentum,
      liquidityConcentration: avg("liquidity_concentration"),
      supportStrength: avg("support_strength"),
      resistanceStrength: avg("resistance_strength"),
      flowPrediction:
        flowMomentum > 3
          ? "INCREASING INFLOW EXPECTED"
          : flowMomentum < -3
            ? "INCREASING OUTFLOW EXPECTED"
            : Math.abs(avgFlowMomentum) < 1
              ? "STABLE FLOW EXPECTED"
              : "MIXED SIGNALS",
      marketDepth: marketDepth(latestData.total_liquidity),
      volatilityIndicator,
      flowStability: flowStability(volatilityIndicator),
      cryptoInfo: cryptoInfo(symbol),
      exchangeInfo: DEFAULT_EXCHANGE_INFO,
    },
    chartData: {
      labels: chartSeries.map((point) => labelForTime(point.time, true)),
      inflowData: chartSeries.map((point) => point.aggregated_bids_usd / 1_000_000),
      outflowData: chartSeries.map((point) => point.aggregated_asks_usd / 1_000_000),
      liquidityData: chartSeries.map((point) => point.total_liquidity / 1_000_000),
      dominanceData: chartSeries.map((point) => point.inflow_dominance),
      momentumData: chartSeries.map((point) => point.flow_momentum),
    },
    dataPoints: historicalData.length,
  };
}

function halfTrend(values: number[], threshold: number, label: string): string {
  if (values.length < 2) return `STABLE ${label}`;
  const half = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, half);
  const secondHalf = values.slice(half);
  const firstAvg = firstHalf.reduce((sum, value) => sum + value, 0) / Math.max(firstHalf.length, 1);
  const secondAvg = secondHalf.reduce((sum, value) => sum + value, 0) / Math.max(secondHalf.length, 1);
  const change = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;
  if (change > threshold) return `INCREASING ${label}`;
  if (change < -threshold) return `DECREASING ${label}`;
  return `STABLE ${label}`;
}

function marketStructure(depth: number): string {
  if (depth > 80) return "EXCELLENT STRUCTURE";
  if (depth > 60) return "GOOD STRUCTURE";
  if (depth > 40) return "MODERATE STRUCTURE";
  return "WEAK STRUCTURE";
}

function institutionalPresence(orderSize: number): string {
  if (orderSize > 500_000) return "VERY HIGH INSTITUTIONAL";
  if (orderSize > 200_000) return "HIGH INSTITUTIONAL";
  if (orderSize > 50_000) return "MODERATE INSTITUTIONAL";
  return "LOW INSTITUTIONAL";
}

function retailActivity(orderSize: number): string {
  if (orderSize < 10_000) return "VERY HIGH RETAIL";
  if (orderSize < 50_000) return "HIGH RETAIL";
  if (orderSize < 200_000) return "MODERATE RETAIL";
  return "LOW RETAIL";
}

function priceDiscovery(spreadPercentage: number): string {
  if (spreadPercentage < 0.05) return "EXCELLENT DISCOVERY";
  if (spreadPercentage < 0.1) return "GOOD DISCOVERY";
  if (spreadPercentage < 0.5) return "MODERATE DISCOVERY";
  return "POOR DISCOVERY";
}

function classifyFlow(adjustedInflowDominance: number, outflowDominance: number): {
  marketSentiment: string;
  dominantFlow: string;
  flowDirection: string;
  flowStrength: string;
} {
  if (adjustedInflowDominance > 65) {
    return {
      marketSentiment: "STRONGLY BULLISH",
      dominantFlow: "Strong Inflow Potential with Momentum",
      flowDirection: "STRONG INFLOW FAVORED",
      flowStrength: "VERY STRONG",
    };
  }
  if (adjustedInflowDominance > 60) {
    return {
      marketSentiment: "BULLISH",
      dominantFlow: "Strong Inflow Potential",
      flowDirection: "INFLOW FAVORED",
      flowStrength: "STRONG",
    };
  }
  if (adjustedInflowDominance > 55) {
    return {
      marketSentiment: "SLIGHTLY BULLISH",
      dominantFlow: "Moderate Inflow Potential",
      flowDirection: "INFLOW FAVORED",
      flowStrength: "MODERATE",
    };
  }
  if (outflowDominance > 65) {
    return {
      marketSentiment: "STRONGLY BEARISH",
      dominantFlow: "Strong Outflow Potential with Momentum",
      flowDirection: "STRONG OUTFLOW FAVORED",
      flowStrength: "VERY STRONG",
    };
  }
  if (outflowDominance > 60) {
    return {
      marketSentiment: "BEARISH",
      dominantFlow: "Strong Outflow Potential",
      flowDirection: "OUTFLOW FAVORED",
      flowStrength: "STRONG",
    };
  }
  if (outflowDominance > 55) {
    return {
      marketSentiment: "SLIGHTLY BEARISH",
      dominantFlow: "Moderate Outflow Potential",
      flowDirection: "OUTFLOW FAVORED",
      flowStrength: "MODERATE",
    };
  }
  return {
    marketSentiment: "NEUTRAL",
    dominantFlow: "Balanced Flow Potential",
    flowDirection: "BALANCED",
    flowStrength: "NEUTRAL",
  };
}

function marketDepth(totalLiquidity: number): string {
  if (totalLiquidity > 100_000_000) return "VERY DEEP MARKET";
  if (totalLiquidity > 50_000_000) return "DEEP MARKET";
  if (totalLiquidity > 20_000_000) return "MODERATE DEPTH";
  return "SHALLOW MARKET";
}

function flowStability(volatilityIndicator: number): string {
  if (volatilityIndicator < 2) return "VERY STABLE";
  if (volatilityIndicator < 5) return "STABLE";
  if (volatilityIndicator < 10) return "MODERATE VOLATILITY";
  return "HIGH VOLATILITY";
}
