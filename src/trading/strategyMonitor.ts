import { listStrategies, saveStrategy, type StoredStrategy } from "./persistence/strategyStore.ts";
import type { RealtimeFeed } from "../data/stock/realtime/index.ts";
import type { ExecutionOutcome } from "./strategyExecutor.ts";
import {
  evaluatePriceTrigger,
  isTechnicalTrigger,
  technicalTriggerHistoryBars,
} from "../../mcp_tools/trading/strategy/priceTrigger.ts";
import type { StrategyPhase } from "../../mcp_tools/trading/strategy/priceStrategy.ts";
import { getRealtimeFeed } from "../data/stock/realtime/sharedFeed.ts";
import { executeTrigger } from "./strategyExecutor.ts";
import { fetchStockStrategyPrice, fetchStockTechnicalStrategySamples } from "./stockStrategyMarketData.ts";
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

/**
 * Cadence while at least one strategy is active.
 *
 * This matches the realtime buffer's bucket width, and it is affordable only because a tick no
 * longer performs any network call: prices are read out of the in-process buffer the quote stream
 * writes into. When the stream is unavailable the REST fallback below keeps its own, far slower
 * cadence, so a degraded feed cannot turn this interval into 120 requests a minute per symbol.
 */
export const ACTIVE_INTERVAL_MS = 500;

/**
 * How often the REST fallback may be used for one symbol.
 *
 * Only reached when the stream has nothing buffered — no credentials, a degraded connection, or
 * a symbol that lost its subscription slot. The free plan allows 200 requests a minute in total,
 * so this stays at the cadence the monitor polled at before the stream existed.
 */
export const REST_FALLBACK_INTERVAL_MS = 7_000;

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

/** last fire time (ms) per strategy id, for recurring cooldown */
const lastFireMs = new Map<string, number>();
/** last REST fallback fetch (ms) per symbol, so a dead stream cannot burn the request budget */
const lastRestPollMs = new Map<string, number>();

/**
 * Everything a tick touches outside itself. Production passes nothing; tests pass a fake feed and
 * an in-memory strategy list, which is what makes the trigger path testable without a data
 * directory or a network.
 */
export interface MonitorDeps {
  feed: RealtimeFeed;
  listActive: () => Promise<StoredStrategy[]>;
  save: (strategy: StoredStrategy) => Promise<void>;
  execute: (
    strategy: StoredStrategy,
    phase: StrategyPhase,
    price: number,
    now: Date,
    observed?: Record<string, number | string>,
  ) => Promise<ExecutionOutcome>;
  fetchPrice: (symbol: string) => Promise<number>;
}

function resolveDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    feed: overrides.feed ?? getRealtimeFeed(),
    listActive: overrides.listActive ?? (() => listStrategies("active")),
    save: overrides.save ?? saveStrategy,
    execute: overrides.execute ?? executeTrigger,
    fetchPrice: overrides.fetchPrice ?? fetchStockStrategyPrice,
  };
}

/** Test-only: clears the cooldown and REST-throttle bookkeeping held across ticks. */
export function resetMonitorState(): void {
  lastFireMs.clear();
  lastRestPollMs.clear();
}

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
export async function runOnce(now: Date, overrides: Partial<MonitorDeps> = {}): Promise<number> {
  const deps = resolveDeps(overrides);
  const strategies = await deps.listActive();
  const nowMs = now.getTime();

  // Group by symbol so each symbol is polled once and its strategies run serially.
  const bySymbol = new Map<string, StoredStrategy[]>();
  for (const s of strategies) {
    const list = bySymbol.get(s.symbol) ?? [];
    list.push(s);
    bySymbol.set(s.symbol, list);
  }

  // The stream's subscription set is driven from here rather than from the three places that can
  // change a strategy's status: reconciling against the active set converges no matter which of
  // them ran, and cannot leave a pin behind.
  deps.feed.reconcileStrategySymbols([...bySymbol.keys()], nowMs);
  deps.feed.sweep(nowMs);

  for (const [symbol, group] of bySymbol) {
    let price = deps.feed.currentPrice(symbol, nowMs);
    if (price === undefined || price <= 0) {
      price = await restFallbackPrice(symbol, nowMs, deps);
      if (price === undefined) continue;
    }
    // Serial per symbol: one trigger evaluation and simulated action completes before the next.
    for (const strategy of group) {
      await evaluateStrategy(strategy, price, now, deps);
    }
  }

  return strategies.length;
}

/**
 * Fetch one price over REST, at most once per REST_FALLBACK_INTERVAL_MS per symbol, and write it
 * into the same buffer the stream feeds. Downstream evaluation cannot tell the two apart; the
 * window simply becomes sparse while the stream is down.
 */
async function restFallbackPrice(symbol: string, nowMs: number, deps: MonitorDeps): Promise<number | undefined> {
  const last = lastRestPollMs.get(symbol);
  if (last !== undefined && nowMs - last < REST_FALLBACK_INTERVAL_MS) return undefined;
  lastRestPollMs.set(symbol, nowMs);
  try {
    const price = await deps.fetchPrice(symbol);
    if (price <= 0) return undefined;
    deps.feed.recordPrice(symbol, price, nowMs);
    return price;
  } catch (err) {
    console.warn(`[strategyMonitor] REST price fallback failed for ${symbol}:`, err);
    return undefined;
  }
}

async function evaluateStrategy(strategy: StoredStrategy, price: number, now: Date, deps: MonitorDeps): Promise<void> {
  if ((strategy.dsl.mode as string) === "live") {
    strategy.status = "paused";
    strategy.failure_reason = "Live stock broker execution is not configured; use paper or shadow mode.";
    await deps.save(strategy);
    return;
  }
  if (activateEligiblePhases(strategy).length > 0) await deps.save(strategy);
  for (const phase of strategy.dsl.phases) {
    if (strategy.status !== "active") return;
    if (phase.status !== "active") continue;
    await evaluatePhase(strategy, phase, price, now, deps);
  }
}

async function evaluatePhase(strategy: StoredStrategy, phase: StrategyPhase, price: number, now: Date, deps: MonitorDeps): Promise<void> {
  const trigger = phase.price_trigger;
  const nowMs = now.getTime();
  const phaseKey = `${strategy.id}:${phase.id}`;

  // Recurring cooldown gate.
  const recurrence = phase.recurrence;
  if (recurrence?.mode === "recurring" && recurrence.cooldown_minutes) {
    const last = lastFireMs.get(phaseKey);
    if (last !== undefined && nowMs - last < recurrence.cooldown_minutes * 60_000) return;
  }

  // Arming: rolling_change is meaningless until the buffer spans its window. Backfill is kicked
  // off when the symbol is subscribed, so there is nothing to await here — just wait a tick.
  if (trigger.type === "rolling_change") {
    if (!deps.feed.isArmed(strategy.symbol, (trigger.window_minutes ?? 0) * 60_000, nowMs)) return;
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
    samples = deps.feed.window(strategy.symbol, windowMinutes * 60_000, nowMs);
  }
  const result = evaluatePriceTrigger(trigger, samples, price);

  // Persist a raised trailing-stop anchor immediately (so a restart never gives back gains).
  if (
    trigger.type === "trailing_stop" &&
    result.nextReferencePrice !== undefined &&
    result.nextReferencePrice !== trigger.reference_price
  ) {
    trigger.reference_price = result.nextReferencePrice;
    await deps.save(strategy);
  }

  // No repetition counting: unrepresentative quotes are rejected at the stream's entry filter,
  // so a condition that survives to here is acted on immediately.
  if (result.conditionMet) {
    await fire(strategy, phase, price, now, deps, result.observed);
  }
}

async function fire(
  strategy: StoredStrategy,
  phase: StrategyPhase,
  price: number,
  now: Date,
  deps: MonitorDeps,
  observed?: Record<string, number | string>,
): Promise<void> {
  const phaseKey = `${strategy.id}:${phase.id}`;
  const recurrence = phase.recurrence;
  const triggerCount = recurrence?.trigger_count ?? 0;

  // Transition to running before recording the paper/shadow action.
  strategy.status = "running";
  phase.status = "running";
  strategy.running = { execution_id: `exec-${strategy.id}-${phase.id}-${triggerCount}`, phase_id: phase.id, started_at: now.toISOString() };
  await deps.save(strategy);

  const outcome = await deps.execute(strategy, phase, price, now, observed);
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
      cancelOcoPeers(strategy, phase);
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
  await deps.save(strategy);
}
