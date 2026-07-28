import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/lib/api";
import { useTradingPreferences } from "@/hooks/useTradingPreferences";
import "./strategy-dashboard.css";

type LedgerRow = {
    request_id: string;
    client_order_id: string;
    venue: string;
    symbol: string;
    state: string;
    submittedAt: string;
    lastSeenAt: string;
    locale?: string;
};

/** Order state → visual tone for the status pill (see strategy-dashboard.css). */
const STATE_TONE: Record<string, string> = {
    submitted: "wait",
    acked: "wait",
    partially_filled: "wait",
    filled: "done",
    cancelled: "dead",
    expired: "dead",
    rejected: "fail",
    reconciliation_failed: "fail",
    unknown: "hold",
};

const STATE_LABEL: Record<string, string> = {
    submitted: "pending",
    acked: "submitted",
    partially_filled: "partially filled",
    filled: "filled",
    cancelled: "canceled",
    expired: "expired",
    rejected: "failed",
    reconciliation_failed: "failed",
    unknown: "unknown",
};

const FILTERS: Array<{ value: string; label: string }> = [
    { value: "", label: "All" },
    { value: "submitted", label: "Pending" },
    { value: "acked", label: "Submitted" },
    { value: "partially_filled", label: "Partial" },
    { value: "filled", label: "Filled" },
    { value: "cancelled", label: "Canceled" },
    { value: "rejected", label: "Failed" },
    { value: "unknown", label: "Unknown" },
];

function StatusPill({ state }: { state: string }) {
    return (
        <span className="sq-status" data-tone={STATE_TONE[state] ?? "hold"}>
            <span className="led" />
            {STATE_LABEL[state] ?? state}
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

function CopyId({ value }: { value: string }) {
    const [copied, setCopied] = useState(false);
    const head = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
    return (
        <button
            type="button"
            className="sq-copy"
            title={`Copy ${value}`}
            onClick={(e) => {
                e.preventDefault();
                void navigator.clipboard?.writeText(value);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
            }}
        >
            {copied ? "copied" : head}
        </button>
    );
}

function CancelChip({ orderId, venue }: { orderId: string; venue: string | null }) {
    return (
        <button
            type="button"
            data-testid="orders-row-cancel"
            className="sq-cancel"
            onClick={() => {
                const venueClause = venue ? ` on ${venue}` : "";
                window.dispatchEvent(
                    new CustomEvent("financial-agent:chat-send", {
                        detail: { text: `cancel order ${orderId}${venueClause}`, source: "orders_page" },
                    }),
                );
            }}
        >
            Cancel
        </button>
    );
}

const OPEN_STATES = new Set(["submitted", "acked", "partially_filled", "unknown"]);

export default function OrdersPage() {
    const { t } = useTranslation();
    const { agentId } = useParams<{ agentId: string }>();
    const prefs = useTradingPreferences();
    const [stateFilter, setStateFilter] = useState<string>("");
    const [venueFilter, setVenueFilter] = useState<string>("");

    const query = useQuery({
        queryKey: ["user", "orders", { stateFilter, venueFilter }],
        queryFn: async () => {
            const res = await apiClient.listOrders({
                limit: 200,
                state: stateFilter || undefined,
                venue: venueFilter || undefined,
            });
            return res.orders as unknown as LedgerRow[];
        },
        refetchInterval: 15_000,
    });

    const orders = useMemo(() => query.data ?? [], [query.data]);
    const openCount = useMemo(() => orders.filter((o) => OPEN_STATES.has(o.state)).length, [orders]);

    return (
        <div className="sq-root">
            <div className="sq-shell">
                <header className="sq-masthead sq-rise">
                    <div>
                        <span className="sq-kicker">Execution · Tape</span>
                        <h1 className="sq-title">
                            OR<em>DERS</em>
                        </h1>
                    </div>
                    <div className="sq-masthead-meta">
                        <ModeTag mode={prefs.data?.default_mode ?? "paper"} />
                        <div style={{ marginTop: 10 }}>
                            {orders.length} ROWS · {openCount} OPEN
                        </div>
                    </div>
                </header>

                <nav className="sq-tabs sq-rise" style={{ animationDelay: "60ms" }}>
                    <NavLink to={`/orders/${agentId}`} className="sq-tab" data-active="true">
                        {t("strategies.tabs.orders")}
                    </NavLink>
                    <NavLink to={`/floor/${agentId}`} className="sq-tab">
                        Floor
                    </NavLink>
                    <NavLink to={`/strategies/${agentId}`} className="sq-tab">
                        {t("strategies.tabs.strategies")}
                    </NavLink>
                </nav>

                <div className="sq-filters sq-rise" style={{ animationDelay: "110ms", alignItems: "center" }}>
                    {FILTERS.map((f) => (
                        <button
                            key={f.value || "all"}
                            type="button"
                            className="sq-chip"
                            data-active={stateFilter === f.value}
                            onClick={() => setStateFilter(f.value)}
                        >
                            {f.label}
                        </button>
                    ))}
                    <select
                        value={venueFilter}
                        onChange={(e) => setVenueFilter(e.target.value)}
                        className="sq-select"
                        style={{ marginLeft: "auto" }}
                    >
                        <option value="">All venues</option>
                        <option value="binance">Binance</option>
                        <option value="coinbase">Coinbase</option>
                        <option value="paper">Paper</option>
                    </select>
                </div>

                {query.isLoading ? (
                    <p className="sq-note">Loading…</p>
                ) : orders.length === 0 ? (
                    <p className="sq-note">No orders yet.</p>
                ) : (
                    <div className="sq-board sq-rise" style={{ animationDelay: "160ms" }} data-testid="orders-table">
                        <table className="sq-table">
                            <thead>
                                <tr>
                                    <th>State</th>
                                    <th>Venue</th>
                                    <th>Symbol</th>
                                    <th>Client Order ID</th>
                                    <th>Submitted</th>
                                    <th>Last Seen</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {orders.map((o, i) => (
                                    <tr
                                        key={o.client_order_id}
                                        data-testid="orders-row"
                                        className="sq-rise"
                                        style={{ animationDelay: `${200 + i * 35}ms`, cursor: "default" }}
                                    >
                                        <td>
                                            <StatusPill state={o.state} />
                                        </td>
                                        <td className="sq-cell-mono">{o.venue}</td>
                                        <td>
                                            <span className="sq-symbol">{o.symbol}</span>
                                        </td>
                                        <td>
                                            <CopyId value={o.client_order_id} />
                                        </td>
                                        <td className="sq-cell-faint">{new Date(o.submittedAt).toLocaleString()}</td>
                                        <td className="sq-cell-faint">{new Date(o.lastSeenAt).toLocaleString()}</td>
                                        <td style={{ textAlign: "right" }}>
                                            {OPEN_STATES.has(o.state) && o.state !== "unknown" ? (
                                                <CancelChip orderId={o.client_order_id} venue={o.venue} />
                                            ) : null}
                                        </td>
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
