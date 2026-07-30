import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import LineChart from "@/components/admin/line-chart";
import type { ExecutionLogEntry, StrategyLifecycle, StrategyPhase } from "@/types/core";
import "./strategy-dashboard.css";

/** One-line trigger summary for a collapsed phase row. */
function phaseTriggerText(t: StrategyPhase["price_trigger"]): string {
    switch (t.type) {
        case "rolling_change":
            return `${t.direction === "down" ? "drops" : "rises"} ${t.pct}% / ${t.window_minutes}m`;
        case "absolute_threshold":
            return `price ${t.direction === "down" ? "≤" : "≥"} ${t.price}`;
        case "relative_change":
            return `${t.direction === "down" ? "falls" : "rises"} ${t.pct}% from anchor`;
        case "trailing_stop":
            return `trailing ${t.direction === "down" ? "stop" : "rebound"} ${t.pct}%`;
        case "rsi_threshold":
            return `${t.timeframe} RSI(${t.period}) ${t.direction === "below" ? "<" : ">"} ${t.threshold}`;
        case "macd_cross":
            return `${t.timeframe} MACD ${t.direction} cross`;
        case "moving_average_cross":
            return `${t.timeframe} ${t.average_type?.toUpperCase()} ${t.fast_period}/${t.slow_period} ${t.direction} cross`;
    }
}

/** Compact action-size label for a collapsed phase row. */
function phaseSizeText(s: StrategyPhase["action"]["size"]): string {
    switch (s.type) {
        case "pct_of_position":
            return `${s.value}% pos`;
        case "pct_of_portfolio":
            return `${s.value}% port`;
        case "fixed_quote_usd":
            return `$${s.value}`;
        default:
            return `${s.value} base`;
    }
}

const STATUS_TONE: Record<StrategyLifecycle, string> = {
    draft: "dead",
    pending_approval: "wait",
    active: "live",
    running: "live",
    paused: "hold",
    completed: "done",
    cancelled: "dead",
    failed: "fail",
};

function StatusPill({ status }: { status: StrategyLifecycle }) {
    const { t } = useTranslation();
    return (
        <span className="sq-status" data-tone={STATUS_TONE[status] ?? "dead"}>
            <span className="led" />
            {t(`strategies.status.${status}`)}
        </span>
    );
}

function ModeTag({ mode }: { mode: "paper" | "shadow" }) {
    return (
        <span className="sq-mode" data-mode={mode}>
            <span className="dot" />
            {mode}
        </span>
    );
}

function Readout({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "buy" | "sell" | "amber" }) {
    return (
        <div className="sq-readout">
            <span className="k">{k}</span>
            <span className={tone ? `v ${tone}` : "v"}>{v}</span>
        </div>
    );
}

function CopyId({ value }: { value: string }) {
    const [copied, setCopied] = useState(false);
    const head = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
    return (
        <button
            type="button"
            className="sq-copy"
            title={`Copy ${value}`}
            onClick={() => {
                void navigator.clipboard?.writeText(value);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
            }}
        >
            {copied ? "copied" : head}
        </button>
    );
}

export default function StrategyDetailPage() {
    const { t } = useTranslation();
    const { agentId, strategyId } = useParams<{ agentId: string; strategyId: string }>();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: ["user", "strategy", strategyId],
        queryFn: () => apiClient.getStrategy(strategyId ?? ""),
        enabled: !!strategyId,
        refetchInterval: 15_000,
    });

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ["user", "strategies"] });
        void queryClient.invalidateQueries({ queryKey: ["user", "strategy", strategyId] });
    };

    const activate = useMutation({
        mutationFn: (decision: "approve" | "reject") => apiClient.activateStrategy(strategyId ?? "", decision),
        onSuccess: invalidate,
        onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
    });

    const setStatus = useMutation({
        mutationFn: (op: "pause" | "resume" | "cancel") => apiClient.setStrategyStatus(strategyId ?? "", op),
        onSuccess: invalidate,
        onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
    });

    // Which phase rows are expanded. Collapsed by default — click a row to open.
    const [openPhases, setOpenPhases] = useState<Set<string>>(() => new Set());
    const togglePhase = (id: string) =>
        setOpenPhases((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const strategy = query.data?.strategy;
    const executions = useMemo<ExecutionLogEntry[]>(() => query.data?.executions ?? [], [query.data]);

    const sortedExecutions = useMemo(
        () => [...executions].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()),
        [executions],
    );

    const pnlChart = useMemo(() => {
        if (sortedExecutions.length < 2) return null;
        let cumulative = 0;
        const labels: string[] = [];
        const data: number[] = [];
        for (const e of sortedExecutions) {
            cumulative += e.realized_pnl ?? 0;
            labels.push(new Date(e.ts).toLocaleString());
            data.push(cumulative);
        }
        return { labels, data };
    }, [sortedExecutions]);

    if (query.isLoading) {
        return (
            <div className="sq-root">
                <div className="sq-shell">
                    <p className="sq-note">{t("strategies.loading")}</p>
                </div>
            </div>
        );
    }

    if (!strategy) {
        return (
            <div className="sq-root">
                <div className="sq-shell">
                    <NavLink to={`/strategies/${agentId}`} className="sq-back">
                        {t("strategies.backToList")}
                    </NavLink>
                    <p className="sq-note">{t("strategies.notFound")}</p>
                </div>
            </div>
        );
    }

    const dsl = strategy.dsl;
    const phaseById = new Map(dsl.phases.map((phase) => [phase.id, phase]));

    return (
        <div className="sq-root">
            <div className="sq-shell">
                <NavLink to={`/strategies/${agentId}`} className="sq-back sq-rise">
                    {t("strategies.backToList")}
                </NavLink>

                <header className="sq-hero sq-rise" style={{ animationDelay: "40ms" }}>
                    <h1 className="sq-hero-symbol">{dsl.name || strategy.symbol}</h1>
                    <StatusPill status={strategy.status} />
                    <ModeTag mode={dsl.mode} />
                </header>

                <div className="sq-phases sq-rise" style={{ animationDelay: "90ms" }}>
                    <div className="sq-phases-head">
                        <span>#</span>
                        <span>{t("strategies.config.phase", "Phase")}</span>
                        <span>{t("strategies.columns.status")}</span>
                        <span>{t("strategies.config.execution", "Execution")}</span>
                        <span />
                    </div>

                    {dsl.phases.map((phase, index) => {
                        const trigger = phase.price_trigger;
                        const action = phase.action;
                        const recurrence = phase.recurrence;
                        const sideTone = action.side === "BUY" ? "buy" : "sell";
                        const isOpen = openPhases.has(phase.id);
                        return (
                            <section className="sq-phase-row" key={phase.id} data-open={isOpen} data-testid="phase-row">
                                <button
                                    type="button"
                                    className="sq-phase-head"
                                    onClick={() => togglePhase(phase.id)}
                                    aria-expanded={isOpen}
                                >
                                    <span className="sq-phase-idx">{String(index + 1).padStart(2, "0")}</span>
                                    <span className="sq-phase-name">{phase.name}</span>
                                    <span className="sq-phase-status" data-status={phase.status}>
                                        <span className="led" />
                                        {phase.status}
                                    </span>
                                    <span className="sq-phase-exec">
                                        <span className="t">{phaseTriggerText(trigger)}</span>
                                        <span className="arrow">→</span>
                                        <span className={`side ${sideTone}`}>{action.side}</span>
                                        <span className="sz">{phaseSizeText(action.size)}</span>
                                    </span>
                                    <span className="sq-chevron" aria-hidden>▾</span>
                                </button>

                                {isOpen && (
                                    <div className="sq-phase-body">
                                        <div className="sq-phase-grid">
                                            <Readout k={t("strategies.config.triggerType")} v={trigger.type} />
                                            <Readout k={t("strategies.config.direction")} v={trigger.direction} />
                                            {trigger.pct !== undefined && (
                                                <Readout k={t("strategies.config.pct")} v={`${trigger.pct}%`} tone="amber" />
                                            )}
                                            {trigger.window_minutes !== undefined && (
                                                <Readout k={t("strategies.config.windowMinutes")} v={`${trigger.window_minutes}m`} />
                                            )}
                                            {trigger.price !== undefined && (
                                                <Readout k={t("strategies.config.price")} v={trigger.price} tone="amber" />
                                            )}
                                            {trigger.reference_price !== undefined && (
                                                <Readout k={t("strategies.config.referencePrice", "Ref price")} v={trigger.reference_price} />
                                            )}
                                            {trigger.threshold !== undefined && (
                                                <Readout k="Threshold" v={trigger.threshold} tone="amber" />
                                            )}
                                            {trigger.timeframe !== undefined && (
                                                <Readout k="Timeframe" v={trigger.timeframe} />
                                            )}
                                            {trigger.period !== undefined && (
                                                <Readout k="Period" v={trigger.period} />
                                            )}
                                            {trigger.average_type !== undefined && (
                                                <Readout k="Average" v={trigger.average_type.toUpperCase()} />
                                            )}
                                            {trigger.fast_period !== undefined && (
                                                <Readout k="Fast period" v={trigger.fast_period} />
                                            )}
                                            {trigger.slow_period !== undefined && (
                                                <Readout k="Slow period" v={trigger.slow_period} />
                                            )}
                                            {trigger.signal_period !== undefined && (
                                                <Readout k="Signal period" v={trigger.signal_period} />
                                            )}
                                            <Readout k={t("strategies.config.confirmSamples")} v={trigger.confirm_samples ?? 2} />
                                            <Readout k={t("strategies.config.side")} v={action.side} tone={sideTone} />
                                            <Readout k={t("strategies.config.size")} v={`${action.size.value} · ${action.size.type}`} />
                                            <Readout k={t("strategies.config.orderType")} v={action.order_type} />
                                            <Readout k={t("strategies.config.maxSlippage")} v={`${action.max_slippage_bps ?? 0} bps`} />
                                            <Readout k={t("strategies.config.mode")} v={recurrence.mode} />
                                            {recurrence.cooldown_minutes !== undefined && (
                                                <Readout k={t("strategies.config.cooldown")} v={`${recurrence.cooldown_minutes}m`} />
                                            )}
                                            <Readout
                                                k={t("strategies.config.triggerCount")}
                                                v={`${recurrence.trigger_count ?? 0}${recurrence.max_triggers ? ` / ${recurrence.max_triggers}` : ""}`}
                                                tone="amber"
                                            />
                                            {phase.depends_on.length > 0 && (
                                                <Readout k="Depends on" v={`${phase.depends_on.join(", ")} · ${phase.activate_on}`} />
                                            )}
                                            {phase.price_anchor && (
                                                <Readout k="Price anchor" v={`fill from ${phase.price_anchor.phase_id}`} />
                                            )}
                                            {phase.cancel_group && <Readout k="OCO group" v={phase.cancel_group} />}
                                            {phase.last_fill && (
                                                <Readout k="Last fill" v={`${phase.last_fill.quantity} @ ${phase.last_fill.price}`} tone="amber" />
                                            )}
                                            {phase.cancel_reason && <Readout k="Cancelled" v={phase.cancel_reason} />}
                                            {phase.failure_reason && <Readout k="Failure" v={phase.failure_reason} tone="amber" />}
                                        </div>
                                    </div>
                                )}
                            </section>
                        );
                    })}

                    {(dsl.guardrails?.max_notional_usd !== undefined || dsl.guardrails?.total_budget_usd !== undefined) && (
                        <div className="sq-guardrails">
                            <span className="sq-guardrails-k">{t("strategies.config.guardrails")}</span>
                            {dsl.guardrails.max_notional_usd !== undefined && (
                                <span className="sq-guardrails-v">
                                    {t("strategies.config.maxNotional")} <b>${dsl.guardrails.max_notional_usd}</b>
                                </span>
                            )}
                            {dsl.guardrails.total_budget_usd !== undefined && (
                                <span className="sq-guardrails-v">
                                    Total budget <b>${dsl.guardrails.total_budget_usd}</b>
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {(strategy.status === "pending_approval" ||
                    strategy.status === "active" ||
                    strategy.status === "paused") && (
                    <div className="sq-actions sq-rise" style={{ animationDelay: "140ms" }}>
                        {strategy.status === "pending_approval" && (
                            <>
                                <button
                                    type="button"
                                    className="sq-key"
                                    data-variant="primary"
                                    onClick={() => activate.mutate("approve")}
                                    disabled={activate.isPending}
                                >
                                    {t("strategies.actions.approve")}
                                </button>
                                <button
                                    type="button"
                                    className="sq-key"
                                    onClick={() => activate.mutate("reject")}
                                    disabled={activate.isPending}
                                >
                                    {t("strategies.actions.reject")}
                                </button>
                            </>
                        )}
                        {strategy.status === "active" && (
                            <>
                                <button
                                    type="button"
                                    className="sq-key"
                                    onClick={() => setStatus.mutate("pause")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.pause")}
                                </button>
                                <button
                                    type="button"
                                    className="sq-key"
                                    data-variant="danger"
                                    onClick={() => setStatus.mutate("cancel")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.cancel")}
                                </button>
                            </>
                        )}
                        {strategy.status === "paused" && (
                            <>
                                <button
                                    type="button"
                                    className="sq-key"
                                    data-variant="primary"
                                    onClick={() => setStatus.mutate("resume")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.resume")}
                                </button>
                                <button
                                    type="button"
                                    className="sq-key"
                                    data-variant="danger"
                                    onClick={() => setStatus.mutate("cancel")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.cancel")}
                                </button>
                            </>
                        )}
                    </div>
                )}

                <div className="sq-rise" style={{ animationDelay: "180ms" }}>
                    <h2 className="sq-section-label">{t("strategies.pnlChart")}</h2>
                    {pnlChart ? (
                        <div className="sq-scope">
                            <LineChart
                                labels={pnlChart.labels}
                                datasets={[
                                    {
                                        label: t("strategies.pnlChart"),
                                        data: pnlChart.data,
                                        borderColor: "#4ade80",
                                        backgroundColor: "rgba(74, 222, 128, 0.14)",
                                    },
                                ]}
                                beginAtZero={false}
                            />
                        </div>
                    ) : (
                        <p className="sq-note">{t("strategies.pnlChartEmpty")}</p>
                    )}
                </div>

                <div className="sq-rise" style={{ animationDelay: "220ms" }}>
                    <h2 className="sq-section-label">{t("strategies.executions")}</h2>
                    {executions.length === 0 ? (
                        <p className="sq-note">{t("strategies.noExecutions")}</p>
                    ) : (
                        <div className="sq-ledger">
                            <table className="sq-table">
                                <thead>
                                    <tr>
                                        <th>{t("strategies.columns.time")}</th>
                                        <th>{t("strategies.config.side")}</th>
                                        <th>{t("strategies.columns.fillPrice")}</th>
                                        <th>{t("strategies.columns.realizedPnl")}</th>
                                        <th>{t("strategies.columns.orderId")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...executions].reverse().map((e) => {
                                        const fillPrice =
                                            (e.order_result?.["fillPrice"] as number | undefined) ??
                                            (e.trigger_snapshot?.["price"] as number | undefined);
                                        const pnl = e.realized_pnl ?? 0;
                                        const phase = phaseById.get(e.phase_id);
                                        return (
                                            <tr key={e.execution_id} style={{ cursor: "default" }}>
                                                <td className="sq-cell-faint">{new Date(e.ts).toLocaleString()}</td>
                                                <td className="sq-cell-mono">{phase?.action.side ?? "—"}</td>
                                                <td className="sq-cell-mono">{fillPrice ?? "—"}</td>
                                                <td
                                                    className={
                                                        pnl > 0 ? "sq-cell-mono sq-pnl-pos" : pnl < 0 ? "sq-cell-mono sq-pnl-neg" : "sq-cell-mono"
                                                    }
                                                >
                                                    {pnl > 0 ? `+${pnl}` : pnl}
                                                </td>
                                                <td>{e.order_id ? <CopyId value={e.order_id} /> : <span className="sq-cell-faint">—</span>}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
