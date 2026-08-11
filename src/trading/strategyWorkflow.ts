import type { StrategyPhase } from "../../mcp_tools/trading/strategy/priceStrategy.ts";
import type { StoredStrategy } from "./persistence/strategyStore.ts";

export interface RecordedPhaseFill {
  execution_id: string;
  price: number;
  quantity: number;
  side: "BUY" | "SELL";
  at: string;
}

function dependencySatisfied(strategy: StoredStrategy, phase: StrategyPhase, dependencyId: string): boolean {
  const dependency = strategy.dsl.phases.find((candidate) => candidate.id === dependencyId);
  if (!dependency) return false;
  return phase.activate_on === "first_fill"
    ? dependency.last_fill !== undefined
    : dependency.status === "completed";
}

function applyFillAnchor(strategy: StoredStrategy, phase: StrategyPhase): boolean {
  if (!phase.price_anchor) return true;
  const source = strategy.dsl.phases.find((candidate) => candidate.id === phase.price_anchor?.phase_id);
  if (!source?.last_fill) return false;
  if (phase.price_trigger.type === "relative_change" || phase.price_trigger.type === "trailing_stop") {
    phase.price_trigger.reference_price = source.last_fill.price;
    return true;
  }
  return false;
}

/** Activate every waiting phase whose explicit dependencies have been satisfied. */
export function activateEligiblePhases(strategy: StoredStrategy): string[] {
  const activated: string[] = [];
  for (const phase of strategy.dsl.phases) {
    if (phase.status !== "waiting") continue;
    if (!phase.depends_on.every((dependencyId) => dependencySatisfied(strategy, phase, dependencyId))) continue;
    if (!applyFillAnchor(strategy, phase)) continue;
    phase.status = "active";
    activated.push(phase.id);
  }
  return activated;
}

/** Cancel the other legs in the same OCO group after one member records a fill. */
export function cancelOcoPeers(strategy: StoredStrategy, filledPhase: StrategyPhase): string[] {
  if (!filledPhase.cancel_group) return [];
  const cancelled: string[] = [];
  for (const phase of strategy.dsl.phases) {
    if (phase.id === filledPhase.id || phase.cancel_group !== filledPhase.cancel_group) continue;
    if (phase.status === "completed" || phase.status === "cancelled" || phase.status === "failed") continue;
    phase.status = "cancelled";
    phase.cancel_reason = `OCO group '${filledPhase.cancel_group}' filled through phase '${filledPhase.id}'`;
    cancelled.push(phase.id);
  }
  return cancelled;
}

export function recordPhaseFill(phase: StrategyPhase, fill: RecordedPhaseFill): void {
  phase.last_fill = fill;
}

export function nextStrategyStatus(strategy: StoredStrategy): StoredStrategy["status"] {
  if (strategy.dsl.phases.some((phase) => phase.status === "active" || phase.status === "running")) return "active";
  if (strategy.dsl.phases.some((phase) => phase.status === "waiting" || phase.status === "paused" || phase.status === "failed")) return "paused";
  return "completed";
}
