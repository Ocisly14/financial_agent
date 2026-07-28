export type MetricPoint = { time: string; value: number };
export type MetricSeries = { symbol: string; metric: string; points: MetricPoint[] };

const BASE_URL = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";

type CoinMetricsRow = {
  time: string;
  asset: string;
  [key: string]: string | undefined;
};

type CoinMetricsResponse = {
  data: CoinMetricsRow[];
};

export async function fetchCoinMetrics(
  symbol: string,
  metrics: string[],
  from: string,
  to: string,
  frequency: "1d" | "1w" = "1d",
): Promise<MetricSeries[]> {
  const params = new URLSearchParams({
    assets: symbol.toLowerCase(),
    metrics: metrics.join(","),
    start_time: from,
    end_time: to,
    frequency,
  });

  const resp = await fetch(`${BASE_URL}?${params}`);
  if (!resp.ok) {
    throw new Error(`CoinMetrics API ${resp.status}: ${await resp.text()}`);
  }

  const json = (await resp.json()) as CoinMetricsResponse;
  const rows: CoinMetricsRow[] = Array.isArray(json.data) ? json.data : [];

  return metrics.map((metric) => {
    const points: MetricPoint[] = rows
      .filter((row) => row[metric] !== undefined && row[metric] !== null && row[metric] !== "")
      .map((row) => ({
        time: row.time,
        value: Number(row[metric]),
      }))
      .filter((point) => Number.isFinite(point.value));

    return { symbol: symbol.toLowerCase(), metric, points };
  });
}
