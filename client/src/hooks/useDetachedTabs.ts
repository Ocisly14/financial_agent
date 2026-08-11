import { useCallback, useEffect, useState } from "react";

/**
 * The set of chart tabs currently torn off the tab strip into floating windows.
 *
 * Three properties of this state are decisions, not implementation details
 * (design §5):
 *
 * - **It is not persisted.** No write to the preference store, no
 *   localStorage. Floating is "right now I want these side by side", not a
 *   lasting preference; persisting it would mean storing a position, a size
 *   and a z-order for an intent that has almost always moved on by the next
 *   visit. A reload puts every tab back in the strip, and that is the
 *   intended behaviour rather than a limitation.
 * - **Closing a window returns the tab; it does not delete it.** This is a
 *   deliberate divergence from browser tab tear-off, where closing the window
 *   closes its tabs. A browser can afford that because a closed tab reopens
 *   from history; here a tab is a persisted user preference, and destroying
 *   one because a window was dismissed is out of proportion to the gesture.
 *   Deletion stays on exactly one control: the `×` on the tab itself.
 * - **No cap on how many are out at once.** The user pulled each one out
 *   deliberately; a limit would refuse a comparison they explicitly asked for.
 *
 * `validKeys` is the live tab set. A tab that disappears while detached — the
 * agent replaced the tab set, the topic changed — takes its window with it,
 * since a window onto a tab that no longer exists has nothing to show.
 */

export type DetachedWindow = {
    key: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** The box the window grows out of: the torn-off tab, at the size it had in
     *  the strip, sitting where the pointer let go. The tab came with the drag,
     *  so that is where it should unfold — an expansion that starts back at the
     *  strip would be animating a journey the user already made. Absent when
     *  there is no source tab to grow from. Read once, on mount. */
    origin?: { left: number; top: number; width: number; height: number };
};

const DEFAULT_SIZE = { width: 560, height: 420 };
/** Each additional window steps down-right so a stack of them stays clickable. */
const CASCADE_STEP = 28;
/** Clearance below the top of the chart area, so a window never lands on the
 *  tab strip it was just dragged out of. */
const TOP_CLEARANCE = 12;
/** Where the pointer sits on the new window when a tear-off names a release
 *  point: horizontally centred, and far enough down to be on the title bar.
 *  The window arrives already "held" at the spot the tab was dropped, so the
 *  gesture ends where the hand ended. */
const GRAB_OFFSET_Y = 16;
/** How much of a user-placed window must stay on screen: its title bar, which
 *  is what drags and closes it. Matches the clamp in `FloatingChart`'s own move
 *  drag, so a window cannot be dropped somewhere it could not also be dragged. */
const TITLE_BAR_KEEP_VISIBLE = 40;

export function useDetachedTabs(validKeys: string[]) {
    const [windows, setWindows] = useState<DetachedWindow[]>([]);

    // Prune windows whose tab is gone. Compared as a joined string because the
    // caller rebuilds the key array every render.
    const validKey = validKeys.join("\n");
    useEffect(() => {
        const valid = new Set(validKey.split("\n"));
        setWindows((current) => {
            const next = current.filter((entry) => valid.has(entry.key));
            return next.length === current.length ? current : next;
        });
    }, [validKey]);

    /**
     * Tears a tab out.
     *
     * `releasePoint` is where the pointer let go. When it is given the window
     * opens *there*, under the cursor — a drag that ends in one place and
     * produces a window in another reads as the app overruling the gesture, and
     * leaves the user hunting for what they just dropped. Only when the release
     * point is unknown (a keyboard or programmatic detach) does the window fall
     * back to `area`: the chart region's viewport rect, where it opens centred
     * and high (§5 rule 5) so it sits over the chart it came from rather than
     * over the tab strip.
     *
     * The two also clamp differently, and deliberately. A window the app placed
     * is held fully on-screen. A window the user placed is held only to the rule
     * dragging one already obeys — its title bar stays reachable, and the rest
     * may run past the bottom edge. Pulling a low drop back up to fit would move
     * the window away from the spot the user just chose, which is the thing this
     * whole path exists to stop.
     */
    const detach = useCallback((
        key: string,
        area: DOMRect | null,
        releasePoint?: { x: number; y: number },
        origin?: DetachedWindow["origin"],
    ) => {
        setWindows((current) => {
            if (current.some((entry) => entry.key === key)) return current;
            const width = Math.min(DEFAULT_SIZE.width, area ? Math.max(280, area.width - 32) : DEFAULT_SIZE.width);
            const height = Math.min(DEFAULT_SIZE.height, area ? Math.max(220, area.height - 48) : DEFAULT_SIZE.height);
            // No cascade when the user named the spot: stepping the window away
            // from where they dropped it is the same overruling, in miniature.
            const cascade = releasePoint ? 0 : current.length * CASCADE_STEP;
            const x = releasePoint
                ? releasePoint.x - width / 2
                : area ? area.left + Math.max(0, (area.width - width) / 2) + cascade : 80 + cascade;
            const y = releasePoint
                ? releasePoint.y - GRAB_OFFSET_Y
                : (area ? area.top + TOP_CLEARANCE : 80) + cascade;
            // Fall back to the requested position rather than clamping against
            // NaN if there is no window object to measure against.
            const viewportWidth = typeof window === "undefined" ? x + width : window.innerWidth;
            const viewportHeight = typeof window === "undefined" ? y + height : window.innerHeight;
            const lowestTop = releasePoint ? viewportHeight - TITLE_BAR_KEEP_VISIBLE : viewportHeight - height;
            return [
                ...current,
                {
                    key,
                    x: Math.max(0, Math.min(x, viewportWidth - width)),
                    y: Math.max(0, Math.min(y, lowestTop)),
                    width,
                    height,
                    // The tab's size, re-centred on the release point. Only the
                    // size survives the drag; the position is wherever the hand
                    // ended up.
                    ...(origin
                        ? {
                            origin: releasePoint
                                ? {
                                    left: releasePoint.x - origin.width / 2,
                                    top: releasePoint.y - origin.height / 2,
                                    width: origin.width,
                                    height: origin.height,
                                }
                                : origin,
                        }
                        : {}),
                },
            ];
        });
    }, []);

    /** Closing a floating window: the tab goes back to the strip. Not a delete. */
    const reattach = useCallback((key: string) => {
        setWindows((current) => current.filter((entry) => entry.key !== key));
    }, []);

    const moveWindow = useCallback((key: string, x: number, y: number) => {
        setWindows((current) => current.map((entry) => (entry.key === key ? { ...entry, x, y } : entry)));
    }, []);

    const resizeWindow = useCallback((key: string, width: number, height: number) => {
        setWindows((current) => current.map((entry) => (entry.key === key ? { ...entry, width, height } : entry)));
    }, []);

    /** Brings a window to the front. Array order IS the z-order — the last
     *  entry renders on top — so raising is a move to the end of the list. */
    const raiseWindow = useCallback((key: string) => {
        setWindows((current) => {
            const index = current.findIndex((entry) => entry.key === key);
            if (index === -1 || index === current.length - 1) return current;
            const next = [...current];
            const [entry] = next.splice(index, 1);
            next.push(entry!);
            return next;
        });
    }, []);

    return { windows, detach, reattach, moveWindow, resizeWindow, raiseWindow };
}
