# Technical and Market-Structure Playbook

Use technical evidence to describe trend, momentum, volatility, participation, and positioning context. Do not use it to prove fundamental value or forecast an exact price.

## Match the timeframe to the horizon

- Use `1Day` as the baseline for a 1-3 month tactical view and for context around a 6-12 month thesis.
- Add `15Min` or `60Min` only when the user asks about an entry window, an event reaction, or current-session structure.
- The tools do not provide aggregated weekly or monthly bars. Never request unsupported timeframes or describe daily data as weekly data.

Return the timeframe, parameter set, bar count, and as-of timestamp with each observation.

## Interpret indicators

### Moving averages

Use the moving averages already returned by `get_stock_price` before making extra calls. Price above or below an average describes trend state, not intrinsic value. Distinguish a recent cross from a mature trend when the returned history supports that distinction.

### RSI

Use period 14 by default. Values above 70 or below 30 describe strong recent momentum and stretched conditions; they are not automatic reversal signals. Report divergence only when price and RSI series support it and a second relevant timeframe confirms it.

### MACD

Use 12-26-9 by default. Treat the histogram as momentum acceleration or deceleration. Crosses are noisy in range-bound markets, so interpret them alongside trend and price structure.

### Bollinger Bands

Use 20 periods and two standard deviations by default. A band touch is not a buy or sell signal. Bandwidth contraction describes suppressed volatility; it does not predict breakout direction.

### ATR

Use period 14 by default. ATR measures movement magnitude, not direction. Express it as a percentage of a sourced current price only when that percentage is returned by a tool or deterministic calculation; otherwise report the raw value and price separately.

### OBV and volume

Use OBV slope and its agreement or disagreement with price. Its absolute level has no standalone meaning. Describe current volume only when the quote result includes it, and do not infer institutional activity from volume alone.

### VWAP

An unparameterized call produces a cross-day cumulative VWAP and is not a current-session reference. For intraday VWAP, specify a minute timeframe and limit `history_bars` to bars elapsed in the current session.

### Support and resistance

Treat returned levels as historical price-clustering zones. Include the level type and `pivot_lookback`. Do not invent touch counts, breakout odds, or stop-loss instructions.

## Resolve conflicts

State technical conflicts rather than scoring them away:

- long-term trend positive, short-term momentum deteriorating;
- relative sector strength positive, stock absolute trend negative;
- price advancing, OBV weakening;
- bullish momentum, volatility expanding; or
- fundamental catalyst confirmed, price response absent or negative.

Describe what new observation would resolve each conflict. A technical break can lower tactical confidence without invalidating a fundamental thesis unless it coincides with fundamental evidence.
