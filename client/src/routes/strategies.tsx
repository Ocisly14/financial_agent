import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/lib/api";
import { useTradingPreferences } from "@/hooks/useTradingPreferences";
import { summarizeRecurrence, summarizeStrategy } from "@/lib/strategySummary";
import type { StoredStrategy, StrategyLifecycle } from "@/types/core";
import "./strategy-dashboard.css";

/** Lifecycle → visual tone for the status pill (see strategy-dashboard.css). */
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
    return (
        <span className="sq-status" data-tone={STATUS_TONE[status] ?? "dead"}>
            <span className="led" />
            {t(`strategies.status.${status}`)}
        </span>
    );
}

function ModeTag({ mode }: { mode: "paper" | "shadow" | "live" }) {
    return (
        <span className="sq-mode" data-mode={mode}>
            <span className="dot" />
            {mode}
        </span>
    );
}

export default function StrategiesPage() {
    const { t } = useTranslation();
    const { agentId } = useParams<{ agentId: string }>();
    const navigate = useNavigate();
    const prefs = useTradingPreferences();
    const [statusFilter, setStatusFilter] = useState<StrategyLifecycle | "">("");

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
        <div className="sq-root">
            <div className="sq-shell">
                <header className="sq-masthead sq-rise">
                    <div>
                        <span className="sq-kicker">Auto-Trading · Desk</span>
                        <h1 className="sq-title">
                            STRAT<em>EGIES</em>
                        </h1>
                    </div>
                    <div className="sq-masthead-meta">
                        <ModeTag mode={prefs.data?.default_mode ?? "paper"} />
                        <div style={{ marginTop: 10 }}>
                            {(query.data ?? []).length} TOTAL · {activeCount} LIVE
                        </div>
                    </div>
                </header>

                <nav className="sq-tabs sq-rise" style={{ animationDelay: "60ms" }}>
                    <NavLink to={`/orders/${agentId}`} className="sq-tab">
                        {t("strategies.tabs.orders")}
                    </NavLink>
                    <NavLink to={`/floor/${agentId}`} className="sq-tab">
                        Floor
                    </NavLink>
                    <NavLink to={`/strategies/${agentId}`} className="sq-tab" data-active="true">
                        {t("strategies.tabs.strategies")}
                    </NavLink>
                </nav>

                <div className="sq-filters sq-rise" style={{ animationDelay: "110ms" }}>
                    {STATUS_FILTERS.map((value) => (
                        <button
                            key={value || "all"}
                            type="button"
                            className="sq-chip"
                            data-active={statusFilter === value}
                            onClick={() => setStatusFilter(value)}
                        >
                            {value === "" ? t("strategies.filters.all") : t(`strategies.status.${value}`)}
                        </button>
                    ))}
                </div>

                {query.isLoading ? (
                    <p className="sq-note">{t("strategies.loading")}</p>
                ) : strategies.length === 0 ? (
                    <p className="sq-note">{t("strategies.empty")}</p>
                ) : (
                    <div className="sq-board sq-rise" style={{ animationDelay: "160ms" }} data-testid="strategies-table">
                        <table className="sq-table">
                            <thead>
                                <tr>
                                    <th>{t("strategies.columns.status")}</th>
                                    <th>{t("strategies.columns.symbol")}</th>
                                    <th>{t("strategies.columns.mode")}</th>
                                    <th>{t("strategies.columns.trigger")}</th>
                                    <th>{t("strategies.columns.recurrence")}</th>
                                    <th>{t("strategies.columns.created")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {strategies.map((s: StoredStrategy, i: number) => (
                                    <tr
                                        key={s.id}
                                        data-testid="strategies-row"
                                        className="sq-rise"
                                        style={{ animationDelay: `${200 + i * 45}ms` }}
                                        onClick={() => navigate(`/strategies/${agentId}/${s.id}`)}
                                    >
                                        <td>
                                            <StatusPill status={s.status} />
                                        </td>
                                        <td>
                                            <span className="sq-symbol">{s.symbol}</span>
                                        </td>
                                        <td>
                                            <ModeTag mode={s.dsl.mode} />
                                        </td>
                                        <td className="sq-cell-mono">{summarizeStrategy(s.dsl)}</td>
                                        <td className="sq-cell-faint">{summarizeRecurrence(s.dsl)}</td>
                                        <td className="sq-cell-faint">{new Date(s.created_at).toLocaleString()}</td>
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
