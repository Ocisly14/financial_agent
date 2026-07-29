export interface CandleTheme {
    grid: string;
    gridStrong: string;
    axis: string;
    ink: string;
    inkDim: string;
    amber: string;
    pos: string;
    neg: string;
    crosshair: string;
    hoverTag: string;
    liveTagInk: string;
}

/** CandleScope 的 Strategy Floor 缺省主题；前八项保持原 COL 常量逐值不变。 */
export const DEFAULT_CANDLE_THEME: CandleTheme = {
    grid: "rgba(255,255,255,0.05)",
    gridStrong: "rgba(255,255,255,0.09)",
    axis: "#545a67",
    ink: "#edeff3",
    inkDim: "#8b909c",
    amber: "#ffb648",
    pos: "#4ade80",
    neg: "#fb5d7a",
    crosshair: "rgba(255,182,72,0.5)",
    hoverTag: "#1a1d26",
    liveTagInk: "#0a0a0a",
};
