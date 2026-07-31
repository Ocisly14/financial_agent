// Pure logic for the Research layer's live layout directives (spec §6, §4.5 —
// docs/superpowers/specs/2026-07-30-research-layer-design.md). The controller
// agent has full authority over a Research's layout (focus, tabs, members);
// the user can undo its most recent PERSISTENT change, single level, no undo
// stack (YAGNI per spec).
//
// These directives mirror the `ResearchFrame` variants the backend emits over
// SSE (see .superpowers/sdd/2026-07-30-research-layer/task-4-5-report.md):
//   - `topic_focus`    — transient, SSE-only, nothing to undo.
//   - `layout_changed` — persistent (`edit_tabs` / `edit_members`), carries a
//                         `previous`/`next` pair the client can round-trip.
//
// Undo durability: `source: 'agent'` and the `previous` snapshot live only on
// the live `layout_changed` frame — there is no `source` column in
// `topic_charts` / `research_members` (Task 1 schema, confirmed in the Task
// 4/5 report). Adding one would require touching `src/`, which is out of
// scope here (backend is finished, §-constraint). So this module's undo
// state is a SESSION-LIVE, single in-memory slot: durable across the current
// stream/tab, gone on reload. That matches what the wire protocol actually
// carries — it does not silently promise more than that.

export type FocusDirective = {
    kind: "focus";
    topicId: string;
    symbol?: string;
};

export type LayoutScope = "tabs" | "members";

/** Mirrors the backend's `layout_changed` frame. `previous`/`next` are opaque
 *  to this module — it never inspects their shape, only swaps them. */
export type LayoutChangedDirective = {
    kind: "layout_changed";
    scope: LayoutScope;
    researchId: string;
    topicId?: string;
    source: "agent" | "user";
    previous: unknown;
    next: unknown;
};

export type ResearchDirective = FocusDirective | LayoutChangedDirective;

export type ResearchLayoutState = {
    /** The member currently in view. Transient — never round-tripped to the
     *  server, never carries an undo. */
    focus: { topicId: string; symbol?: string } | null;
    /** The inverse of the single most recent undoable directive, or null if
     *  there is nothing to undo (no persistent agent change yet, or the
     *  pending one was already undone/dismissed). Single slot: applying a
     *  new persistent directive replaces it wholesale — no stack. */
    pendingUndo: LayoutChangedDirective | null;
};

export const initialResearchLayoutState: ResearchLayoutState = {
    focus: null,
    pendingUndo: null,
};

/**
 * Produce the inverse of a directive — the directive that, if applied,
 * would put the previous state back.
 *
 * A transient directive (`focus`) has no inverse: there is nothing to undo,
 * because nothing was written. A persistent directive (`layout_changed`) is
 * inverted by swapping `previous`/`next`.
 */
export function invertDirective(directive: ResearchDirective): LayoutChangedDirective | undefined {
    if (directive.kind !== "layout_changed") return undefined;
    return {
        kind: "layout_changed",
        scope: directive.scope,
        researchId: directive.researchId,
        topicId: directive.topicId,
        source: directive.source,
        previous: directive.next,
        next: directive.previous,
    };
}

/**
 * Normalise an incoming agent layout directive onto Research layout state.
 *
 * - `focus` only updates `state.focus`. It never touches `pendingUndo` — per
 *   spec §7.5 it is not even worth a toast, let alone an undo slot.
 * - `layout_changed` only sets `pendingUndo` when `source === "agent"`: per
 *   spec §6 only the agent's own persistent changes get an undo toast — a
 *   change the user made directly through the UI is not something the user
 *   needs to "undo" a prompt for, they just made it. Applying a SECOND agent
 *   `layout_changed` replaces the pending undo entirely (single level).
 */
export function applyDirective(state: ResearchLayoutState, directive: ResearchDirective): ResearchLayoutState {
    if (directive.kind === "focus") {
        return { ...state, focus: { topicId: directive.topicId, symbol: directive.symbol } };
    }

    if (directive.source !== "agent") {
        // A user-sourced layout change is not undo-able through this
        // mechanism; it does not touch whatever agent undo is pending either
        // — it is an independent edit, not a reason to drop the agent's.
        return state;
    }

    return { ...state, pendingUndo: invertDirective(directive) ?? null };
}

/** Clear the pending undo without applying it — the toast timed out, or the
 *  user dismissed it, or it was just consumed by `resolveUndo`. */
export function clearPendingUndo(state: ResearchLayoutState): ResearchLayoutState {
    if (!state.pendingUndo) return state;
    return { ...state, pendingUndo: null };
}

/**
 * Consume the pending undo: returns the directive to send back to the server
 * (the caller is responsible for actually calling `setResearchMembers` /
 * the tabs-equivalent with it) plus the state with the slot cleared. Returns
 * `undefined` for the directive when there is nothing to undo.
 */
export function resolveUndo(
    state: ResearchLayoutState,
): { state: ResearchLayoutState; directive: LayoutChangedDirective | undefined } {
    if (!state.pendingUndo) return { state, directive: undefined };
    return { state: clearPendingUndo(state), directive: state.pendingUndo };
}
