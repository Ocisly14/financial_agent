export const WHALE_ALERT_PROMPT: string =
  "Analyze the whale position data to identify dominant market actors and their directional bias. " +
  "Focus on position sizes, the long/short ratio, the top symbols by concentration, leverage levels, and liquidation risk proximity. " +
  "Highlight whether large players are net long or short, and identify any asymmetry that could signal an imminent move. " +
  "Consider total USD exposure and average position size when assessing systemic risk. " +
  "Conclude with a concise interpretation of what whale positioning implies for near-term price action.";

export const INFLOW_OUTFLOW_PROMPT: string =
  "Analyze the bid and ask history data to assess inflow and outflow pressure in the market. " +
  "Inflow dominance above 50% indicates more buy-side depth, while values below 50% signal sell-side pressure. " +
  "Examine the trend across the time series by comparing earlier and later data points to identify whether buying or selling pressure is increasing. " +
  "Note any sharp divergences between bids and asks that may indicate accumulation or distribution phases. " +
  "Summarize what the flow imbalance reveals about current market dynamics and potential price direction.";

export const TRANSACTION_VOLUME_PROMPT: string =
  "Analyze the taker buy and sell volume data to assess market conviction and directional momentum. " +
  "Buy dominance above 50% signals aggressive buying, while values below indicate sell pressure dominance. " +
  "Look at the trend across the period to identify whether buying or selling momentum is strengthening or fading. " +
  "Consider total volume in USD as a measure of overall market activity and participation. " +
  "Conclude with an assessment of whether the transaction volume data supports a bullish, bearish, or neutral near-term outlook.";

export const BID_ASK_VOLUME_PROMPT: string =
  "Analyze the bid and ask volume data to evaluate market depth and liquidity conditions. " +
  "The market depth score reflects how much buy-side depth exists relative to total order book volume. " +
  "The spread percentage reveals the cost of crossing the book and indicates how tight or wide liquidity is. " +
  "A high depth score with a tight spread suggests strong buy-side support, while a low score with a wide spread indicates fragile liquidity. " +
  "Interpret the data to assess whether current market structure favors buyers or sellers, and flag any notable liquidity imbalances.";

export const ADDRESS_TRANSACTION_PROMPT: string =
  "Analyze the on-chain transaction count and active address data to gauge network activity and user engagement. " +
  "Rising transaction counts indicate increasing on-chain usage, which often precedes or confirms price momentum. " +
  "Active address trends reveal whether the user base is growing or contracting, a key indicator of organic demand. " +
  "Compare the trend direction (first versus last period) to identify acceleration or deceleration in network activity. " +
  "Synthesize the on-chain metrics into a conclusion about whether fundamental network health supports or contradicts the current price environment.";
