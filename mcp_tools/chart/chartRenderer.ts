import type { OhlcvBar } from "../shared/coinglassClient.ts";

export type ChartData = {
  dates: string[];
  prices: number[];
  opens: number[];
  highs: number[];
  lows: number[];
  volumes: number[]; // in millions USD
  startPrice: number;
  endPrice: number;
  highPrice: number;
  lowPrice: number;
};

export function buildChartData(bars: OhlcvBar[]): ChartData {
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const dates   = sorted.map((b) => new Date(b.time).toISOString().slice(0, 10));
  const prices  = sorted.map((b) => b.close);
  const opens   = sorted.map((b) => b.open);
  const highs   = sorted.map((b) => b.high);
  const lows    = sorted.map((b) => b.low);
  const volumes = sorted.map((b) => b.volume / 1_000_000);

  return {
    dates, prices, opens, highs, lows, volumes,
    startPrice: prices[0] ?? 0,
    endPrice:   prices[prices.length - 1] ?? 0,
    highPrice:  prices.length > 0 ? Math.max(...prices) : 0,
    lowPrice:   prices.length > 0 ? Math.min(...prices) : 0,
  };
}

export function renderChartHtml(
  symbol: string,
  from: string,
  to: string,
  data: ChartData,
): string {
  const datesJson   = JSON.stringify(data.dates);
  const pricesJson  = JSON.stringify(data.prices);
  const volumesJson = JSON.stringify(data.volumes);

  const pctChange = data.startPrice > 0
    ? (((data.endPrice - data.startPrice) / data.startPrice) * 100).toFixed(2)
    : "0.00";
  const isUp = parseFloat(pctChange) >= 0;
  const sign = isUp ? "+" : "";

  const fmtPrice = (n: number) =>
    n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 })
           : "$" + n.toFixed(6);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${symbol} Price Chart</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem;color:#f87171\\'>Chart library failed to load.</p>'"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      margin: 0;
      padding: 20px;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100%;
    }
    h1 {
      text-align: center;
      font-size: 1.15rem;
      font-weight: 600;
      color: #f1f5f9;
      letter-spacing: 0.02em;
      margin: 0 0 14px;
    }
    h1 .sym { color: #38bdf8; }
    h1 .period { color: #475569; font-size: 0.82rem; font-weight: 400; margin-left: 8px; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
      max-width: 1200px;
      margin: 0 auto 16px;
    }
    .stat-card {
      background: #1a2035;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 8px;
      padding: 9px 13px;
    }
    .stat-label {
      font-size: 0.63rem;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      margin-bottom: 3px;
    }
    .stat-value { font-size: 0.92rem; font-weight: 600; color: #f1f5f9; }
    .stat-value.up   { color: #34d399; }
    .stat-value.down { color: #f87171; }
    .chart-wrap {
      position: relative;
      max-width: 1200px;
      margin: 0 auto;
      background: #131929;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px;
      padding: 14px 14px 10px;
    }
    .chart-container { position: relative; height: 68vh; min-height: 280px; }

    /* ── compact view ── */
    body.compact {
      margin: 0; padding: 0;
      background: transparent;
      min-height: 0;
      overflow-x: auto;
    }
    body.compact .chart-wrap {
      background: transparent;
      border: none;
      border-radius: 0;
      padding: 4px 4px 0;
      margin: 0;
    }
    body.compact .chart-container {
      height: clamp(200px, 40vw, 520px);
      min-height: 200px;
      max-height: 540px;
    }
    body.compact h1,
    body.compact .stats-grid { display: none; }

    /* light theme */
    body.light-theme {
      background: #f1f5f9;
      color: #1e293b;
    }
    body.light-theme h1 { color: #0f172a; }
    body.light-theme h1 .period { color: #64748b; }
    body.light-theme .stat-card {
      background: #ffffff;
      border-color: rgba(15, 23, 42, 0.08);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    body.light-theme .stat-label { color: #94a3b8; }
    body.light-theme .stat-value { color: #0f172a; }
    body.light-theme .chart-wrap {
      background: #ffffff;
      border-color: rgba(15, 23, 42, 0.08);
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
    }
  </style>
</head>
<body>
  <script>
    (function () {
      const p = new URLSearchParams(window.location.search);
      if (p.get('view') === 'compact') document.body.classList.add('compact');
      if (p.get('theme') === 'light') document.body.classList.add('light-theme');
    })();
  </script>

  <h1>
    <span class="sym">${symbol}</span> Price Chart
    <span class="period">${from} — ${to}</span>
  </h1>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Open</div>
      <div class="stat-value">${fmtPrice(data.startPrice)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Close</div>
      <div class="stat-value ${isUp ? "up" : "down"}">${fmtPrice(data.endPrice)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">High</div>
      <div class="stat-value">${fmtPrice(data.highPrice)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Low</div>
      <div class="stat-value">${fmtPrice(data.lowPrice)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Change</div>
      <div class="stat-value ${isUp ? "up" : "down"}">${sign}${pctChange}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Bars</div>
      <div class="stat-value">${data.dates.length}d</div>
    </div>
  </div>

  <div class="chart-wrap">
    <div class="chart-container">
      <canvas id="chart"></canvas>
    </div>
  </div>

  <script>
    const THEME = document.body.classList.contains('light-theme') ? {
      tick: '#64748b',
      grid: 'rgba(15, 23, 42, 0.06)',
      gridSecondary: 'rgba(15, 23, 42, 0.04)',
      axisBorder: 'rgba(15, 23, 42, 0.10)',
      legend: '#475569',
      tooltipBg: 'rgba(255, 255, 255, 0.96)',
      tooltipTitle: '#0f172a',
      tooltipBody: '#475569',
      tooltipBorder: 'rgba(15, 23, 42, 0.08)',
    } : {
      tick: '#475569',
      grid: 'rgba(255, 255, 255, 0.05)',
      gridSecondary: 'rgba(255, 255, 255, 0.04)',
      axisBorder: 'rgba(255, 255, 255, 0.08)',
      legend: '#94a3b8',
      tooltipBg: 'rgba(15, 17, 23, 0.92)',
      tooltipTitle: '#f1f5f9',
      tooltipBody: '#94a3b8',
      tooltipBorder: 'rgba(255, 255, 255, 0.1)',
    };

    const dates   = ${datesJson};
    const prices  = ${pricesJson};
    const volumes = ${volumesJson};

    const ctx = document.getElementById('chart').getContext('2d');
    new Chart(ctx, {
      data: {
        labels: dates,
        datasets: [
          {
            type: 'line',
            label: '${symbol} Price (USD)',
            data: prices,
            borderColor: 'rgba(56, 189, 248, 0.95)',
            backgroundColor: 'rgba(56, 189, 248, 0.06)',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: 'rgba(56, 189, 248, 1)',
            fill: true,
            tension: 0.2,
            yAxisID: 'yPrice',
            order: 1,
          },
          {
            type: 'bar',
            label: 'Volume (M USD)',
            data: volumes,
            backgroundColor: 'rgba(99, 102, 241, 0.25)',
            borderColor:     'rgba(99, 102, 241, 0.4)',
            borderWidth: 0,
            borderRadius: 2,
            yAxisID: 'yVol',
            order: 2,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: {
              color: THEME.legend,
              font: { size: 11 },
              padding: 14,
              usePointStyle: true,
              pointStyle: 'line',
            }
          },
          tooltip: {
            backgroundColor: THEME.tooltipBg,
            titleColor: THEME.tooltipTitle,
            bodyColor: THEME.tooltipBody,
            borderColor: THEME.tooltipBorder,
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: function(ctx) {
                if (ctx.dataset.yAxisID === 'yPrice') {
                  const v = ctx.parsed.y;
                  return ' ' + ctx.dataset.label + ': $' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
                }
                return ' ' + ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + 'M';
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: THEME.tick,
              font: { size: 10 },
              maxRotation: 45,
              minRotation: 0,
              maxTicksLimit: 10,
            },
            grid: { color: THEME.grid, tickLength: 0 },
            border: { color: THEME.axisBorder },
          },
          yPrice: {
            type: 'linear',
            position: 'left',
            ticks: {
              color: THEME.tick,
              font: { size: 10 },
              callback: function(v) {
                const n = Number(v);
                if (n >= 1000) return '$' + (n / 1000).toFixed(0) + 'k';
                if (n >= 1)    return '$' + n.toFixed(0);
                return '$' + n.toFixed(4);
              }
            },
            grid: { color: THEME.grid },
            border: { color: THEME.axisBorder },
            title: {
              display: true,
              text: 'Price (USD)',
              color: '#38bdf8',
              font: { size: 11, weight: '500' },
            },
          },
          yVol: {
            type: 'linear',
            position: 'right',
            ticks: {
              color: THEME.tick,
              font: { size: 10 },
              callback: function(v) { return Number(v).toFixed(0) + 'M'; }
            },
            grid: { drawOnChartArea: false, color: THEME.gridSecondary },
            border: { color: THEME.axisBorder },
            title: {
              display: true,
              text: 'Volume (M USD)',
              color: '#818cf8',
              font: { size: 11, weight: '500' },
            },
          }
        }
      }
    });

    /* ── iframe height sync ── */
    function sendHeight() {
      const compact = document.body.classList.contains('compact');
      const h = compact
        ? document.body.scrollHeight
        : Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      window.parent?.postMessage({ type: 'chartHeight', height: h }, '*');
    }
    window.addEventListener('load',   () => { setTimeout(sendHeight, 500); setTimeout(sendHeight, 1000); });
    window.addEventListener('resize', () => setTimeout(sendHeight, 300));
  </script>
</body>
</html>`;
}
