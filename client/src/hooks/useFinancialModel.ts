import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { deriveSheets, sheetsTouchedBy } from "@/lib/workbook";
import type { ModelContextView, ModelRevisionFrame, ModelView } from "@/types/financialModel";

/** How long several revisions arriving back to back are folded into one refetch.
 *  The agent routinely commits section by section; refetching per frame would
 *  thrash the grid without showing anything new in between. */
const REFETCH_DEBOUNCE_MS = 150;

/** `"all"` mirrors `lib/workbook.ts`'s `isCellChanged`: an empty
 *  `changed_period_ids` on a frame means the whole row changed (a formula or
 *  source swap has no single period to name), not "no periods changed". */
type RowChange = "all" | Set<string>;

export type ModelChangeState = {
    /** Which model this accumulated state belongs to. Line item ids are a
     *  shared canonical taxonomy (`revenue.total`, `ebitda`, ...) reused
     *  across every company's model — without this, a stale batch built for
     *  a model the user has since tabbed away from could flash cells on the
     *  model now on screen. */
    modelId: string;
    revision: number;
    lineItems: Map<string, RowChange>;
    sheetIds: string[];
};

export function useFinancialModel(agentId: string, topicId: string) {
    const queryClient = useQueryClient();
    const [activeModelId, setActiveModelId] = useState<string | null>(null);
    const [change, setChange] = useState<ModelChangeState | null>(null);
    const pendingRef = useRef<ModelRevisionFrame[]>([]);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Tracks whether the *active model's* highlight accumulator is already
    // open for the current (unflushed) batch — independent of `pendingRef`,
    // which batches every model's frames together for invalidation purposes.
    // A batch's first frame can belong to a model the user isn't viewing; the
    // active model's accumulator must still start fresh the first time a
    // frame for it actually arrives, not inherit a stale reset decision from
    // an unrelated model's frame earlier in the same window.
    const activeChangeOpenRef = useRef(false);

    const { data: models = [] } = useQuery<ModelView[]>({
        queryKey: ["financialModels", agentId, topicId],
        queryFn: async () => (await apiClient.getTopicModels(agentId, topicId)).models ?? [],
        refetchOnWindowFocus: false,
    });

    const effectiveModelId = activeModelId ?? models[0]?.modelId ?? null;

    const { data: context } = useQuery<ModelContextView>({
        queryKey: ["financialModel", effectiveModelId],
        queryFn: async () => await apiClient.getFinancialModel(effectiveModelId!),
        enabled: effectiveModelId !== null,
        refetchOnWindowFocus: false,
    });

    const workbook = context?.currentWorkbook;
    const sheets = useMemo(() => (workbook ? deriveSheets(workbook) : []), [workbook]);

    const flush = useCallback(() => {
        const frames = pendingRef.current;
        pendingRef.current = [];
        timerRef.current = null;
        activeChangeOpenRef.current = false;
        if (frames.length === 0) return;

        const modelIds = new Set(frames.map((frame) => frame.model_id));
        for (const modelId of modelIds) {
            void queryClient.invalidateQueries({ queryKey: ["financialModel", modelId] });
        }
        // A model the strip has never seen means the agent just created one.
        if ([...modelIds].some((id) => !models.some((model) => model.modelId === id))) {
            void queryClient.invalidateQueries({ queryKey: ["financialModels", agentId, topicId] });
        }
    }, [agentId, models, queryClient, topicId]);

    const onRevisionFrame = useCallback((frame: ModelRevisionFrame) => {
        pendingRef.current.push(frame);

        // A frame for any other model still needs to drive its own query
        // invalidation (handled below via `pendingRef`/`flush`, unconditionally),
        // but must not contribute to the on-screen highlight state — line item
        // ids are shared across every model, so folding in a frame for a model
        // the user isn't looking at would flash a cell that never changed on
        // the table actually rendered.
        if (effectiveModelId !== null && frame.model_id === effectiveModelId) {
            // A revision increments on every commit, so consecutive frames in
            // the same burst never share a revision number — gating
            // accumulation on `previous.revision === frame.revision` would
            // wipe the earlier frames' ids on every single new commit
            // instead of accumulating them. What actually marks "still the
            // same debounce window for THIS model" is whether the active
            // model's accumulator was already open when this frame arrived.
            const joinsOpenBatch = activeChangeOpenRef.current;
            activeChangeOpenRef.current = true;

            // Accumulate rather than replace: collapsing the refetch must not
            // collapse the highlights, or the earlier frames' cells never flash.
            setChange((previous) => {
                const lineItems = new Map<string, RowChange>(
                    joinsOpenBatch && previous ? previous.lineItems : [],
                );
                const isWholeRowChange = frame.changed_period_ids.length === 0;
                for (const lineItemId of frame.changed_line_item_ids) {
                    const existing = lineItems.get(lineItemId);
                    // "all" is sticky within a batch: once any frame says the
                    // whole row changed, a later frame naming individual
                    // periods for the same row must not narrow it back down.
                    if (isWholeRowChange || existing === "all") {
                        lineItems.set(lineItemId, "all");
                        continue;
                    }
                    const periods = new Set(existing);
                    for (const id of frame.changed_period_ids) periods.add(id);
                    lineItems.set(lineItemId, periods);
                }

                const sheetIds = new Set(joinsOpenBatch && previous ? previous.sheetIds : []);
                if (workbook) for (const id of sheetsTouchedBy(frame, sheets, workbook)) sheetIds.add(id);

                return {
                    modelId: frame.model_id,
                    revision: frame.revision,
                    lineItems,
                    sheetIds: [...sheetIds],
                };
            });
        }

        if (timerRef.current === null) timerRef.current = setTimeout(flush, REFETCH_DEBOUNCE_MS);
    }, [flush, sheets, workbook, effectiveModelId]);

    useEffect(() => () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
    }, []);

    const isCellChanged = useCallback(
        (lineItemId: string, periodId: string) => {
            // Re-checked at read time, not only at accumulation time: if the
            // user has since switched the active model, `change` may still
            // hold a batch built for the model they left — it must not leak
            // onto the table now on screen.
            if (change === null || change.modelId !== effectiveModelId) return false;
            const rowChange = change.lineItems.get(lineItemId);
            if (rowChange === undefined) return false;
            return rowChange === "all" || rowChange.has(periodId);
        },
        [change, effectiveModelId],
    );

    return {
        models, activeModelId: effectiveModelId, setActiveModelId,
        context, workbook, sheets, change, isCellChanged, onRevisionFrame,
    };
}
