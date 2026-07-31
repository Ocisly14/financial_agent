import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import LineChart from "@/components/admin/line-chart";
import type { ExecutionLogEntry, StrategyLifecycle, StrategyPhase } from "@/types/core";
import { Button } from "@/components/ui/button";
import { ModeChip } from "@/components/workspace/ModeChip";

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

/** Lifecycle → status-pill tone. Tones are rendered by TONE_CLASSES below. */
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

/** Phase status → the same tone vocabulary as STATUS_TONE. */
const PHASE_STATUS_TONE: Record<StrategyPhase["status"], string> = {
    waiting: "hold",
    active: "live",
    running: "wait",
    completed: "done",
    paused: "hold",
    cancelled: "dead",
    failed: "fail",
};

/** Tone → design-token classes for a status pill and its dot. */
const TONE_CLASSES: Record<string, { pill: string; dot: string }> = {
    live: { pill: "border-up/40 bg-up/10 text-up", dot: "bg-up" },
    wait: { pill: "border-hold/40 bg-hold/10 text-hold", dot: "bg-hold" },
    hold: { pill: "border-sep-strong bg-fill-2 text-label-2", dot: "bg-label-2" },
    done: { pill: "border-sep bg-fill-1 text-label-3", dot: "bg-label-3" },
    dead: { pill: "border-sep bg-fill-1 text-label-4", dot: "bg-label-4" },
    fail: { pill: "border-down/40 bg-down/10 text-down", dot: "bg-down" },
};

function StatusPill({ status }: { status: StrategyLifecycle }) {
    const { t } = useTranslation();
    const tone = TONE_CLASSES[STATUS_TONE[status] ?? "dead"];
    return (
        <span className={cn("fin-label inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-1", tone.pill)}>
            <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
            {t(`strategies.status.${status}`)}
        </span>
    );
}

function PhaseStatusPill({ status }: { status: StrategyPhase["status"] }) {
    const tone = TONE_CLASSES[PHASE_STATUS_TONE[status] ?? "dead"];
    return (
        <span
            className={cn(
                "fin-label inline-flex w-fit items-center gap-1.5 rounded-[4px] border px-1.5 py-0.5 text-[9px]",
                tone.pill,
            )}
        >
            <span className={cn("size-1 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
            {status}
        </span>
    );
}

function Readout({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "buy" | "sell" | "amber" }) {
    return (
        <div className="flex items-baseline justify-between gap-4 border-b border-sep py-2 last:border-0">
            <span className="fin-label text-label-3">{k}</span>
            <span
                className={cn(
                    "fin-figure text-right text-sm text-label-1",
                    tone === "buy" && "text-up",
                    tone === "sell" && "text-down",
                    tone === "amber" && "text-hold",
                )}
            >
                {v}
            </span>
        </div>
    );
}

function CopyId({ value }: { value: string }) {
    const [copied, setCopied] = useState(false);
    const head = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
    return (
        <button
            type="button"
            className="fin-figure text-xs text-label-3 transition-colors hover:text-label-1"
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
            <div className="min-h-dvh bg-background">
                <div className="mx-auto max-w-6xl px-6 py-8">
                    <p className="text-sm text-label-2">{t("strategies.loading")}</p>
                </div>
            </div>
        );
    }

    if (!strategy) {
        return (
            <div className="min-h-dvh bg-background">
                <div className="mx-auto max-w-6xl px-6 py-8">
                    <NavLink to={`/strategies/${agentId}`} className="mb-6 inline-block text-sm text-label-2 hover:text-label-1">
                        {t("strategies.backToList")}
                    </NavLink>
                    <p className="text-sm text-label-2">{t("strategies.notFound")}</p>
                </div>
            </div>
        );
    }

    const dsl = strategy.dsl;
    const phaseById = new Map(dsl.phases.map((phase) => [phase.id, phase]));

    return (
        <div className="min-h-dvh bg-background">
            <div className="mx-auto max-w-6xl px-6 py-8">
                <NavLink to={`/strategies/${agentId}`} className="mb-6 inline-block text-sm text-label-2 hover:text-label-1">
                    {t("strategies.backToList")}
                </NavLink>

                <header className="mb-6 flex flex-wrap items-center gap-3 border-b border-sep pb-6">
                    <h1 className="text-2xl font-semibold tracking-[-0.02em]">{dsl.name || strategy.symbol}</h1>
                    <StatusPill status={strategy.status} />
                    <ModeChip mode={dsl.mode} />
                </header>

                <div className="material mb-6 overflow-hidden rounded-lg border border-sep shadow-e2-rim">
                    <div className="grid grid-cols-[42px_minmax(110px,1.1fr)_128px_minmax(180px,1.7fr)_26px] items-center gap-3.5 border-b border-sep px-4 py-3">
                        <span className="fin-label text-label-3">#</span>
                        <span className="fin-label text-label-3">{t("strategies.config.phase", "Phase")}</span>
                        <span className="fin-label text-label-3">{t("strategies.columns.status")}</span>
                        <span className="fin-label text-label-3">{t("strategies.config.execution", "Execution")}</span>
                        <span />
                    </div>

                    {dsl.phases.map((phase, index) => {
                        const trigger = phase.price_trigger;
                        const action = phase.action;
                        const recurrence = phase.recurrence;
                        const sideTone = action.side === "BUY" ? "buy" : "sell";
                        const isOpen = openPhases.has(phase.id);
                        return (
                            <section
                                className={cn("border-b border-sep last:border-0", isOpen && "bg-hold/5")}
                                key={phase.id}
                                data-testid="phase-row"
                            >
                                <button
                                    type="button"
                                    className="grid w-full grid-cols-[42px_minmax(110px,1.1fr)_128px_minmax(180px,1.7fr)_26px] items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-fill-1"
                                    onClick={() => togglePhase(phase.id)}
                                    aria-expanded={isOpen}
                                >
                                    <span className="fin-figure text-xs text-label-3">{String(index + 1).padStart(2, "0")}</span>
                                    <span className="truncate text-sm font-semibold text-label-1">{phase.name}</span>
                                    <PhaseStatusPill status={phase.status} />
                                    <span className="fin-figure flex min-w-0 items-center gap-2 text-xs text-label-2">
                                        <span className="truncate">{phaseTriggerText(trigger)}</span>
                                        <span className="text-label-3">→</span>
                                        <span className={cn("font-semibold", sideTone === "buy" ? "text-up" : "text-down")}>
                                            {action.side}
                                        </span>
                                        <span className="whitespace-nowrap text-label-1">{phaseSizeText(action.size)}</span>
                                    </span>
                                    <span
                                        className={cn(
                                            "justify-self-end text-xs text-label-3 transition-transform",
                                            isOpen && "rotate-180 text-label-1",
                                        )}
                                        aria-hidden
                                    >
                                        ▾
                                    </span>
                                </button>

                                {isOpen && (
                                    <div className="px-4 pb-4">
                                        <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-x-6 border-t border-sep pt-1">
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
                        <div className="flex flex-wrap items-center gap-4 border-t border-sep bg-fill-1 px-4 py-3">
                            <span className="fin-label text-label-3">{t("strategies.config.guardrails")}</span>
                            {dsl.guardrails.max_notional_usd !== undefined && (
                                <span className="fin-figure text-xs text-label-2">
                                    {t("strategies.config.maxNotional")} <b className="font-semibold text-hold">${dsl.guardrails.max_notional_usd}</b>
                                </span>
                            )}
                            {dsl.guardrails.total_budget_usd !== undefined && (
                                <span className="fin-figure text-xs text-label-2">
                                    Total budget <b className="font-semibold text-hold">${dsl.guardrails.total_budget_usd}</b>
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {(strategy.status === "pending_approval" ||
                    strategy.status === "active" ||
                    strategy.status === "paused") && (
                    <div className="mb-8 flex flex-wrap gap-2">
                        {strategy.status === "pending_approval" && (
                            <>
                                <Button
                                    type="button"
                                    onClick={() => activate.mutate("approve")}
                                    disabled={activate.isPending}
                                >
                                    {t("strategies.actions.approve")}
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => activate.mutate("reject")}
                                    disabled={activate.isPending}
                                >
                                    {t("strategies.actions.reject")}
                                </Button>
                            </>
                        )}
                        {strategy.status === "active" && (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setStatus.mutate("pause")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.pause")}
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={() => setStatus.mutate("cancel")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.cancel")}
                                </Button>
                            </>
                        )}
                        {strategy.status === "paused" && (
                            <>
                                <Button
                                    type="button"
                                    onClick={() => setStatus.mutate("resume")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.resume")}
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={() => setStatus.mutate("cancel")}
                                    disabled={setStatus.isPending}
                                >
                                    {t("strategies.actions.cancel")}
                                </Button>
                            </>
                        )}
                    </div>
                )}

                <div className="mb-8">
                    <h2 className="fin-label mb-3 flex items-center gap-3 text-label-3">
                        <span>{t("strategies.pnlChart")}</span>
                        <span className="h-px flex-1 bg-sep" />
                    </h2>
                    {pnlChart ? (
                        <div className="relative mb-2 h-[220px] rounded-lg border border-sep bg-fill-1 p-4">
                            <LineChart
                                labels={pnlChart.labels}
                                datasets={[
                                    {
                                        label: t("strategies.pnlChart"),
                                        data: pnlChart.data,
                                        borderColor: "rgb(var(--up-rgb))",
                                        backgroundColor: "rgb(var(--up-rgb) / 0.14)",
                                    },
                                ]}
                                beginAtZero={false}
                            />
                        </div>
                    ) : (
                        <p className="text-sm text-label-2">{t("strategies.pnlChartEmpty")}</p>
                    )}
                </div>

                <div>
                    <h2 className="fin-label mb-3 flex items-center gap-3 text-label-3">
                        <span>{t("strategies.executions")}</span>
                        <span className="h-px flex-1 bg-sep" />
                    </h2>
                    {executions.length === 0 ? (
                        <p className="text-sm text-label-2">{t("strategies.noExecutions")}</p>
                    ) : (
                        <div className="material overflow-hidden rounded-lg border border-sep shadow-e2-rim">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr>
                                        <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                            {t("strategies.columns.time")}
                                        </th>
                                        <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                            {t("strategies.config.side")}
                                        </th>
                                        <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                            {t("strategies.columns.fillPrice")}
                                        </th>
                                        <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                            {t("strategies.columns.realizedPnl")}
                                        </th>
                                        <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                            {t("strategies.columns.orderId")}
                                        </th>
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
                                            <tr key={e.execution_id} className="border-b border-sep last:border-0">
                                                <td className="px-4 py-3 align-middle text-label-3">{new Date(e.ts).toLocaleString()}</td>
                                                <td className="fin-figure px-4 py-3 align-middle text-label-2">{phase?.action.side ?? "—"}</td>
                                                <td className="fin-figure px-4 py-3 align-middle text-label-2">{fillPrice ?? "—"}</td>
                                                <td
                                                    className={cn(
                                                        "fin-figure px-4 py-3 align-middle",
                                                        pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-label-2",
                                                    )}
                                                >
                                                    {pnl > 0 ? `+${pnl}` : pnl}
                                                </td>
                                                <td className="px-4 py-3 align-middle">
                                                    {e.order_id ? <CopyId value={e.order_id} /> : <span className="text-label-3">—</span>}
                                                </td>
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
