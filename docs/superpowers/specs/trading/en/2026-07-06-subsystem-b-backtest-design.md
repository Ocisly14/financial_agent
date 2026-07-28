# Subsystem B: Backtest Engine (Macro-Concept Proposal)

Date: 2026-07-06
Status: Proposal (under review, concept level)
Parent spec: `2026-07-03-web3-strategy-loop-design.md`
Prerequisite: Subsystem A (SignalContext / StrategyEngine landed)
Scope: **Macro-concept level** — component boundaries, data flow, report shape only; no implementation detail.

---

## 1. Goals and Non-Goals

### Goals
1. Run historical **P&L backtests** on any `StrategyDSL`, reusing A's `StrategyEngine.evaluate` (single code source: backtest ≡ live).
2. Provide `HistoricalSignalContext` — the historical implementation of SignalContext, aligning price/TA/on-chain/sentiment on one timeline.
3. Build a **historical data cache/snapshot** so backtests reach deeper history, faster and more stable.
4. Fill simulation with **fees + slippage**, producing **standard metrics + a buy-and-hold benchmark**.
5. New `cex_backtest_strategy` tool so the agent can backtest a draft before deploying.
6. Provide a **parameter-sweep interface** for subsystem C's optimization loop.

### Non-Goals
- Generate→backtest→optimize loop, LLM structural edits → **subsystem C**.
- Portfolio/multi-symbol backtest → deferred.
- A's signal taxonomy and engine → not repeated here.

---

## 2. Component Boundaries and Data Flow

```
       ┌─────────────────────────────────────────────┐
       │            Historical data cache (new)        │
       │  collector → local snapshot store             │
       │  (price / on-chain / sentiment)               │
       └─────────────────────────────────────────────┘
                         │ read
                         ▼
       ┌─────────────────────────────────────────────┐
       │        HistoricalSignalContext               │  ← implements A's SignalContext interface
       │  (timeline alignment + mark "unavailable")   │
       └─────────────────────────────────────────────┘
                         │ valueOf(signalId, t)
                         ▼
       ┌─────────────────────────────────────────────┐
       │   Backtest Runner (port staging runner.ts)   │
       │  per time step: StrategyEngine.evaluate →     │
       │  OrderIntent → fill sim (fees+slippage) → P&L │
       └─────────────────────────────────────────────┘
                         │
                         ▼
       ┌─────────────────────────────────────────────┐
       │           BacktestReport                     │
       │  metrics + buy-and-hold benchmark +           │
       │  unbacktestable-signal labels                 │
       └─────────────────────────────────────────────┘
```

Four components, each single-purpose:

- **Historical data cache**: background-collects **price + on-chain + sentiment together** into a local snapshot, each source as deep as it allows; exposes only "series of a source over [t0,t1]". History depth is bounded by each source's limit.
- **HistoricalSignalContext**: implements A's `SignalContext`; owns §4 alignment semantics and the "unavailable" decision. Behaviorally aligned with `LiveSignalContext` → backtest = live.
- **Backtest Runner**: pure compute loop driving `StrategyEngine.evaluate`; fills go through the fee/slippage model + reuse riskEngine. Ports staging `backtest/runner.ts` + `indicators.ts`.
- **BacktestReport**: see §3.

---

## 3. Report Shape (BacktestReport)

- **Standard metrics**: total return, Sharpe, max drawdown, win rate, trade count, avg holding time, exposure.
- **Benchmark**: same-window **buy-and-hold** return, giving **excess return** (strategy − hold). The preferred objective function for C's optimization loop.
- **Equity curve**: produced this round, for humans/frontend to see drawdown shape, and for C to reference.
- **Unbacktestable signals**: `unbacktestable_signals[]` — signals the strategy uses but that lack history, explicitly labeled (top-level "degraded backtest + explicit labeling").
- **Per-trade detail**: **deferred** (not this round), added when needed.

---

## 4. Timeline Alignment (the hardest seam)

- **Information-fidelity contract (hard constraint, inherits top-level §7)**: `valueOf(id, t)` may only return the value **genuinely available at t** — never a future value. History is built from "what was observed then," not by backfilling final values. On-chain/sentiment are high-risk (publication lag + after-the-fact revision), else lookahead bias lets the optimizer optimize toward a cheat channel. The concrete mechanism (forward-recording / lag field / versioned snapshots) is settled in this subsystem's plan phase; the concept level only pins down "never use future values."
- Sources differ in frequency (klines minute-level, on-chain hourly, sentiment daily). `HistoricalSignalContext` defines each source's **value semantics** (forward-fill vs reject) and **availability window**.
- A signal with no data at some t → `valueOf` returns "unavailable"; StrategyEngine handles it per A's contract (unavailable comparison is false).
- Live `LiveSignalContext` uses the same "missing = unavailable" semantics → backtest consistent with live.

---

## 5. Fill Fidelity

- **Fees**: maker/taker tiers, aligned with the paper venue.
- **Slippage**: fixed bps to start, with a slot reserved for a volatility/depth-based model.
- Backtest fills also pass **riskEngine** (same risk as live).
- Eval ⑤: same input (incl. fee/slippage params) backtested twice → bit-identical metrics.

---

## 6. Parameter-Sweep Interface (for C)

- Provides "fix strategy structure, iterate a given parameter grid → batch backtest → return each set's metrics".
- B only **runs the sweep and returns results**; "which to pick, whether to continue, how the LLM edits structure" is C's orchestration job.

---

## 7. Settled Concept Decisions

1. **Report granularity**: summary metrics + buy-and-hold benchmark + **equity curve**; per-trade detail deferred.
2. **Collection scope**: price + on-chain + sentiment **collected together**, each source as deep as it allows.
3. **Range and step**: step = **the strategy's finest signal frequency** (1m if it has minute-level signals, daily if purely daily); default range a reasonable value (e.g. last 90 days) and overridable. Aligned with live evaluation frequency, compute cost self-adapts.

---

## 8. Delivery Boundary (B done means)

Given a strategyDSL + range → get a BacktestReport with standard metrics and a buy-and-hold benchmark; unbacktestable signals are labeled; the agent can backtest before deploying via `cex_backtest_strategy`; the parameter-sweep interface is ready for C. **The optimization loop does not yet exist (C).**
