# Web3 Trading Agent: Strategy-Generation Enhancement + Backtest + Feedback Loop (Top-Level Architecture)

Date: 2026-07-03
Status: Proposal (under review)
Scope: Top-level architecture. This doc only aligns the **interfaces, data flow, safety boundaries, and decomposition** of the three subsystems; it does not cover implementation detail. Each subsystem gets its own spec.

---

## 1. Goals and Non-Goals

### Goals
1. **Enhance strategy generation**: let the agent generate strategies that are no longer limited to 3 pure-price triggers, but combine **technical (TA) + on-chain + sentiment** signals — genuinely web3-native strategies.
2. **Add backtesting**: run real historical P&L backtests on any draft strategy, producing standardized metrics (total return / Sharpe / max drawdown / win rate / trade count / exposure).
3. **Add a feedback loop (pre-deployment "generate → backtest → optimize" inner loop)**: after the agent generates a strategy it **auto-runs a backtest**, then optimizes that strategy from the report (parameter sweep + LLM structural edits), iterating until a target metric is met or it stops improving, then deploys. This is the **core** of the loop this round; post-live reflection into memory is a secondary supplement. paper/shadow candidates may auto-deploy; promotion to live must pass the human approval gate.

### Non-Goals (explicitly out this round)
- No model retraining/fine-tuning; the loop uses **backtest-as-judge + linguistic feedback + memory retrieval** (QuantAgent writer/judge + Reflexion / FinMem lineage), no weight updates.
- No fully-autonomous evolution to live (QuantEvolve-style live self-evolution) — live is always human-approved.
- No portfolio-level (multi-symbol) backtest/optimization; single-symbol single-strategy this round, portfolio deferred.
- No change to the semantics of the existing 15 risk rules; no change to the approval safety invariant.

---

## 2. Design Decisions (settled with the user)

| Decision | Conclusion |
|---|---|
| Sequencing | Ship this top-level spec first, then split into 3 sub-specs each running design→plan→implementation |
| Signal scope | Price + technical indicators + on-chain/sentiment (full, web3-native) |
| Loop shape | **Pre-deployment inner loop**: generate → auto-backtest → optimize → re-backtest. Core is backtest-driven iterative optimization, not post-live periodic reflection |
| Optimization driver | Dual: **parameter sweep** (grid search for numeric optima, deterministic) + **LLM structural edits** (read the report, swap signals / add stops / change logic) |
| Stopping condition | Metric target met (e.g. Sharpe > threshold / drawdown < threshold) **or** no meaningful improvement for K rounds → stop; plus a **hard round cap** to prevent infinite loops |
| Loop autonomy | paper/shadow may auto-deploy candidates; promotion to live **must** be human-approved. Live safety invariant fully preserved |
| Backtest fidelity | Fills charge **fees (maker/taker) + a slippage model**, aligned with the paper venue, so numbers are trustworthy |
| Granularity | **Single-symbol single-strategy**; portfolio deferred |
| Missing data | If a signal lacks history in the backtest window → **degraded backtest + explicit labeling** as "not backtestable", never silently fabricate |
| Backtest principle | **Single code source** — backtest, live monitor, and eval-replay share one signal+trigger+execution evaluation core. "Backtest passes" ≡ "this is how it runs live" |
| Information fidelity | Backtest uses only info **genuinely available at the time**, never future values; history built from "what was observed then," not backfilled final values (see §7, C §4) |
| Validation methodology | **Walk-forward rolling validation** + parameter plateau (robust-max) + embargo + trial-count deflation (Deflated-Sharpe); coarse-to-fine grid tuning, dimensionality hard-capped (see C §4) |
| Deployment object | This round deploys a **frozen** strategy (params fixed once, zero auto-change); re-optimization = a human re-runs the loop, new version's live promotion gated. Decay measurement + backtest-distribution invalidation lines as kill-switch (see C §7) |

---

## 3. Current State and Gaps (from reading the code)

**The running strategy engine** (`mcp_tools/trading/strategy/priceStrategy.ts`): supports only `rolling_change` / `absolute_threshold` / `trailing_stop` — pure-price triggers. Driven by `strategyMonitor.ts` background polling.

**Written but not wired into the runtime** (`strategyDSL.ts`): defines `price.rsi` / `sma_cross` / `ema_cross` / `atr_band` / `volume.zscore` / `sentiment.score` signals + entries/exits/risk — the monitor **never executes** them. This is the biggest ready-made gap for "enhance generation".

**Reusable infra**:
- The eval suite's candle-replay harness (`scripts/eval/lib/replay.ts`): runs the **real** trigger logic candle-by-candle, but only validates trigger correctness, **not P&L**.
- Risk engine (15 rules), paper venue, cost-basis accounting, approval gate — all in place.
- Memory note: the staging repo `financial-agent-0428@staging` has a same-lineage `backtest/runner.ts` + `indicators.ts` to port (see `memory/auto-trading-strategy-reuse-source.md`).
- On-chain tools (whale / net in-outflow / tx volume) and a sentiment source (fear & greed) exist and can serve as historical signal data sources.

**Gaps**: real P&L backtesting; any feedback loop; execution of TA/on-chain/sentiment signals.

---

## 4. Core Skeleton: SignalContext + StrategyEngine

Two new abstractions shared by all three subsystems. This is the foundation.

### 4.1 `SignalContext` — unified signal view

An interface that resolves, at a timestamp, all signal values needed for one evaluation:

```
SignalContext.at(t) → {
  price, ohlc,                                  // price (existing sources)
  ta:       { rsi, sma, ema, atr, vol_zscore }, // computed from klines (port indicators)
  onchain:  { whale_netflow, exchange_inflow, exchange_outflow, tx_volume },
  sentiment:{ fear_greed }
}
```

Two implementations, **same interface**:
- `LiveSignalContext`: pulls live price/on-chain/sentiment — used by the monitor.
- `HistoricalSignalContext`: backfills and aligns historical series along a timeline — used by backtest.

**Payoff**: signal evaluation is written once; backtest = live = eval run the same code; the dormant TA signals in `strategyDSL.ts` finally get activated.

### 4.2 `StrategyEngine.evaluate(dsl, ctx, state) → decision`

A pure core: given the strategy DSL, a SignalContext at some time, and runtime state (confirm counts / trigger history / positions), returns "did it trigger, what order". Driven by all three:

```
                ┌──────────────────────────────┐
                │   StrategyEngine.evaluate     │  ← single source of signal+trigger+execution decisions
                └──────────────────────────────┘
                  ▲            ▲            ▲
        LiveSignalContext  HistoricalCtx  ReplayCtx
                  │            │            │
             monitor(live)   backtest      eval-replay
```

**Payoff**: signal evaluation written once; backtest = live = eval run the same code; the sleeping TA signals in `strategyDSL.ts` are truly activated.

---

## 5. The Three Subsystems

### Subsystem A — Strategy-Generation Enhancement
- Wire TA / on-chain / sentiment signals into the runtime as **first-class trigger conditions** (unify the `priceStrategy` trigger path with the `strategyDSL` signal definitions, ending the two-DSL split).
- Extend the `cex_create_strategy` tool schema + trade-subagent prompt so the model can express compound conditions like "buy when RSI<30 AND exchange net-outflow > X".
- Extend the NL→DSL eval dataset (existing eval ①) to cover new signal types, guarding generation fidelity against regressions.

**Interface contract**: output is still one valid `StrategyDSL`, directly evaluable by StrategyEngine.

### Subsystem B — Backtest Engine
- Port/adapt staging's `backtest/runner.ts` + `indicators.ts`, driving `StrategyEngine.evaluate` over `HistoricalSignalContext`.
- Fill simulation reuses the existing **paperVenue + riskEngine** (risk applies in backtest too), plus **fees (maker/taker) + a slippage model**.
- Produce standardized (FinRL-style) metrics: total return, Sharpe, max drawdown, win rate, trade count, avg holding time, exposure.
- New MCP tool `cex_backtest_strategy`: the agent can backtest a draft before starting.
- **Parameter-sweep mode** (grid over trigger params) — provides the search capability for subsystem C's inner loop.

**Interface contract**: input `StrategyDSL` + time range + data source → output `BacktestReport{metrics, trades[], equity_curve, unbacktestable_signals[]}`.

### Subsystem C — Feedback Loop (pre-deployment "generate → backtest → optimize" inner loop)

A pre-deployment iterative inner loop (QuantAgent writer/judge shape):

```
LLM generates candidate v1
      │
      ▼
  auto-backtest (subsystem B) ──► BacktestReport (Sharpe/drawdown/win rate/…)
      │
      ▼
  optimize (dual):
    · parameter sweep — grid-search better thresholds/windows/sizing at fixed structure (deterministic)
    · LLM structural edit — read the report, swap signals / add stops / change logic → vN+1
      │
      ▼
  stop decision: metric target met, or no improvement for K rounds, or round cap reached
      │
      ▼
  emit best version → deploy (paper/shadow auto; live emits approval → gate)
```

- **Optimizer**: drives the loop above, records `{dsl version, backtest metrics}` per round, picks the best. Parameter sweep and LLM edits alternate.
- **Per-strategy performance journal (FinMem-layered episodic memory, secondary supplement)**: archives each round's backtest results and live fills, keyed by strategy_id; lets the LLM retrieve "what pitfalls this class of strategy hit before" during optimization. Separate from the project-level `memory/`.
- **Retrieval at generation time**: the trade subagent retrieves relevant reflections when generating/optimizing.

**Interface contract**: input initial `StrategyDSL` + optimization budget (target metric / round cap); consumes `BacktestReport`; produces **best `StrategyDSL` version + optimization trace (per-round versions and metrics)**. Deployment constrained by mode (live requires approval).

---

## 6. Two-Tier Memory Architecture for the trade Subagent (cross-cutting)

The trading agent is a standalone subagent (`trade`, alongside `onchain_data` / `news_research`, hard category-isolated). The other two are stateless data fetchers and **need no memory**; `trade` is different — it must get better at the market across the "generate → backtest → optimize → deploy" cycle, so it **owns two tiers of memory**. This is what actually closes the feedback loop.

### Short-term / working memory (within a session)
- Scope: working continuity across multiple trade dispatches inside one session (which drafts were made, which the user rejected, remarks like "too aggressive").
- Semantics: later trading decisions in the same session can see what happened earlier, instead of starting from zero each dispatch.

### Long-term memory (session-independent, persistent)
- Scope: cross-session persistent accumulation, value compounding by week/month.
- Contents (three kinds this round):
  1. **Strategy-performance lessons** — i.e. subsystem C's L1 (per-strategy journal) + L2 (cross-strategy lessons, retrieval key = signal-combo + regime, **only ingests out-of-sample-validated conclusions**).
  2. **Live-vs-backtest divergence (calibration signal)** — once a deployed strategy accrues enough live P&L, reconcile it against its original backtest prediction and store the divergence (e.g. backtest Sharpe 2, live 0.3). Mildly: flag the strategy as overfit; strongly: distill "backtests for this class of signal-combo run systematically optimistic." This is what turns the loop from **open** (optimize and walk away) into **closed** (live results flow back to calibrate) — without it, memory only holds "lessons from the backtest world," never the far more valuable "gap between backtest and reality." Write definition in subsystem C.
  3. **User long-term preferences** — risk appetite, no leverage, preferred assets, retained across sessions and applied as constraints at generation.
- Retrieval: injected by relevance (signal-combo + regime / this user) when generating/optimizing.

### Ownership vs subsystems
- L1/L2 **content and writing** are defined in subsystem C; what's decided here is the **architectural decision "trade owns two memory tiers"** and the two-tier boundaries.
- Short-term memory is a new tier, unrelated to performance — pure within-session working continuity.
- L3 market-regime memory → deferred, not this round.

---

## 7. The Hardest Seam: Historical Signal Data Alignment

Backtest must align **price klines + on-chain metrics + sentiment** on one timeline — their raw frequency/latency differ (klines minute-level, on-chain possibly hourly, sentiment daily). Architecturally owned by `HistoricalSignalContext`:

- **Information-fidelity principle (hard constraint)**: a backtest may only use information that was **genuinely available at that point in time** — never future values. History is built from "what was observed then," not by backfilling final values. On-chain/sentiment are especially high-risk (publication lag, after-the-fact revision); otherwise the optimizer will precisely optimize toward "exploiting foresight that never existed," and the better the backtest looks the harder live disappoints. This extends the single-code-source spirit: consistency goes from "same formula" to "same information frontier." Implementation (forward-recording / lag field / versioned snapshots) is settled in B's plan phase.
- Define each signal's **value semantics** (forward-fill vs interpolate vs reject) and **availability window**; when a signal lacks data, `at(t)` returns "unavailable" explicitly, and StrategyEngine has deterministic behavior for "signal unavailable" (default: no trigger).
- Live `LiveSignalContext` uses the same "missing = unavailable" semantics, keeping backtest and live aligned.
- Historical on-chain/sentiment sources, caching, and backfill strategy are detailed in **subsystem B's sub-spec**.

---

## 8. Safety Invariants (preserved + new)

- **(preserved) No fill without approval**: any live version produced by the loop passes the approval gate.
- **(preserved) Hard category isolation**: new backtest/loop tools belong to the `trading` category; non-trading subagents can't reach them.
- **(new) The loop must not auto-promote to live**: the optimizer iterates on backtest to produce candidates; **candidate auto-deployment is paper/shadow only**, any live transition must be human-approved. Enforced as a hard gate in eval (⑥).
- **(new) Frozen go-live, zero auto param change**: this round's deployment object is a **frozen** strategy (structure + params fixed once); re-optimization = a human re-runs the loop, and the resulting new version's live promotion still goes through approval (see C §4/§7).
- **(new) Kill-switch only halts, no approval needed**: the hard triggers of invalidation (C §7.3) only **auto-halt new entries / reduce** — halting is always allowed, only reduces risk, is not a live action requiring approval, and is thus consistent with "no fill without approval."
- **(preserved) Risk applies throughout**: both backtest and live fill simulation go through riskEngine.

---

## 9. Eval Extensions (continuing the existing ①–④' suite)

- **⑤ Backtest-metric determinism**: same input (incl. fee/slippage params) backtested twice → bit-identical metrics (pure-function guarantee).
- **⑥ Loop safety**: adversarial trials assert the optimizer **never** auto-produces a live deployment; any live transition beyond paper/shadow carries approval. Hard gate = 0 violations.
- **⑦ Inner-loop convergence**: assert the loop always stops within the round cap (no infinite loop), and the chosen version's **cross-fold aggregate out-of-sample metric** (walk-forward, see C §4) ≥ the initial version (no regression).
- **① extension**: NL→DSL dataset adds TA/on-chain/sentiment compound-condition cases.
- **② reuse**: candle-replay migrates onto the unified `StrategyEngine.evaluate`, incidentally validating signal evaluation.

---

## 10. Decomposition and Sequencing

Three sub-specs, dependency order (skeleton first):

```
0. Skeleton (extract SignalContext + StrategyEngine) ── prerequisite, folded into subsystem A's sub-spec
        │
        ▼
A. Generation enhancement ──► B. Backtest engine ──► C. Generate→Backtest→Optimize loop
   (activate TA/on-chain/       (P&L + fees/slippage    (Optimizer: param sweep +
    sentiment signals)           + param sweep)          LLM structural edits + perf memory)
```

- **A** first: without signal execution, backtest can't simulate new strategies. The skeleton (SignalContext/StrategyEngine) lands in A's sub-spec.
- **B** next: backtest is the judge signal for C's loop; without P&L numbers optimization can't judge quality.
- **C** last: consumes B's reports to drive the optimization loop.

Each subsystem runs `design → plan → implementation` independently.

---

## 11. References (web3 domain)

- Reflective memory loop: [CryptoTrade / Reflective Agent](https://arxiv.org/html/2407.09546v1), [FinMem](https://arxiv.org/pdf/2311.13743), [TradingGroup (self-reflection + data synthesis)](https://arxiv.org/html/2508.17565v1)
- Inner/outer writer-judge loop: [QuantAgent (TradingAgents)](https://arxiv.org/pdf/2412.20138), [SHARP self-evolving human-auditable rubric](https://arxiv.org/pdf/2605.06822)
- Evolutionary strategy search (far-term reference): [MadEvolve](https://arxiv.org/html/2605.23007v1)
- Crypto multi-agent portfolio management: [LLM multi-agent portfolio management](https://arxiv.org/html/2501.00826v3), [explainable zero-shot BTC trading (backtested)](https://www.sciencedirect.com/science/article/abs/pii/S0306457325004078)
- Backtest benchmark: [FinRL Contests](https://arxiv.org/pdf/2504.02281)
- Market regime classification (used for C's L2 tagging): [Hurst for trend/mean-reversion (Macrosynergy)](https://macrosynergy.com/research/detecting-trends-and-mean-reversion-with-the-hurst-exponent/), [Hurst vs ADX (FractalCycles)](https://fractalcycles.com/compare/hurst-vs-adx), [Volatility Regime Classifier (Hurst+ADX+Choppiness)](https://www.tradingview.com/script/zagpmoKH-Volatility-Regime-Classifier-QuantRegime/), [crypto volatility regime comparison](https://arxiv.org/html/2404.04962v1), [non-parametric online regime detection](https://arxiv.org/pdf/2306.15835)
