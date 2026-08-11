import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { summarizeRecurrence, summarizeStrategy } from "@/lib/strategySummary";
import type { StoredStrategy, StrategyLifecycle } from "@/types/core";
import { Button } from "@/components/ui/button";
import { ModeChip, useTradingMode } from "@/components/workspace/ModeChip";

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

/** Tone → design-token classes for the status pill and its dot. */
const TONE_CLASSES: Record<string, { pill: string; dot: string }> = {
    live: { pill: "border-up/40 bg-up/10 text-up", dot: "bg-up" },
    wait: { pill: "border-hold/40 bg-hold/10 text-hold", dot: "bg-hold" },
    hold: { pill: "border-sep-strong bg-fill-2 text-label-2", dot: "bg-label-2" },
    done: { pill: "border-sep bg-fill-1 text-label-3", dot: "bg-label-3" },
    dead: { pill: "border-sep bg-fill-1 text-label-4", dot: "bg-label-4" },
    fail: { pill: "border-down/40 bg-down/10 text-down", dot: "bg-down" },
};

const STATUS_FILTERS: Array<StrategyLifecycle | ""> = [
    "",
    "draft",
    "pending_approval",
    "active",
    "running",
    "paused",
    "completed",
    "cancelled",
    "failed",
];

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

export default function StrategiesPage() {
    const { t } = useTranslation();
    const { agentId } = useParams<{ agentId: string }>();
    const navigate = useNavigate();
    const [statusFilter, setStatusFilter] = useState<StrategyLifecycle | "">("");
    const tradingMode = useTradingMode();

    const query = useQuery({
        queryKey: ["user", "strategies"],
        queryFn: async () => {
            const res = await apiClient.listStrategies();
            return res.strategies;
        },
        refetchInterval: 15_000,
    });

    const strategies = useMemo(() => {
        const all = query.data ?? [];
        return statusFilter ? all.filter((s) => s.status === statusFilter) : all;
    }, [query.data, statusFilter]);

    const activeCount = useMemo(
        () => (query.data ?? []).filter((s) => s.status === "active" || s.status === "running").length,
        [query.data],
    );

    return (
        <div className="min-h-dvh bg-background">
            <div className="mx-auto max-w-6xl px-6 py-8">
                <header className="flex items-baseline justify-between gap-4 border-b border-sep pb-6">
                    <div>
                        <span className="fin-label text-label-3">{t("strategies.tabs.strategies")}</span>
                        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em]">{t("strategies.title")}</h1>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                        <ModeChip mode={tradingMode} />
                        <span className="fin-figure text-xs text-label-3">
                            {t("strategies.summary.total", { count: (query.data ?? []).length })} ·{" "}
                            {t("strategies.summary.active", { count: activeCount })}
                        </span>
                    </div>
                </header>

                <nav className="my-6 flex items-center gap-1">
                    <Button asChild variant="ghost" size="sm" className="bg-fill-2 text-label-1 hover:bg-fill-2">
                        <NavLink to={`/strategies/${agentId}`}>{t("strategies.tabs.strategies")}</NavLink>
                    </Button>
                </nav>

                <div className="mb-6 flex flex-wrap items-center gap-1.5">
                    {STATUS_FILTERS.map((value) => {
                        const isActive = statusFilter === value;
                        return (
                            <button
                                key={value || "all"}
                                type="button"
                                className={cn(
                                    "fin-figure shrink-0 rounded-[5px] border px-2.5 py-1 text-xs font-semibold tracking-wide transition-colors",
                                    isActive
                                        ? "border-foreground/20 bg-foreground text-background"
                                        : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/25 hover:bg-muted hover:text-foreground",
                                )}
                                onClick={() => setStatusFilter(value)}
                            >
                                {value === "" ? t("strategies.filters.all") : t(`strategies.status.${value}`)}
                            </button>
                        );
                    })}
                </div>

                {query.isLoading ? (
                    <p className="text-sm text-label-2">{t("strategies.loading")}</p>
                ) : strategies.length === 0 ? (
                    <p className="text-sm text-label-2">{t("strategies.empty")}</p>
                ) : (
                    <div className="material overflow-hidden rounded-lg border border-sep shadow-e2-rim" data-testid="strategies-table">
                        <table className="w-full text-sm">
                            <thead>
                                <tr>
                                    <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                        {t("strategies.columns.status")}
                                    </th>
                                    <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                        {t("strategies.columns.symbol")}
                                    </th>
                                    <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                        {t("strategies.columns.mode")}
                                    </th>
                                    <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                        {t("strategies.columns.trigger")}
                                    </th>
                                    <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                        {t("strategies.columns.recurrence")}
                                    </th>
                                    <th className="fin-label border-b border-sep px-4 py-3 text-left text-label-3">
                                        {t("strategies.columns.created")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {strategies.map((s: StoredStrategy) => (
                                    <tr
                                        key={s.id}
                                        data-testid="strategies-row"
                                        className="cursor-pointer border-b border-sep transition-colors last:border-0 hover:bg-fill-1"
                                        onClick={() => navigate(`/strategies/${agentId}/${s.id}`)}
                                    >
                                        <td className="px-4 py-3.5 align-middle">
                                            <StatusPill status={s.status} />
                                        </td>
                                        <td className="px-4 py-3.5 align-middle">
                                            <span className="fin-figure text-sm font-semibold text-label-1">{s.symbol}</span>
                                        </td>
                                        <td className="px-4 py-3.5 align-middle">
                                            <ModeChip mode={s.dsl.mode} />
                                        </td>
                                        <td className="fin-figure px-4 py-3.5 align-middle text-label-2">{summarizeStrategy(s.dsl)}</td>
                                        <td className="px-4 py-3.5 align-middle text-label-3">{summarizeRecurrence(s.dsl)}</td>
                                        <td className="px-4 py-3.5 align-middle text-label-3">{new Date(s.created_at).toLocaleString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
