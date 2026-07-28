import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export interface ReportChartDatasetSpec {
    label: string;
    data: Array<number | null>;
    borderColor: string;
    backgroundColor: string;
    type?: "line" | "bar";
    yAxisID?: string;
    fill?: boolean;
    tension?: number;
}

export interface ReportChartAxisSpec {
    title: string;
    position?: "left" | "right";
    format?: "number" | "currency" | "percent" | "millions";
}

export interface ReportChartSpec {
    labels: string[];
    datasets: ReportChartDatasetSpec[];
    axes?: Record<string, ReportChartAxisSpec>;
}

interface NativeReportChartProps {
    chartSpec: ReportChartSpec;
    title: string;
    actionName?: string;
    className?: string;
}

function formatTickValue(
    value: unknown,
    format: ReportChartAxisSpec["format"] | undefined,
    locale: string
): string {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) {
        return String(value);
    }

    switch (format) {
        case "currency":
            return new Intl.NumberFormat(locale, {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 0,
            }).format(num);
        case "percent":
            return new Intl.NumberFormat(locale, {
                style: "percent",
                maximumFractionDigits: 1,
            }).format(num / 100);
        case "millions":
            return new Intl.NumberFormat(locale, {
                style: "currency",
                currency: "USD",
                notation: "compact",
                maximumFractionDigits: 1,
            }).format(num * 1_000_000);
        default:
            return new Intl.NumberFormat(locale, {
                maximumFractionDigits: 2,
            }).format(num);
    }
}

function getPrimaryAxis(chartSpec: ReportChartSpec): ReportChartAxisSpec | undefined {
    return chartSpec.axes?.y || Object.values(chartSpec.axes || {})[0];
}

function getLastNumericValue(values: Array<number | null>): number | null {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}

function getPreviousNumericValue(values: Array<number | null>): number | null {
    let seenLatest = false;
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (typeof value !== "number" || !Number.isFinite(value)) {
            continue;
        }
        if (!seenLatest) {
            seenLatest = true;
            continue;
        }
        return value;
    }
    return null;
}

function getNumericRange(values: Array<number | null>): { min: number | null; max: number | null } {
    const numericValues = values.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value)
    );

    if (numericValues.length === 0) {
        return { min: null, max: null };
    }

    return {
        min: Math.min(...numericValues),
        max: Math.max(...numericValues),
    };
}

export function NativeReportChart({
    chartSpec,
    title,
    actionName,
    className,
}: NativeReportChartProps) {
    const { t, i18n } = useTranslation();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const chartRef = useRef<Chart | null>(null);
    const isOnChainChart = actionName === "GET_ADDRESS_AND_TRANSACTION_DATA";
    const primaryDataset = chartSpec.datasets[0];
    const primaryAxis = getPrimaryAxis(chartSpec);
    const latestValue = primaryDataset ? getLastNumericValue(primaryDataset.data) : null;
    const previousValue = primaryDataset ? getPreviousNumericValue(primaryDataset.data) : null;
    const valueRange = primaryDataset
        ? getNumericRange(primaryDataset.data)
        : { min: null, max: null };
    const delta =
        latestValue !== null && previousValue !== null ? latestValue - previousValue : null;
    const deltaPercent =
        latestValue !== null &&
        previousValue !== null &&
        previousValue !== 0
            ? (delta! / previousValue) * 100
            : null;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        if (chartRef.current) {
            chartRef.current.destroy();
        }

        chartRef.current = new Chart(canvas, {
            type: "line",
            data: {
                labels: chartSpec.labels,
                datasets: chartSpec.datasets.map((dataset, index) => ({
                    ...dataset,
                    borderWidth: dataset.type === "bar" ? 1 : isOnChainChart ? 3 : 2,
                    pointRadius: dataset.type === "bar" ? 0 : isOnChainChart ? 0 : 2,
                    pointHoverRadius: dataset.type === "bar" ? 0 : isOnChainChart ? 5 : 4,
                    pointHitRadius: dataset.type === "bar" ? 0 : 12,
                    spanGaps: true,
                    tension: dataset.tension ?? (isOnChainChart ? 0.35 : 0.2),
                    fill: dataset.fill ?? isOnChainChart,
                    backgroundColor:
                        isOnChainChart && index === 0
                            ? (context: any) => {
                                  const chart = context.chart;
                                  const { ctx, chartArea } = chart;
                                  if (!chartArea) {
                                      return dataset.backgroundColor;
                                  }
                                  const gradient = ctx.createLinearGradient(
                                      0,
                                      chartArea.top,
                                      0,
                                      chartArea.bottom
                                  );
                                  gradient.addColorStop(0, "rgba(59, 130, 246, 0.34)");
                                  gradient.addColorStop(1, "rgba(59, 130, 246, 0.02)");
                                  return gradient;
                              }
                            : dataset.backgroundColor,
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: "index",
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: isOnChainChart ? false : chartSpec.datasets.length > 1,
                        labels: {
                            color: "#94a3b8",
                            usePointStyle: true,
                        },
                    },
                    tooltip: {
                        backgroundColor: "#0f172a",
                        titleColor: "#e2e8f0",
                        bodyColor: "#cbd5e1",
                        borderColor: "rgba(148, 163, 184, 0.24)",
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            label: (context) => {
                                const axis =
                                    chartSpec.axes?.[context.dataset.yAxisID || "y"] ||
                                    primaryAxis;
                                const value = context.parsed.y;
                                return `${context.dataset.label}: ${formatTickValue(
                                    value,
                                    axis?.format,
                                    i18n.language
                                )}`;
                            },
                        },
                    },
                    title: {
                        display: false,
                        text: title,
                    },
                },
                scales: Object.fromEntries(
                    Object.entries(chartSpec.axes || { y: { title: t("charts.valueAxis") } }).map(
                        ([axisId, axis]) => [
                            axisId,
                            {
                                type: "linear" as const,
                                display: true,
                                position: axis.position || "left",
                                beginAtZero: false,
                                title: {
                                    display: true,
                                    text: axis.title,
                                    color: "#94a3b8",
                                },
                                ticks: {
                                    color: "#64748b",
                                    maxTicksLimit: isOnChainChart ? 6 : undefined,
                                    callback: (value: unknown) =>
                                        formatTickValue(value, axis.format, i18n.language),
                                },
                                grid:
                                    axisId === "y1"
                                        ? {
                                              drawOnChartArea: false,
                                              color: "rgba(148, 163, 184, 0.12)",
                                          }
                                        : {
                                              color: isOnChainChart
                                                  ? "rgba(59, 130, 246, 0.08)"
                                                  : "rgba(148, 163, 184, 0.16)",
                                          },
                            },
                        ]
                    )
                ),
            },
        });

        return () => {
            if (chartRef.current) {
                chartRef.current.destroy();
                chartRef.current = null;
            }
        };
    }, [chartSpec, i18n.language, isOnChainChart, primaryAxis, t, title]);

    return (
        <div
            className={cn(
                isOnChainChart
                    ? "rounded-2xl border border-sky-200/70 bg-[linear-gradient(180deg,rgba(239,246,255,0.92),rgba(255,255,255,1))] p-5 shadow-[0_18px_60px_rgba(14,165,233,0.08)] dark:border-sky-400/15 dark:bg-[linear-gradient(180deg,rgba(14,23,38,0.98),rgba(7,14,24,0.98))]"
                    : "rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-[hsl(229,50%,6%)]",
                className
            )}
        >
            <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-white/90">
                        {title}
                    </div>
                    {isOnChainChart ? (
                        <div className="mt-1 text-xs uppercase tracking-[0.18em] text-sky-700/80 dark:text-sky-300/80">
                            {t("charts.networkActivityTrend")}
                        </div>
                    ) : null}
                </div>
                {isOnChainChart ? (
                    <div className="rounded-full border border-sky-300/60 bg-white/70 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200">
                        {t("charts.nativeRender")}
                    </div>
                ) : null}
            </div>
            {isOnChainChart ? (
                <div className="mb-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 dark:border-white/5 dark:bg-white/[0.03]">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                            {t("common.latest")}
                        </div>
                        <div className="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                            {latestValue !== null
                                ? formatTickValue(latestValue, primaryAxis?.format, i18n.language)
                                : "--"}
                        </div>
                    </div>
                    <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 dark:border-white/5 dark:bg-white/[0.03]">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                            {t("charts.change")}
                        </div>
                        <div className="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                            {delta !== null
                                ? `${delta > 0 ? "+" : ""}${formatTickValue(delta, primaryAxis?.format, i18n.language)}`
                                : "--"}
                        </div>
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {deltaPercent !== null
                                ? `${deltaPercent > 0 ? "+" : ""}${new Intl.NumberFormat(i18n.language, {
                                      style: "percent",
                                      maximumFractionDigits: 2,
                                  }).format(deltaPercent / 100)} ${t("charts.vsPrevious")}`
                                : t("charts.noComparison")}
                        </div>
                    </div>
                    <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3 dark:border-white/5 dark:bg-white/[0.03]">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                            {t("charts.range")}
                        </div>
                        <div className="mt-2 text-sm font-medium text-slate-900 dark:text-white/90">
                            {valueRange.min !== null && valueRange.max !== null
                                ? `${formatTickValue(valueRange.min, primaryAxis?.format, i18n.language)} ${t(
                                      "charts.rangeSeparator"
                                  )} ${formatTickValue(
                                      valueRange.max,
                                      primaryAxis?.format,
                                      i18n.language
                                  )}`
                                : "--"}
                        </div>
                    </div>
                </div>
            ) : null}
            <div className={cn("w-full", isOnChainChart ? "h-[200px] sm:h-[260px] md:h-[320px] lg:h-[400px]" : "h-[180px] sm:h-[240px] md:h-[300px] lg:h-[380px]")}>
                <canvas ref={canvasRef} />
            </div>
        </div>
    );
}
