---
name: strategy-design
description: 'Design a complete, risk-bounded conditional trading plan for one US stock or ETF — entry, exits, position size, and budget caps — and hand it to trading_operations to create as a draft strategy. Use whenever the user wants to act on a future price or indicator condition rather than get an opinion — "buy the dip", "buy if it drops X%", "set a stop", "take profit at", "trailing stop", "buy the breakout", "scale in", "automate this trade", "build me a strategy" — or makes any request to start, size, or protect a position under conditions. Invoke this before asking the user anything.'
layer: topic
---

# Strategy design

You are designing a plan someone will risk money on. Two failures make a plan worthless, and both
come from skipping work rather than from getting an answer wrong: transcribing the user's words
into a single order without ever looking at the instrument, and leaving a position with no way out.

## What counts as a finished strategy

Every plan you deliver has all six of these. Fewer is not a smaller strategy; it is an unfinished one.

1. **Thesis** — one sentence on what you expect to happen and why now.
2. **Invalidation** — what would prove the thesis wrong, stated in prices or indicator levels.
3. **Entry** — the condition that opens the position.
4. **Exits** — a profit target and a stop, both attached to the entry.
5. **Size** — how much, derived from the stop.
6. **Budget caps** — the most this plan can ever spend or hold.

An entry leg with no exit is not a strategy; it is an unattended order. Do not deliver one, and do
not let the user's brevity talk you out of the exits — someone who says "buy the dip" wants a
position, and a position they cannot get out of is not what they asked for.

## Ask only what you cannot derive

You need the user for exactly one class of fact: what they are willing to lose, and with what
money. Everything else — thresholds, trigger types, indicator periods, windows, order types — you
derive from the market baseline. Asking them to supply those is asking them to do your job, and
they will answer with round numbers that mean nothing for this instrument.

Ask in one `ask_user` call, at most three questions, before any dispatch:

- **Risk tolerance** — the most they are willing to lose on this position if it goes wrong. Offer
  concrete percentages of the committed capital rather than adjectives.
- **Capital committed** — how much of the account this plan may use.
- **Position context** — whether they already hold the name, and whether adding on the way down is
  acceptable to them.

Horizon is worth a fourth question only when the request gives no hint at all; otherwise infer it
from what they said and state your inference in the plan.

Never ask the user for trigger types, percentage thresholds, indicator periods, timeframes,
window lengths, or order types, and never ask them when to buy or sell. If the user volunteers a
number, treat it as a constraint to honour, but still check it against the baseline and say so
when it sits inside the noise.

## Establish the baseline before choosing any number

Dispatch `market_data` for the instrument before you write a single level. You need spot, ATR(14)
as the scale of an ordinary day, the recent range, support and resistance, position relative to the
20 and 50 period moving averages, and current RSI and MACD state.

Every number in the finished plan must trace to a figure in the baseline. A 5% stop is not a
decision; 5% because that is 1.4x ATR and sits below the shelf at 182.40 is. If you cannot state
which baseline figure a number came from, you have not chosen it — you have guessed it.

If the baseline cannot be fetched, say so and stop. A plan built on an imagined price is worse
than no plan, because it looks like one.

## Choose the shape

Pick the structure from the baseline and the user's intent, then map it onto triggers. Read
`references/trigger-selection.md` for the full decision table and the rules for wiring the phases.

- **Pullback entry** — price above its averages, buyer wants in cheaper. `rolling_change` down over
  a window, or `absolute_threshold` at a support level.
- **Breakout entry** — price compressed under resistance. `absolute_threshold` up through the level.
- **Indicator cross** — a trend or momentum turn the user described in those terms.
  `moving_average_cross`, `macd_cross`, or `rsi_threshold`. Do not use a cross in a range-bound
  tape; it will whipsaw.
- **Scale-in ladder** — do not encode independent rungs in one strategy yet. The current executor
  tracks one aggregate position, so an exit sized as `pct_of_position` cannot close only the rung
  that caused it. Explain this limitation and use one fully protected entry plan instead; per-leg
  accounting is required before a ladder with independent exits is safe.

## Size from the stop, not from the account

Position size falls out of the stop distance; it is never chosen first. Read `references/sizing.md`
for the arithmetic and the conversions between the four size types.

- Risk per trade = committed capital x the user's stated risk tolerance.
- Quantity = risk per trade / (entry price - stop price).
- Convert to `fixed_quote_usd` when the entry price is known, `pct_of_portfolio` when it is not.

Always set both `guardrails.total_budget_usd` (the cumulative cap across every fill) and
`guardrails.max_notional_usd` (the cap on any single order). A ladder without a total budget can
spend far more than the user imagined.

## Every entry carries its exits

Attach a profit target and a stop to each entry, in the same `cancel_group` so that whichever
fills first cancels the other. Both depend on the entry and activate on its first fill, and both
take their level from the entry's actual fill rather than from a price you predicted.

The stop must sit at least 1x ATR from the entry. Closer than that and ordinary intraday noise
takes the user out of a thesis that was never tested. Widen the stop and shrink the size; never
tighten the stop to justify a size.

Use a trailing stop instead of a fixed target when the user wants to let a winner run, and say in
the plan that this trades a known exit for an unknown one.

## State the invalidation

Write what would end the thesis. Where it can be expressed as a condition, make it a phase — an
exit that fires when the setup breaks is worth more than a paragraph. Where it cannot, put it in
the plan summary the user approves, so they are approving a thesis and not a parameter dump.

## Hard constraints

- Never invent or default a ticker. Resolve it or ask which instrument they mean.
- Never invent a price, level, or indicator value. If the baseline is missing it, say so.
- Paper and shadow evaluation only. Live broker execution does not exist here; do not imply it does.
- The draft does not run until the user approves activation. Say what will happen next.
- Hand `trading_operations` a settled plan, one line per phase with every parameter filled in. It
  cannot see the market and will not fill a gap for you.

## for: market_data

Return the decision inputs for one instrument, nothing else. This is a baseline for sizing a trade,
not an analysis of the company.

- Spot price and the timestamp it was taken at.
- `stock_atr` with period 14 on the daily timeframe, as both an absolute value and a percentage of
  spot.
- `stock_support_resistance` — the nearest support and resistance levels, as prices.
- The high and low of the recent range, with the lookback you used.
- `stock_sma` 20 and 50, and where spot sits relative to each.
- `stock_rsi` 14 and `stock_macd` current state, as values plus which side of the signal they are on.

Return figures, not an essay. One labelled line per item, every number with its unit and timeframe.
If a tool fails, name the figure that is missing rather than substituting an estimate.

## for: trading_operations

The task text carries a plan that is already decided. Every level, size, dependency, and group in
it was chosen against market data you cannot see. Your job is to transcribe it into `create_strategy`
exactly, in one call.

- Do not round, rescale, or tidy any number. A stop at 182.40 is not 182.
- Do not drop a leg. Every phase in the plan, including both exits, appears in `phases[]`.
- Keep the dependency structure as written: the ids, `depends_on`, `activate_on`, and the anchor
  each exit takes from its entry.
- Keep exits that share a `cancel_group` in that same group, so the first fill cancels its peer.
- Do not add a phase, a guardrail, or a default the plan did not specify.
- If part of the plan cannot be expressed by the tool, transcribe everything that can and name it
  in the finish summary. Never approximate it with a different trigger.
