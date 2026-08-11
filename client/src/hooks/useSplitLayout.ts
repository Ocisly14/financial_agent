import { useCallback, useEffect, useRef, useState } from "react";
import { clampChartRatio, DEFAULT_CHART_RATIO, chartFits } from "@/lib/splitLayout";

/** The user's space preference is a habit, not a property of one topic. */
const STORAGE_KEY = "workspace.chartRatio";

function storedRatio(): number {
    if (typeof window === "undefined") return DEFAULT_CHART_RATIO;
    const raw = Number.parseFloat(window.localStorage.getItem(STORAGE_KEY) ?? "");
    return Number.isFinite(raw) ? raw : DEFAULT_CHART_RATIO;
}

export function useSplitLayout(railWidth: number) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [totalWidth, setTotalWidth] = useState(0);
    const [ratio, setRatioState] = useState(storedRatio);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setTotalWidth(entry.contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const setRatio = useCallback((next: number) => {
        setRatioState(next);
        window.localStorage.setItem(STORAGE_KEY, String(next));
    }, []);

    const constraints = { totalWidth, railWidth };
    return {
        containerRef,
        /** 0 means the chart column must not render. */
        ratio: clampChartRatio(ratio, constraints),
        fits: chartFits(constraints),
        setRatio,
    };
}
