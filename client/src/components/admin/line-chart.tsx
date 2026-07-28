import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import type { ChartDataset } from "chart.js";

type LineDataset = {
    label: string;
    data: number[];
    borderColor: string;
    backgroundColor: string;
};

type LineChartProps = {
    labels: string[];
    datasets: LineDataset[];
    showLegend?: boolean;
    beginAtZero?: boolean;
};

export default function LineChart({
    labels,
    datasets,
    showLegend = false,
    beginAtZero = true,
}: LineChartProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const chartRef = useRef<Chart | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        if (chartRef.current) {
            chartRef.current.destroy();
        }

        const chartDatasets: ChartDataset<"line", number[]>[] = datasets.map(
            (dataset) => ({
                ...dataset,
                borderWidth: 2,
                fill: true,
                tension: 0.2,
            })
        );

        chartRef.current = new Chart(canvas, {
            type: "line",
            data: { labels, datasets: chartDatasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        grid: { color: "#27272a" },
                        ticks: { color: "#71717a" },
                    },
                    y: {
                        beginAtZero,
                        grid: { color: "#27272a" },
                        ticks: { color: "#71717a" },
                    },
                },
                plugins: {
                    legend: {
                        display: showLegend,
                        labels: { color: "#a1a1aa" },
                    },
                },
            },
        });

        return () => {
            if (chartRef.current) {
                chartRef.current.destroy();
                chartRef.current = null;
            }
        };
    }, [labels, datasets, showLegend, beginAtZero]);

    return <canvas ref={canvasRef} />;
}
