import { useEffect, useState } from "react";

/**
 * True below 1024px, where the three-column geometry stops holding (spec §7):
 * the chart and the conversation stack vertically and the rail becomes an
 * off-canvas sheet.
 *
 * Deliberately its own hook rather than a shared breakpoint — the layout
 * question at 1024px is different from any other narrow-viewport check
 * in the app, so it gets its own query instead of a coincidental reuse.
 */
const NARROW_QUERY = "(max-width: 1023px)";

export function useIsNarrow(): boolean {
    const [narrow, setNarrow] = useState(
        () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
    );

    useEffect(() => {
        const media = window.matchMedia(NARROW_QUERY);
        const update = () => setNarrow(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    return narrow;
}
