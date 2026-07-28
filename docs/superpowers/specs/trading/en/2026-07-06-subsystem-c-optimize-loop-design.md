# Subsystem C: Generate→Backtest→Optimize Loop (Macro-Concept Proposal)

Date: 2026-07-06
Status: Proposal (under review, concept level)
Parent spec: `2026-07-03-web3-strategy-loop-design.md`
Prerequisites: Subsystem A (StrategyEngine) + Subsystem B (backtest + parameter-sweep interface + BacktestReport)
Scope: **Macro-concept level** — loop orchestration, objective function, validation & tuning methodology (walk-forward), frozen deployment, decay measurement & invalidation, execution form and performance memory; no implementation detail.

---

## 1. Goals and Non-Goals

### Goals
1. Implement the pre-deployment **generate → backtest → optimize** iterative inner loop (QuantAgent writer/judge shape).
2. Dual-driver optimization: **parameter sweep** (calls B's sweep interface, deterministic) + **LLM structural edits** (read the BacktestReport, swap signals / add stops / change logic).
3. **Overfitting guard (walk-forward rolling validation)**: multi-fold out-of-sample + robust-max tuning + embargo + trial-count deflation; only candidates passing the cross-fold aggregate are selected.
4. **Frozen deployment + decay/invalidation**: deploy a frozen object (zero auto param change), measure decay, and use invalidation lines derived from the backtest distribution as a kill-switch (hard triggers only halt).
5. **Background task + progress reporting** execution, non-blocking to the conversation.
6. Candidate deployment constrained by mode: **paper/shadow auto, live requires approval** (preserving the top-level safety invariant).
7. **Performance memory** (fills top-level long-term memory): L1 per-strategy journal + **L2 cross-strategy lessons** (first-class) + **live-vs-backtest divergence** calibration.

### Non-Goals
- A's signals/engine, B's backtest/data cache → not repeated here.
- Portfolio-level optimization, cross-strategy evolution → deferred.
- **L3 market-regime memory** (long-term market portraits, cross-market preferences) → deferred; only L1/L2 this round.
- Model weight updates → explicitly not done (linguistic feedback + memory only).

---

## 2. Inner-Loop Orchestration (Optimizer)

Two layers (don't conflate): **parameter sweep = numeric optimization *within* a structure; LLM structural edit = semantic search *across* structures**. Every structure is swept to "its own best params" before comparison, else comparing a tuned structure against an untuned one is unfair.

```
initial StrategyDSL (agent-generated) + optimization budget (target / round cap)
        │
        ▼
 ┌──► each round (outer: LLM structure search):
 │      1. for the current structure, run §4 walk-forward + coarse-to-fine sweep (inner)
 │           → its "best-param" [scalar score] + [diagnostic digest]
 │      2. LLM reads the [diagnostic digest] (per-regime weakness attribution) → produces edited vN+1
 │      3. score vN+1 the same way via walk-forward → scalar score
 │      4. keep-best: replace current best if scalar score higher
 │           record {version, params, per-fold, per-regime, score} → optimization trace + L1
 │      │
 │      ▼
 │   stop: target met, or no improvement for K rounds, or round cap, or compute budget exhausted
 └──────┘  else continue
        │
        ▼
 champion structure → tune params once on the most recent window (see §4 frozen deployment)
        → deploy (paper/shadow auto; live emits approval)
```

- **Optimizer** is the sole orchestrator: the inner sweep is delegated to B (§4 walk-forward orchestration lives in C; B only offers two primitives — "single-range backtest" and "parameter-grid sweep"), the outer LLM structural edit is in C.
- One walk-forward report is **split into two uses**: ① the **scalar score** (§4's median−λ·dispersion + catastrophe gate) for the cold keep-best comparison; ② the **diagnostic digest** (cross-fold spread, per-regime breakdown, weakness attribution) for the LLM's structural edit. **Structural-edit quality depends entirely on how actionably the report is distilled** — tell the LLM "you lose in ranging markets" and it adds a filter; hand it a bare Sharpe and it flails.

---

## 3. Objective Function

- **Default**: risk-adjusted **excess return** — primarily excess over buy-and-hold, penalizing drawdown/volatility (e.g. Sharpe, or excess/max-drawdown).
- **User preference can override**: at creation the user can specify a preference (more aggressive = weight excess, steadier = weight low drawdown), and the Optimizer adjusts objective weights accordingly.
- Selection and stopping decisions **always use out-of-sample metrics** (specifically §4's cross-fold aggregate score), avoiding in-sample metric-gaming.

---

## 4. Validation & Tuning Methodology (walk-forward + coarse-to-fine tuning)

A single train/val split cannot guard this loop — it runs K rounds, each selecting on the *same* val, and repeated selection "eats" the validation segment into in-sample (multiple comparisons / validation leakage). So we use **walk-forward rolling validation**: roll multiple sequential windows across history; each fold tunes on its train segment and validates on the immediately following val segment, sliding forward. To score high a candidate must perform out-of-sample well across **many distinct historical periods simultaneously** — cross-fold consistency is itself the overfitting gate.

### Window: rolling
- **Fixed-length train, slides forward** (not anchored/expanding), so ancient stale regimes don't dominate recent ones — fits crypto's fast regime shifts. Window length and fold count are plan-phase params, bounded by the compute budget below.

### Why we must "segment" and use "multiple folds" (rationale — stops implementers from reverting to whole-data tuning)
- **Why segment**: tuning = picking the params that score highest *on this history*; the moment data participates in that pick, its score is contaminated into optimism (it's the max of K noisy draws, biased upward) and no longer represents the future. So you must hold out data that played no role in any selection to honestly evaluate — "unseen data" is the future, is live.
- **Why multiple folds, not one**: ① a single val = one draw of luck (if it happens to be a bull run, a "chase-the-rally" strategy looks brilliant); ② this loop runs K rounds each selecting on val, so **one val gets "selected into in-sample"** (same disease as whole-data tuning, one level up); ③ one fold is a single number — you can't compute the **distribution** median/dispersion/catastrophe-gate need. Multiple folds spend compute to buy "luck-robustness + selection-leakage defense + measurable stability & tail."

### Two-layer evaluation (don't conflate)
- **Parameter sweep** happens **within each fold's train segment**; the chosen params apply to that fold's val segment. Within each fold **params are frozen** (tuned once on train, run through val without re-tuning) — this is precisely the honest simulation of "frozen deployment" (see below).
- The **LLM structural-edit** layer scores and selects each candidate structure by the **out-of-sample metric aggregated across folds**.

### Boundary isolation (embargo / purging)
- Insert an **embargo** between train and val, and purge boundary-straddling samples. Reason: this system has **stateful signals** (rolling window, trailing, confirm counts); a rolling window straddling the train/val boundary leaks train-tail info into the val head. This is standard walk-forward practice.

### Frozen-deployment semantics (this round: deploy a frozen object, not periodic re-tuning)
- **Deployment object = frozen**: structure + params fixed once, zero auto-change after go-live; re-optimization = a human re-runs this loop (approval-gated), not a live self-re-tuning organism.
- **Each fold honestly simulates it**: a fold = "tune once on a recent window → run frozen forward"; identical to the deploy action ("tune once on recent window → freeze and go live"), so the walk-forward aggregate is an honest estimate of the deployed object (removes the "re-tune per fold but deploy once" inconsistency).
- **The one calibrated knob: val length = the intended frozen-live duration H (review horizon)**. A frozen object **decays** as the market drifts from its tuning window; too short a val only measures the freshest stretch and misses decay → overestimate. So val=H lets each fold measure a frozen instance's decay over its **full exposure**. Decay measurement and invalidation: see §7.
- **Meaning of the three window params**: train length = enough to tune stably; **val length = H (measures decay)**; fold step = only governs enough independent probes + enough regime coverage (see §6 regime classification), tied to no cadence (frozen has none).

### Parameter sweep mechanism (inner)
- **Coarse-to-fine grid (2 levels)**: pass 1 wide range / big steps to locate the best region, pass 2 narrows around the winner with fine steps. An order of magnitude cheaper than exhaustive — the key to affording walk-forward's N× cost. Fully deterministic → satisfies eval ⑤.
- **Pick robust-max (parameter plateau), not raw argmax**: the industry-named **plateau vs island** concept — take the center of a region "whose neighborhood also scores well," insensitive to small param perturbations; a raw spike dies out-of-sample. Coarse-to-fine's "blindness to narrow peaks" is the same idea (a peak narrow enough for the coarse grid to step over is exactly the fragile spike we don't want) — at the coarse pass, pick the robust-max region to zoom into.
- **Tunable params & ranges**: each signal kind carries a **default range** as fallback; the LLM may **narrow or override** when generating/editing structure.
- **Hard cap on simultaneously-tuned params** (e.g. ≤3-4, value fixed in plan): if too high-dimensional, let the LLM pick the few that matter, rest take defaults. This is the main throttle on walk-forward compute.
- **Grid premise pinned**: coarse-to-fine grid only holds when dimensionality is hard-capped small; once dims grow, the proper path is random/Bayesian (at the cost of ⑤ determinism), deferred.

#### Coarse-to-fine worked example (within one fold's train segment)
Take an RSI mean-reversion strategy with 2 tunable params: `T` = RSI oversold threshold (buy when RSI<T), `stop` = stop-loss distance %. Evaluating a param set = run one backtest on that fold's **train segment**, compute the §3 score.

**Pass 1 (coarse)**, sparse grid with big steps:
```
T    ∈ {20, 25, 30, 35}      stop ∈ {2%, 4%, 6%}   → 4×3=12 backtests
          stop=2%  stop=4%  stop=6%
T=20       0.8      1.1      0.9
T=25       1.0      1.5      1.2
T=30       1.2     [1.6]     1.4     ← this whole region is high
T=35       0.7      1.3      0.6     ← jumpy = spike suspect
```
**robust-max (pick the plateau, not the raw top cell)**: for each cell compute the aggregate of "itself + neighbors" (neighborhood mean, or more conservatively neighborhood min), pick the highest aggregate. `(T=30,stop=4%)` has a strong neighborhood → robust; an isolated 1.7 whose neighbors drop to 0.6 → low aggregate, dropped. → winner region ≈ (30, 4%).

**Pass 2 (fine)**, only within ±1 coarse step of the winner, small steps:
```
T ∈ {28,29,30,31,32}   stop ∈ {3%,3.5%,4%,4.5%,5%}   → 5×5=25 backtests
```
robust-max again → e.g. `(T=29, stop=4.5%)` = this fold's chosen params, applied to the val segment for its OOS score.

**General algorithm**: `optimize(ranges) = coarse grid → backtest each for §3 → robust-max to fix the basin → fine grid within the basin → backtest each → robust-max to fix params`.

**Cost**: 12+25 = **37 backtests**; a fine step filling the whole range upfront (16×9) = **144** → ~4× fewer, and the gap widens with dimensionality/resolution.

**Three plan-phase choices**: ① neighborhood = n-dim Moore neighborhood (conservative = min / loose = mean); ② winner at the coarse-grid edge → **clamp to declared ranges** (no sneaky out-of-bounds in the sweep; widening is an explicit LLM range change next round); ③ multiple separated plateaus → drill only the single best basin (covering competing basins is the LLM structural-edit layer's job, not the sweep's).

### Candidate scoring: center − dispersion penalty − catastrophe gate
Each fold's OOS score = the §3 objective (walk-forward doesn't replace the objective, only aggregates it across folds — no double counting). Aggregate into a candidate score:
- **Central tendency = median across folds**: robust to a single outlier fold; a mean gets pulled up by one great fold, masking several bad ones.
- **Dispersion penalty = minus λ × cross-fold dispersion (std or IQR)**: rewards "steadily decent" over "erratically brilliant"; large cross-fold variance = regime-sensitive = prone to blow up live (echoes §6 regime-aware).
- **Catastrophe gate (hard veto)**: any fold hitting a drawdown ceiling / more than X% of folds negative out-of-sample → rejected regardless of median. Blocks "pretty median hiding one −80% fold"; select-over-K-rounds most readily picks such high-center + hidden-tail candidates.
- **Score = median(folds) − λ·dispersion(folds)**, then pass the catastrophe gate.
- **λ tied to user preference**: same preference knob as §3 — aggressive → small λ (weight the median), steady → large λ (penalize dispersion). One knob tunes both the *within*-fold risk penalty (§3) and the *cross*-fold consistency penalty here.

### Deflate the winner by number of trials (Deflated-Sharpe approach)
- This loop is **multiple testing** (K rounds × many candidates each) — the more you try, the more the winner's metric is luck. Adopt López de Prado's **Deflated Sharpe Ratio** approach: **analytically discount the winner's final metric by cumulative trial count**, not by hand-wavy weighting. This is the rigorous form of the multiple-selection-bias + small-sample intuition.
- Optional: emit **PBO (Probability of Backtest Overfitting)** as an eval/report metric.
- **Deliberately not CPCV**: combinatorial purged cross-validation (recombining time blocks into many paths) is stronger but breaks strict time-ordering, colliding with regime classification (§6) and frozen deployment's forward-in-time semantics. We stop at walk-forward + plateau + embargo + DSR discount — the optimum under our constraints.

### Cold-start fallback
- Per top-level §7 information-fidelity: when on-chain/sentiment history isn't deep enough to form enough folds → **automatically reduce fold count and label results low-confidence**, rather than pretending a full walk-forward ran.

### Compute budget
- Walk-forward multiplies backtest runs (N folds × parameter grid × K rounds) → the plan phase must **cap fold count and control grid size**; compatible with the stop condition and ⑦.
- Eval ⑦: the chosen version's **cross-fold aggregate out-of-sample metric** ≥ the initial version (no regression), and the loop always stops within the round cap (no infinite loop).

---

## 5. Execution Form

- Optimization runs as a **background task**, reusing the existing event/SSE architecture to **report progress per round** (round number, current best, cross-fold aggregate metrics).
- On completion, hands back the **best version + optimization trace**; non-blocking to the conversation.
- Failure/timeout: keep the best version and trace produced so far, mark the task's failure reason, never silently discard.

---

## 6. Performance Memory (L1 / L2: filling the top-level long-term memory)

Top-level §6 defines the trade subagent's **short-term (within-session) + long-term (cross-session persistent)** two-tier memory architecture. This section defines the **"strategy-performance" content** of the long-term tier — its writing and structure. It is what turns C from a "one-shot optimizer" into a **real loop** (without it, each strategy is forgotten once run). The "user preferences" long-term content is not in C; it belongs to the top-level / interaction layer.

### L1 — per-strategy performance journal (base layer, required)
- Archive each round's `{version, params, per-fold + cross-fold aggregate metrics}` and live fill results, keyed by strategy_id.
- Serves this strategy's optimization trace and review.

### L2 — cross-strategy lessons memory (first-class component)
- **A lesson = structured tags + one reflection sentence**:
  - Tags: **signal combination** (which signal families/kinds used) + **regime** (trend / range / high-low vol, see below) + outcome tendency (out-of-sample passed / failed).
  - Reflection text: a one-line LLM summary (e.g. "RSI+net-outflow combo repeatedly drawdowns out-of-sample in ranging markets").
- **Retrieval key = signal combination + regime**: when generating a new strategy, pull relevant lessons by the candidate's signal combination + current regime into the LLM context.
- **Regime tagging**: each lesson is tagged with the market state at write time (see "Regime Classification"), the prerequisite for regime-based retrieval, a required L2 step.
- **Only ingest out-of-sample-validated conclusions**: bound to §4 overfitting guard, avoiding recording in-sample flukes as rules.

### Live-vs-backtest reconciliation (divergence — closing the feedback loop)

Corresponds to top-level §6 long-term memory content class 2. C's pre-deployment inner loop optimizes against an *unvalidated model* (the backtest); the only ground truth is live P&L. This item turns the loop from **open** (optimize and walk away) into **closed** (live results flow back to calibrate).

- **Production**: once a deployed strategy accrues enough live P&L (a minimum sample/duration threshold), reconcile against its original backtest prediction and compute `divergence = {predicted_metrics, realized_metrics, gap}` (e.g. backtest Sharpe 2, live 0.3). L1 already archives live fills, so divergence is one projection on top — almost no added build.
- **Distillation**:
  - Mild — flag this strategy_id as overfit (into L1, lowering its reuse weight).
  - Strong — if a class repeatedly runs optimistic, promote to an L2 lesson "backtests for this signal-combo run systematically optimistic," avoided at generation.
- **Value**: this is the only signal in memory that can learn "the gap between backtest and reality"; without it, L1/L2 only learn "lessons from the backtest world."

### Regime Classification (shared by report-split / decay / invalidation / L2 tagging)

Lightweight, deterministic, explainable; **two-dimensional labels**, 6 buckets total. Used for per-regime report splitting, decay regime-conditioning (§7.2), invalidation regime-exit (§7.3), and L2 tagging/retrieval; **not exposed to strategies as a signal** (adaptive strategies are far-term).

**Taxonomy (2D × 6 buckets)**:

|  | high vol | low vol |
|---|---|---|
| **trending_up** | ✔ | ✔ |
| **trending_down** | ✔ | ✔ |
| **ranging** | ✔ | ✔ |

- **Direction axis (3 values: trending_up / trending_down / ranging)**: **ADX + Hurst vote** — ADX measures trend *strength* (high, e.g. >25 = strong trend), Hurst measures *character* (>0.55 persistent/trending, <0.45 mean-reverting); only judge trend if **both** point to trend (ADX high **AND** Hurst>0.55) (conservative AND, fewer false trends), else ranging; the trend's **up/down sign** is set by +DI/−DI or price slope.
- **Volatility axis (2 values: high / low)**: bucketed by the **historical percentile of ATR / realized volatility** (e.g. >70th percentile = high).
- **Data source**: all computed from price/klines (ADX, Hurst, ATR); live and backtest **share one algorithm** (single code source, continuing the top-level principle), ensuring consistent tagging. Thresholds (ADX cutoff, Hurst 0.55/0.45, ATR 70th pctile) are plan-phase params.
- **Research basis**: ADX/Hurst/Choppiness/Variance-Ratio are different lenses on the same question; a lightweight combination suffices; HMM/clustering/visual DL are over-engineering for "tagging" (see top-level §11 references).

**How the report is split by regime (per-bar tag → bucket)**:
```
per bar in backtest:
  1. compute ADX/Hurst/ATR on the window before this bar → tag it one of 6 buckets
  2. attribute this bar's strategy return/trades to that bucket
finally: compute metrics per bucket → e.g. "ranging+high-vol: return X, drawdown Y"
```
- The resulting per-regime metrics feed: diagnostic digest → LLM (weakness attribution), decay regime-conditioning, invalidation regime-exit, L2 tagging.
- **Anti-flapping (plan phase)**: per-bar regime flips back and forth at boundaries → require the label to **persist N bars before switching**, else buckets get shattered by noise.

### Storage
- **Reuse the existing `eventStore`** (trading results are already events); L1/L2 project/retrieve on top of it, no parallel store. Separate from the project-level `memory/`.

---

## 7. Deployment, Decay Measurement, and Invalidation

### 7.1 Deployment boundary
- The loop iterates entirely on backtest/history, never touching live.
- The champion structure gets its go-live params by **tuning once on the most recent window** (isomorphic to what each §4 fold does).
- Chosen candidate: **paper/shadow auto-deploy**; **live always emits approval → the existing gate**.
- **Frozen: zero auto param change after go-live**; re-optimization = a human re-runs the loop, and the new version's live promotion still goes through approval.
- Eval ⑥: adversarial trials assert the loop **never** auto-produces a live deployment.

### 7.2 Decay measurement
A frozen strategy decays as the market drifts from its tuning window. **The same rolling metric measures decay in backtest (predictive) and monitors it live (reactive)** — continuing the single-source spirit.

- **Algorithm**: align every fold's val segment by "t days since tuning" to **t=0**, roll a metric within val (**rolling excess return / rolling Sharpe** — excess strips the "market got harder" confound), and **average across folds** at each t → a robust **decay curve**.
- **Summary**: ① decay slope (regression slope); or ② half-life ("the edge halves every X days"), which directly sets H (take H ≈ 1–2 half-lives).
- **Honest caveat**: decay is intrinsically coupled with regime drift (a frozen strategy decays precisely because the market drifts off its tuning regime), so report decay both overall and regime-conditioned, separating "gone stale" from "regime changed."

### 7.3 Invalidation (kill-switch)
A frozen strategy will eventually fail; **without pre-committed invalidation lines you commit the classic error of "bleeding while hoping it recovers."** Invalidation lines are **all derived from the backtest's own distribution**, not arbitrary. Four triggers, soft and hard:

| Trigger | Criterion (from backtest distribution) | Response |
|---|---|---|
| **Kill-line (hard)** | live drawdown ≥ catastrophe threshold, or ≥ worst-fold backtest drawdown × margin | **auto-halt new entries** + human review |
| **Underperformance floor (soft)** | trailing-window live metric < backtest fold-distribution floor (worst fold / 5th pctile), sustained | flag, trigger human re-optimization |
| **Regime exit (soft)** | current regime ∉ the strategy's backtest-acceptable regime set | downgrade / alert (ties §6 regime) |
| **Horizon expiry (soft)** | time since tuning > H | mandatory review (no evidence it works beyond H) |

- **Hard triggers only "halt/reduce," no approval needed**: halting is always allowed, only reduces risk, is not a new live action requiring approval → consistent with the safety invariant.
- **The metric monitored live = the same rolling metric §7.2 uses for decay**; "live decays faster than backtest predicted" is itself a divergence signal (§6), folded naturally into invalidation.
- Invalidation events flow back to memory: "this structure failed after X days / on regime Y flip" → distilled into L2.

---

## 8. Delivery Boundary (C done means)

After the agent generates a strategy it can start a background optimization → the loop auto-sweeps params + LLM-edits structure + validates in/out-of-sample → produces the best out-of-sample-passing version → auto-deploys to paper/shadow (or emits approval for live). At this point the top-level "generate → backtest → optimize → deploy" loop is closed.
