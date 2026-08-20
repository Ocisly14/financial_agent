# Choosing triggers and wiring the phases

## Decision table

| The condition you decided on | Trigger | Notes |
| --- | --- | --- |
| A move of X% within Y minutes | `rolling_change` | Needs `window_minutes`. The only trigger that measures speed rather than level. |
| Price reaches a level | `absolute_threshold` | Use for support, resistance, and any level read off the chart. |
| A move of X% from an earlier fill | `relative_change` | Anchor it to the entry phase; this is how targets and stops are built. |
| Give back X% from the best price since entry | `trailing_stop` | Anchor to the entry. Trades a known exit for an unknown one. |
| RSI crosses a level | `rsi_threshold` | Momentum exhaustion or confirmation. |
| MACD turns | `macd_cross` | Trend change with a lag. Poor in a range. |
| Fast average crosses slow | `moving_average_cross` | Trend confirmation. Whipsaws badly in a range. |

Two rules the table cannot show:

- A condition the user stated in indicator terms stays an indicator trigger. Converting "buy when
  RSI drops below 30" into a price threshold silently changes what was asked for.
- A cross trigger in a range-bound tape fires repeatedly and loses on each one. Check the baseline
  for a trend before choosing one.

## Entry shapes

The baseline decides the shape; the shape decides the entry trigger and what the exits can be.

| Shape | When the baseline supports it | Entry trigger | Exits it admits |
| --- | --- | --- | --- |
| Pullback | Price above its averages, buyer wants in cheaper | `absolute_threshold` down at a support level, or `rolling_change` down over a window | Target and stop as an exclusive pair |
| Breakout | Price compressed under resistance | `absolute_threshold` up through the level | A lone trailing stop when the move should run, or a target and stop pair |
| Indicator turn | The user described the entry in indicator terms, and the tape trends | `rsi_threshold`, `macd_cross`, or `moving_average_cross` | Target and stop as an exclusive pair |

## Wiring the phases

Every phase of a plan goes in the single `phases[]` array of one `create_strategy` call. The
structure, not the order of the array, decides what runs when.

- **The entry is a root phase.** No `depends_on`, so it monitors from the moment the strategy is
  activated.
- **Every exit depends on the entry** and sets `activate_on: "first_fill"`, so it starts watching
  only once there is a position to protect.
- **An exit takes its level from the fill, never from a predicted price.** Give it a `price_anchor`
  of type `phase_fill` naming the entry's id, then express the distance as `relative_change` or
  `trailing_stop`. Writing the level as an `absolute_threshold` computed by hand bakes in a fill
  price the market never had to honour.
- **Exits that must not both fire share one `cancel_group`.** The first to fill cancels its peer.
  A single exit — a lone trailing stop — needs no group, because there is nothing to cancel.
- **`recurrence.mode` is `one_shot`** for an entry and its exits. Use `recurring` only when the plan
  genuinely re-arms after firing, and cap it with `max_triggers`.
- **`mode` is `paper` or `shadow`**, and both `guardrails.total_budget_usd` and
  `guardrails.max_notional_usd` are set on every plan.

A phase referred to by another phase needs a stable `id`. Name ids for their role in the plan, so a
dependency reads as a sentence rather than as a pair of opaque strings.

## Two structural limits

Both come from the executor, not from style. Neither is negotiable by writing the plan differently.

**Exit sizing addresses the whole position.** `pct_of_position` is a percentage of the strategy's
aggregate position, not of the entry leg that caused the exit. So an exit that is meant to close the
trade uses the full position, and a multi-rung ladder cannot give each rung an independent exclusive
pair — a stop belonging to one rung would close every other rung with it. Per-leg position
accounting is required before a ladder like that is safe; until then, deliver one fully protected
entry instead and say why.

**A plan does not add after its entry.** An add activated independently of the exits can still be
live after a one-shot stop has closed the original position, and the phase model has no way to
cancel that add without also cancelling the protection around it. A later addition belongs in a new,
fully protected plan rather than in a leg that can silently reopen a stopped-out trade.
