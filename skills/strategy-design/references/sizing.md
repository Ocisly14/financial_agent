# Sizing and budget caps

Size is an output of the stop, never an input. Choosing a size first and then placing a stop where
it "feels right" means the loss is whatever the market decides.

## The arithmetic

1. **Risk per trade** = committed capital x risk tolerance.
   $40,000 committed at 2% tolerance -> $800 at risk.
2. **Stop distance** = entry price - stop price (absolute, per share).
   Entry 187.00, stop 182.40 -> $4.60.
3. **Quantity** = risk per trade / stop distance.
   $800 / $4.60 -> 173 shares.
4. **Notional** = quantity x entry price.
   173 x $187.00 -> $32,351.

If the notional exceeds the committed capital, the stop is too tight for the risk budget, not the
other way round. Widen the stop to the next structural level and recompute. Never shrink the stop
to make a size fit.

## Converting to a size type

`action.size` takes one of four types. Pick by what you actually know at design time.

| Type | Use when | Value means |
| --- | --- | --- |
| `fixed_quote_usd` | The entry price is known (a threshold or a level) | Dollars to spend on this fill |
| `fixed_base_qty` | The share count is the point (an existing lot) | Number of shares |
| `pct_of_portfolio` | The entry price is unknown at design time | Percent of portfolio value |
| `pct_of_position` | Exiting part of what is held | Percent of the current position |

Exits that close the whole position use `pct_of_position` with value 100. A partial target that
takes half off uses value 50, and the remaining stop still covers what is left.

Do not encode a multi-rung ladder in one strategy yet. The executor's `pct_of_position` exit size
refers to the whole strategy position, not a particular rung, so independent exits can close or
leave exposed the wrong shares. Per-leg position accounting is required before that plan is safe.

## Budget caps

Set both guardrails on every strategy. They are the backstop for a plan that behaves differently
from how it was imagined.

- `total_budget_usd` — the cumulative cap across every fill the strategy will ever make. For a
  ladder this is the sum of the rungs; for a single entry it is that notional. A recurring phase
  without this cap can spend indefinitely.
- `max_notional_usd` — the cap on any one order. Normally the largest single rung, with a little
  headroom for the slippage between the trigger and the fill.

## Worked example

$40,000 committed, 2% risk tolerance, ATR(14) = $3.20 on a $187 stock (1.7% of spot), nearest
support $182.40.

- Risk per trade: $40,000 x 2% = $800.
- Stop below support at $182.40, which is 1.44x ATR from a $187.00 entry — clear of ordinary noise.
- Stop distance: $4.60. Quantity: 173 shares. Notional: $32,351.
- Entry is a limit at a known price, so `fixed_quote_usd` with value 32351.
- Target at $196.20, the prior range high, giving 2.0x the risk taken.
- `total_budget_usd` 32500, `max_notional_usd` 32500.

Half that risk tolerance and everything halves with it: $400 at risk, 86 shares, $16,082 notional.
The stop does not move, because the stop is a fact about the instrument and the risk tolerance is a
fact about the user.
