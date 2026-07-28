import type { PriceStrategyDSL, StrategyPhase } from "@/types/core";

function phaseTrigger(phase: StrategyPhase): string {
    const t = phase.price_trigger;
    return t.type === "rolling_change"
        ? `${t.direction === "down" ? "drops" : "rises"} ${t.pct}% within ${t.window_minutes}m`
        : t.type === "absolute_threshold"
            ? `price ${t.direction === "down" ? "<" : ">"} ${t.price}`
            : `trailing ${t.direction === "down" ? "stop" : "rebound"} ${t.pct}%`;
}

function phaseSize(phase: StrategyPhase): string {
    const s = phase.action.size;
    return s.type === "pct_of_position"
        ? `${s.value}% position`
        : s.type === "pct_of_portfolio"
            ? `${s.value}% portfolio`
            : s.type === "fixed_quote_usd"
                ? `$${s.value}`
                : `${s.value} base`;
}

export function summarizePhase(phase: StrategyPhase): string {
    return `${phase.name}: ${phaseTrigger(phase)} -> ${phase.action.side} ${phaseSize(phase)}`;
}

export function summarizeStrategy(dsl: PriceStrategyDSL): string {
    return dsl.phases.map(summarizePhase).join(" | ");
}

export function summarizeRecurrence(dsl: PriceStrategyDSL): string {
    const recurring = dsl.phases.filter((phase) => phase.recurrence.mode === "recurring").length;
    return recurring > 0 ? `${dsl.phases.length} phases, ${recurring} recurring` : `${dsl.phases.length} phases`;
}
