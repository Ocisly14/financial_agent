# Choosing triggers, and three complete plans

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

## Plan 1 — Pullback entry with OCO exits

One entry at support with a target and stop anchored to its actual fill. They share a cancel group,
so the first one out closes the complete position and cancels the other.

```json
{
  "name": "AAPL pullback",
  "symbol": "AAPL",
  "mode": "paper",
  "guardrails": { "total_budget_usd": 25000, "max_notional_usd": 25000 },
  "phases": [
    {
      "id": "entry",
      "name": "Pullback to support",
      "depends_on": [],
      "price_trigger": { "type": "absolute_threshold", "direction": "down", "price": 182.4 },
      "action": { "side": "BUY", "size": { "type": "fixed_quote_usd", "value": 25000 } },
      "recurrence": { "mode": "one_shot" }
    },
    {
      "id": "target",
      "name": "Pullback target",
      "depends_on": ["entry"],
      "activate_on": "first_fill",
      "cancel_group": "exit",
      "price_anchor": { "type": "phase_fill", "phase_id": "entry" },
      "price_trigger": { "type": "relative_change", "direction": "up", "pct": 6 },
      "action": { "side": "SELL", "size": { "type": "pct_of_position", "value": 100 } },
      "recurrence": { "mode": "one_shot" }
    },
    {
      "id": "stop",
      "name": "Pullback stop",
      "depends_on": ["entry"],
      "activate_on": "first_fill",
      "cancel_group": "exit",
      "price_anchor": { "type": "phase_fill", "phase_id": "entry" },
      "price_trigger": { "type": "relative_change", "direction": "down", "pct": 3 },
      "action": { "side": "SELL", "size": { "type": "pct_of_position", "value": 100 } },
      "recurrence": { "mode": "one_shot" }
    }
  ]
}
```

The exit sizes are 100% because `pct_of_position` addresses the strategy's whole position, not an
individual entry leg. A multi-rung plan needs per-leg position accounting before it can safely give
each rung an independent OCO pair.

## Plan 2 — Breakout with a trailing stop

No fixed target: the user wants the move to run. The trailing stop is the only exit, so it does not
need a cancel group.

```json
{
  "name": "NVDA breakout",
  "symbol": "NVDA",
  "mode": "paper",
  "guardrails": { "total_budget_usd": 20000, "max_notional_usd": 20000 },
  "phases": [
    {
      "id": "breakout",
      "name": "Break of the range high",
      "depends_on": [],
      "price_trigger": { "type": "absolute_threshold", "direction": "up", "price": 194.5 },
      "action": { "side": "BUY", "size": { "type": "fixed_quote_usd", "value": 20000 } },
      "recurrence": { "mode": "one_shot" }
    },
    {
      "id": "trail",
      "name": "Trailing stop from the high since entry",
      "depends_on": ["breakout"],
      "activate_on": "first_fill",
      "price_anchor": { "type": "phase_fill", "phase_id": "breakout" },
      "price_trigger": { "type": "trailing_stop", "direction": "down", "pct": 4 },
      "action": { "side": "SELL", "size": { "type": "pct_of_position", "value": 100 } },
      "recurrence": { "mode": "one_shot" }
    }
  ]
}
```

## Plan 3 — Indicator cross with OCO exits

The entry is the momentum turn the user described. A fixed target and stop are both anchored to
the actual cross fill, so either one closes the complete position and cancels the other.

```json
{
  "name": "SPY momentum turn",
  "symbol": "SPY",
  "mode": "paper",
  "guardrails": { "total_budget_usd": 18000, "max_notional_usd": 12000 },
  "phases": [
    {
      "id": "cross",
      "name": "MACD turns up on the daily",
      "depends_on": [],
      "price_trigger": { "type": "macd_cross", "direction": "bullish", "timeframe": "1Day" },
      "action": { "side": "BUY", "size": { "type": "fixed_quote_usd", "value": 12000 } },
      "recurrence": { "mode": "one_shot" }
    },
    {
      "id": "target",
      "name": "Target above the cross",
      "depends_on": ["cross"],
      "activate_on": "first_fill",
      "cancel_group": "exit",
      "price_anchor": { "type": "phase_fill", "phase_id": "cross" },
      "price_trigger": { "type": "relative_change", "direction": "up", "pct": 5 },
      "action": { "side": "SELL", "size": { "type": "pct_of_position", "value": 100 } },
      "recurrence": { "mode": "one_shot" }
    },
    {
      "id": "stop",
      "name": "Stop below the cross",
      "depends_on": ["cross"],
      "activate_on": "first_fill",
      "cancel_group": "exit",
      "price_anchor": { "type": "phase_fill", "phase_id": "cross" },
      "price_trigger": { "type": "relative_change", "direction": "down", "pct": 2.5 },
      "action": { "side": "SELL", "size": { "type": "pct_of_position", "value": 100 } },
      "recurrence": { "mode": "one_shot" }
    }
  ]
}
```

This strategy intentionally does not add after entry. A separately activated add can remain live
after a one-shot stop has closed the original position; the current phase model has no safe way to
cancel that add without also cancelling its protection. Keep it as a new, fully protected plan
instead of silently reopening a stopped-out trade.
