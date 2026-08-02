import { listStrategies, saveStrategy, type StoredStrategy } from "./persistence/strategyStore.ts";
import {
  evaluatePriceTrigger,
  isTechnicalTrigger,
  technicalTriggerHistoryBars,
} from "../../mcp_tools/trading/strategy/priceTrigger.ts";
import type { StrategyPhase } from "../../mcp_tools/trading/strategy/priceStrategy.ts";
import { backfill, pollPrice, windowSamples, isArmed } from "./priceHistory.ts";
import { executeTrigger } from "./strategyExecutor.ts";
import { stepConfirmation } from "./confirmation.ts";
import { fetchStockTechnicalStrategySamples } from "./stockStrategyMarketData.ts";
import {
  activateEligiblePhases,
  cancelOcoPeers,
  nextStrategyStatus,
  recordPhaseFill,
} from "./strategyWorkflow.ts";

/**
 * Deterministic background loop: every interval it polls prices for the symbols
 * of all active strategies, evaluates each strategy's price trigger (with
 * N-sample wick confirmation), and — when confirmed — records the paper/shadow action.
 * Self-scheduling (setTimeout after completion) to avoid overlapping ticks.
 */

/** Cadence while at least one strategy is active. */
export const ACTIVE_INTERVAL_MS = 7_000;

/**
 * Cadence while nothing is active. A pass over zero strategies still costs a
 * directory read and a JSON parse per file, which is not worth paying every 7
 * seconds on a server that is only being used for research.
 *
 * The loop parks rather than stopping outright: `wakeMonitor` is called from every
 * path that makes a strategy active, so this heartbeat exists purely so that a
 * strategy activated some other way — a hand-edited file, a path added later —
 * starts within a minute instead of never.
 */
export const IDLE_INTERVAL_MS = 60_000;

/** How long to wait before the next pass, given what the last one found. */
export function nextTickDelay(activeStrategies: number): number {
  return activeStrategies > 0 ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let active = false;
let fastIntervalMs = ACTIVE_INTERVAL_MS;

/** consecutive samples where the condition was met, per strategy id */
const confirmCounts = new Map<string, number>();
/** last fire time (ms) per strategy id, for recurring cooldown */
const lastFireMs = new Map<string, number>();

export function startMonitor(intervalMs: number = ACTIVE_INTERVAL_MS): void {
  if (active) return;
  active = true;
  fastIntervalMs = intervalMs;
  const tick = async (): Promise<void> => {
    if (!active) return;
    let found = 0;
    try {
      found = await runOnce(new Date());
    } catch (err) {
      console.error("[strategyMonitor] tick error:", err);
      // An unreadable store is not evidence that nothing is active; stay fast.
      found = 1;
    }
    if (active) schedule(found > 0 ? fastIntervalMs : IDLE_INTERVAL_MS, tick);
  };
  schedule(fastIntervalMs, tick);
}

/**
 * Collapses an idle wait so a strategy that just became active is picked up on the
 * next fast interval rather than at the end of the idle heartbeat. A no-op when the
 * monitor is not running or is already ticking fast.
 */
export function wakeMonitor(): void {
  if (!active || !timer) return;
  const pending = timer;
  const tick = pendingTick;
  if (!tick) return;
  clearTimeout(pending);
  schedule(fastIntervalMs, tick);
}

export function stopMonitor(): void {
  active = false;
  pendingTick = undefined;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

let pendingTick: (() => Promise<void>) | undefined;

function schedule(delayMs: number, tick: () => Promise<void>): void {
  pendingTick = tick;
  timer = setTimeout(() => void tick(), delayMs);
}

/**
 * One evaluation pass over all active strategies. Returns how many were active,
 * which is what decides the next interval. Exposed for tests.
 */
export async function runOnce(now: Date): Promise<number> {
  const strategies = await listStrategies("active");
  const nowMs = now.getTime();

  // Group by symbol so each symbol is polled once and its strategies run serially.
  const bySymbol = new Map<string, StoredStrategy[]>();
  for (const s of strategies) {
    const list = bySymbol.get(s.symbol) ?? [];
    list.push(s);
    bySymbol.set(s.symbol, list);
  }

  for (const [symbol, group] of bySymbol) {
    let price: number;
    try {
      price = await pollPrice(symbol, nowMs);
    } catch (err) {
      console.warn(`[strategyMonitor] price poll failed for ${symbol}:`, err);
      continue;
    }
    if (price <= 0) continue;
    // Serial per symbol: one trigger evaluation and simulated action completes before the next.
    for (const strategy of group) {
      await evaluateStrategy(strategy, price, now);
    }
  }

  return strategies.length;
}

async function evaluateStrategy(strategy: StoredStrategy, price: number, now: Date): Promise<void> {
  if ((strategy.dsl.mode as string) === "live") {
    strategy.status = "paused";
    strategy.failure_reason = "Live stock broker execution is not configured; use paper or shadow mode.";
    await saveStrategy(strategy);
    return;
  }
  if (activateEligiblePhases(strategy).length > 0) await saveStrategy(strategy);
  for (const phase of strategy.dsl.phases) {
    if (strategy.status !== "active") return;
    if (phase.status !== "active") continue;
    await evaluatePhase(strategy, phase, price, now);
  }
}

async function evaluatePhase(strategy: StoredStrategy, phase: StrategyPhase, price: number, now: Date): Promise<void> {
  const trigger = phase.price_trigger;
  const nowMs = now.getTime();
  const phaseKey = `${strategy.id}:${phase.id}`;

  // Recurring cooldown gate.
  const recurrence = phase.recurrence;
  if (recurrence?.mode === "recurring" && recurrence.cooldown_minutes) {
    const last = lastFireMs.get(phaseKey);
    if (last !== undefined && nowMs - last < recurrence.cooldown_minutes * 60_000) return;
  }

  // Arming: rolling_change needs a full window. Backfill once, then require armed.
  if (trigger.type === "rolling_change") {
    const win = trigger.window_minutes ?? 0;
    if (!isArmed(strategy.symbol, win, nowMs)) {
      try {
        await backfill(strategy.symbol, win);
      } catch (err) {
        console.warn(`[strategyMonitor] backfill failed for ${strategy.symbol}:`, err);
        return;
      }
      if (!isArmed(strategy.symbol, win, nowMs)) return;
    }
  }

  let samples;
  if (isTechnicalTrigger(trigger)) {
    try {
      samples = await fetchStockTechnicalStrategySamples(
        strategy.symbol,
        trigger,
        technicalTriggerHistoryBars(trigger),
        price,
      );
    } catch (err) {
      console.warn(`[strategyMonitor] technical data failed for ${strategy.symbol}/${trigger.type}:`, err);
      return;
    }
  } else {
    const windowMinutes = trigger.type === "rolling_change" ? trigger.window_minutes : 0;
    samples = windowSamples(strategy.symbol, windowMinutes, nowMs);
  }
  const result = evaluatePriceTrigger(trigger, samples, price);

  // Persist a raised trailing-stop anchor immediately (so a restart never gives back gains).
  if (
    trigger.type === "trailing_stop" &&
    result.nextReferencePrice !== undefined &&
    result.nextReferencePrice !== trigger.reference_price
  ) {
    trigger.reference_price = result.nextReferencePrice;
    await saveStrategy(strategy);
  }

  // N-sample wick confirmation (shared stepper, also exercised by the eval suite).
  const stepped = stepConfirmation(
    { count: confirmCounts.get(phaseKey) ?? 0 },
    result.conditionMet,
    trigger.confirm_samples,
  );
  confirmCounts.set(phaseKey, stepped.state.count);
  if (stepped.fired) {
    await fire(strategy, phase, price, now, result.observed);
  }
}

async function fire(
  strategy: StoredStrategy,
  phase: StrategyPhase,
  price: number,
  now: Date,
  observed?: Record<string, number | string>,
): Promise<void> {
  const phaseKey = `${strategy.id}:${phase.id}`;
  confirmCounts.set(phaseKey, 0);
  const recurrence = phase.recurrence;
  const triggerCount = recurrence?.trigger_count ?? 0;

  // Transition to running before recording the paper/shadow action.
  strategy.status = "running";
  phase.status = "running";
  strategy.running = { execution_id: `exec-${strategy.id}-${phase.id}-${triggerCount}`, phase_id: phase.id, started_at: now.toISOString() };
  await saveStrategy(strategy);

  const outcome = await executeTrigger(strategy, phase, price, now, observed);
  delete strategy.running;

  if (outcome.placed) {
    lastFireMs.set(phaseKey, now.getTime());
    if (recurrence && recurrence.mode === "recurring") {
      const newCount = triggerCount + 1;
      recurrence.trigger_count = newCount;
      if (recurrence.reanchor && phase.price_trigger.type === "trailing_stop") {
        delete phase.price_trigger.reference_price;
      }
      const reachedMax = recurrence.max_triggers !== undefined && newCount >= recurrence.max_triggers;
      phase.status = reachedMax ? "completed" : "active";
    } else {
      phase.status = "completed";
    }
    if (outcome.fill_price === undefined || outcome.quantity === undefined) {
      phase.status = "paused";
      phase.failure_reason = "simulated fill did not return a price and quantity";
    } else {
      recordPhaseFill(phase, {
        execution_id: outcome.execution_id,
        price: outcome.fill_price,
        quantity: outcome.quantity,
        side: phase.action.side,
        at: now.toISOString(),
      });
      const cancelled = cancelOcoPeers(strategy, phase);
      for (const cancelledPhaseId of cancelled) {
        confirmCounts.delete(`${strategy.id}:${cancelledPhaseId}`);
      }
      activateEligiblePhases(strategy);
    }
  } else if (outcome.blocked || outcome.skipped) {
    if (recurrence?.mode === "recurring") {
      phase.status = "active";
    } else {
      phase.status = "paused";
      phase.failure_reason = outcome.reason ?? "blocked or skipped";
    }
  } else {
    // The simulated action path returned an error.
    phase.status = recurrence?.mode === "recurring" ? "active" : "paused";
    phase.failure_reason = outcome.reason ?? "strategy action failed";
  }
  strategy.status = nextStrategyStatus(strategy);
  await saveStrategy(strategy);
}
