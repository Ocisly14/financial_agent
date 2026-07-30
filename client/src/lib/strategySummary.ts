import type { PriceStrategyDSL, StrategyPhase } from "@/types/core";

function phaseTrigger(phase: StrategyPhase): string {
    const t = phase.price_trigger;
    switch (t.type) {
        case "rolling_change":
            return `${t.direction === "down" ? "drops" : "rises"} ${t.pct}% within ${t.window_minutes}m`;
        case "absolute_threshold":
            return `price ${t.direction === "down" ? "<" : ">"} ${t.price}`;
        case "trailing_stop":
            return `trailing ${t.direction === "down" ? "stop" : "rebound"} ${t.pct}%`;
        case "rsi_threshold":
            return `${t.timeframe} RSI(${t.period}) ${t.direction === "below" ? "<" : ">"} ${t.threshold}`;
        case "macd_cross":
            return `${t.timeframe} MACD(${t.fast_period},${t.slow_period},${t.signal_period}) ${t.direction} cross`;
        case "moving_average_cross":
            return `${t.timeframe} ${t.average_type?.toUpperCase()}(${t.fast_period},${t.slow_period}) ${t.direction} cross`;
    }
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
