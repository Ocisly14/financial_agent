import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast as sonnerToast } from "sonner";
import type { TopicChartPreference, UUID } from "@/types/core";
import type { ModelRevisionFrame } from "@/types/financialModel";
import { apiClient, type ProcessingStep } from "@/lib/api";
import { DEFAULT_STOCK_RANGE, parseStockRange } from "@/lib/stockChart";
import { useTopicStream } from "@/hooks/useTopicStream";
import type { MemberFocusSignal } from "@/components/workspace/MemberRow";
import {
    applyDirective,
    initialResearchLayoutState,
    resolveUndo,
    type LayoutChangedDirective,
    type ResearchDirective,
    type ResearchLayoutState,
} from "@/lib/researchLayout";

/** Narrow an incoming `topic_focus` / `layout_changed` step into the pure
 *  directive shape `lib/researchLayout.ts` reasons about. Anything malformed
 *  is dropped rather than half-applied — a layout frame we can't invert is a
 *  layout frame we must not offer an undo for. */
function toDirective(step: ProcessingStep): ResearchDirective | undefined {
    const data = (step.data ?? {}) as Record<string, unknown>;
    if (step.name === "topic_focus") {
        const topicId = typeof data.topicId === "string" ? data.topicId : undefined;
        if (!topicId) return undefined;
        return {
            kind: "focus",
            topicId,
            ...(typeof data.symbol === "string" ? { symbol: data.symbol } : {}),
        };
    }
    const scope = data.scope === "tabs" || data.scope === "members" ? data.scope : undefined;
    const researchId = typeof data.researchId === "string" ? data.researchId : undefined;
    if (!scope || !researchId) return undefined;
    return {
        kind: "layout_changed",
        scope,
        researchId,
        topicId: typeof data.topicId === "string" ? data.topicId : undefined,
        source: data.source === "user" ? "user" : "agent",
        previous: data.previous,
        next: data.next,
    };
}

/** The persisted chart-preference shape, defensively rebuilt from whatever the
 *  frame carried — the undo path PUTs this straight back. A row missing its id
 *  or matching neither the symbol nor the overlay shape is dropped rather than
 *  half-applied, same posture as the rest of this file's frame parsing. */
function asChartPreferences(value: unknown): TopicChartPreference[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const row = entry as Record<string, unknown>;
        const id = typeof row?.id === "string" ? row.id : undefined;
        if (!id) return [];
        const range = parseStockRange(row.range) ?? null;
        const hidden = Boolean(row.hidden);
        const sortOrder = typeof row.sortOrder === "number" ? row.sortOrder : 0;

        if (typeof row.symbol === "string") {
            const preference: TopicChartPreference = { id, kind: "symbol", symbol: row.symbol, range, hidden, sortOrder };
            return [preference];
        }

        const overlay = row.overlay as { symbols?: unknown; range?: unknown; normalize?: unknown } | undefined;
        if (overlay && Array.isArray(overlay.symbols)) {
            const symbols = overlay.symbols.filter((s): s is string => typeof s === "string");
            const overlayRange = parseStockRange(overlay.range) ?? DEFAULT_STOCK_RANGE;
            const normalize = overlay.normalize === "index100" ? "index100" as const : "pct" as const;
            const preference: TopicChartPreference = { id, kind: "overlay", overlay: { symbols, range: overlayRange, normalize }, range, hidden, sortOrder };
            return [preference];
        }

        return [] as TopicChartPreference[];
    });
}

function asTopicIds(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The Research conversation stream. A Research id *is* its chat session id
 * (spec §3), so the transport is exactly `useTopicStream` — what this hook
 * adds is the two layout frames the backend emits alongside the answer and
 * that nothing else in the client consumed until now:
 *
 *  - `topic_focus`    — transient. It moves the member focus and replays a
 *                       one-shot ring on that chip. No toast, no undo: there
 *                       is nothing on disk to put back (spec §7.5).
 *  - `layout_changed` — persistent. The agent wrote tabs or membership, so
 *                       the affected queries are invalidated and a single
 *                       "undo" toast is offered.
 *
 * The undo is **session-live**. `source: 'agent'` and the `previous` snapshot
 * exist only on the live frame — there is no `source` column behind them — so
 * a reload loses the offer. Nothing here implies otherwise: the offer lives in
 * a transient toast and never in persistent chrome.
 */
export function useResearchStream(
    agentId: UUID,
    researchId: UUID,
    options?: { onModelRevision?: (frame: ModelRevisionFrame) => void },
) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();

    const [layout, setLayout] = useState<ResearchLayoutState>(initialResearchLayoutState);
    const [focusSignal, setFocusSignal] = useState<MemberFocusSignal | null>(null);
    const focusTokenRef = useRef(0);
    // The reducer state is also mirrored here so the toast's own click handler
    // reads the slot it was created for rather than a stale render's copy.
    const layoutRef = useRef<ResearchLayoutState>(initialResearchLayoutState);

    const applyUndo = useCallback(
        async (directive: LayoutChangedDirective) => {
            try {
                if (directive.scope === "members") {
                    await apiClient.setResearchMembers(agentId, researchId, asTopicIds(directive.next));
                    void queryClient.invalidateQueries({ queryKey: ["research", agentId, researchId] });
                } else if (directive.topicId) {
                    await apiClient.setTopicCharts(agentId, directive.topicId, asChartPreferences(directive.next));
                    void queryClient.invalidateQueries({
                        queryKey: ["topicCharts", agentId, directive.topicId],
                    });
                }
            } catch (error) {
                sonnerToast.error(t("research.undoFailed"), {
                    description: error instanceof Error ? error.message : undefined,
                });
            }
        },
        [agentId, researchId, queryClient, t],
    );

    const undoLastLayoutChange = useCallback(() => {
        const { state, directive } = resolveUndo(layoutRef.current);
        layoutRef.current = state;
        setLayout(state);
        if (directive) void applyUndo(directive);
    }, [applyUndo]);

    const handleDirective = useCallback(
        (step: ProcessingStep) => {
            const directive = toDirective(step);
            if (!directive) return;

            const next = applyDirective(layoutRef.current, directive);
            layoutRef.current = next;
            setLayout(next);

            if (directive.kind === "focus") {
                focusTokenRef.current += 1;
                setFocusSignal({ memberId: directive.topicId, token: focusTokenRef.current });
                return;
            }

            // The change already landed server-side; pull it in so the row and
            // the tab bar show what the agent actually did.
            if (directive.scope === "members") {
                void queryClient.invalidateQueries({ queryKey: ["research", agentId, researchId] });
            } else if (directive.topicId) {
                void queryClient.invalidateQueries({ queryKey: ["topicCharts", agentId, directive.topicId] });
            }

            if (directive.source !== "agent") return;
            sonnerToast(
                directive.scope === "members" ? t("research.layoutChanged.members") : t("research.layoutChanged.tabs"),
                {
                    duration: 8000,
                    action: { label: t("research.undo"), onClick: () => undoLastLayoutChange() },
                },
            );
        },
        [agentId, researchId, queryClient, t, undoLastLayoutChange],
    );

    const stream = useTopicStream(agentId, researchId, {
        onDirective: handleDirective,
        onModelRevision: options?.onModelRevision,
    });

    return {
        ...stream,
        /** The member the agent last focused, plus a token that changes on every
         *  focus frame so a repeat focus still replays the ring. */
        focusSignal,
        /** Transient view state only — deliberately never mirrored into the URL
         *  (spec §7.9): the agent moves focus, and a history entry per move
         *  would destroy the back button. */
        agentFocusTopicId: layout.focus?.topicId ?? null,
        hasPendingUndo: layout.pendingUndo !== null,
        undoLastLayoutChange,
    };
}
