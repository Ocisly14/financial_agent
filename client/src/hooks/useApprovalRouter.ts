/**
 * §7.4 — Approval-UX router. Single canonical surface for trading-class
 * approvals: when an interrupt's metadata says it's a trading approval,
 * the canonical `CEXApprovalDialog` MUST render — never the generic
 * `HumanInputDialog`. Detection uses interrupt metadata only; never
 * free-form text.
 *
 * The trading-context detection lives here so any caller (chat,
 * notification, deep-link recovery) routes through the same rules.
 */

export type ApprovalSurface = "cex" | "generic";

export interface ApprovalContext {
    interruptType?: string;
    actionName?: string;
    kind?: string;
}

const TRADING_INTERRUPT_TYPES: ReadonlySet<string> = new Set([
    "cex_workflow_parameter_review_required",
    "cex_workflow_parameter_final_confirm_required",
]);

const TRADING_ACTION_NAMES: ReadonlySet<string> = new Set([
    "create_order",
    "cancel_order",
    "amend_order",
    "preview_order",
    "compile_strategy",
    "activate_strategy",
    "run_backtest",
    "set_trading_mode",
]);

export function detectApprovalSurface(ctx: ApprovalContext): ApprovalSurface {
    // Explicit "kind=trading" wins over heuristics.
    if (ctx.kind === "trading") return "cex";
    if (ctx.interruptType && TRADING_INTERRUPT_TYPES.has(ctx.interruptType)) return "cex";
    if (ctx.actionName && TRADING_ACTION_NAMES.has(ctx.actionName)) return "cex";
    return "generic";
}

/** Reactish hook entry point — call from the component that owns the interrupt. */
export function useApprovalRouter() {
    return { detectApprovalSurface };
}
