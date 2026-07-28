// Shared multi-panel dashboard renderer for on-chain / sentiment analysis tools.
// Visual style matches mcp_tools/chart/chartRenderer.ts (dark navy theme, aligned
// with financial-agent_2.0's htmlPriceOverlay.ts) but supports stacking N chart
// panels (line/bar, single or dual y-axis, optional per-bar colors) on one page.

export type ChartValueFormat = "number" | "percent" | "usd" | "usd_millions" | "compact";

export type ChartDataset = {
  label: string;
  data: number[];
  type?: "line" | "bar";
  /** Single color (rgba/hex) applied to border + a translucent fill. */
  color?: string;
  /** Per-point colors (e.g. fear/greed sentiment bands). Overrides `color` for bar fill. */
  colors?: string[];
  fill?: boolean;
  yAxisID?: "y" | "y1";
  borderDash?: number[];
};

export type ChartPanel = {
  title: string;
  labels: string[];
  datasets: ChartDataset[];
  yTitle?: string;
  y1Title?: string;
  yFormat?: ChartValueFormat;
  y1Format?: ChartValueFormat;
};

export type StatCard = {
  label: string;
  value: string;
  cls?: "up" | "down" | "";
};

const FORMAT_FNS: Record<ChartValueFormat, string> = {
  number: `function(v){ return Number(v).toFixed(2); }`,
  percent: `function(v){ return Number(v).toFixed(2) + '%'; }`,
  usd: `function(v){ const n = Number(v); return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }); }`,
  usd_millions: `function(v){ return '$' + Number(v).toFixed(2) + 'M'; }`,
  compact: `function(v){ const n = Number(v); if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2)+'B'; if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2)+'M'; if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(2)+'K'; return n.toFixed(2); }`,
};

function rgbaFromColor(color: string, alpha: number): string {
  // Accept "rgba(r,g,b,a)" or "rgb(r,g,b)" or hex. Best-effort fill derivation.
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1]!.split(",").map((s) => s.trim());
    const [r, g, b] = parts;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function buildDatasetJs(ds: ChartDataset, panelIndex: number, dsIndex: number): string {
  const type = ds.type ?? "line";
  const color = ds.color ?? "rgba(56, 189, 248, 0.95)";
  const fill = ds.fill ?? type === "line";
  const yAxisID = ds.yAxisID ?? "y";

  const base: Record<string, unknown> = {
    type,
    label: ds.label,
    data: ds.data,
    yAxisID,
  };

  if (type === "line") {
    base["borderColor"] = color;
    base["backgroundColor"] = fill ? rgbaFromColor(color, 0.08) : color;
    base["borderWidth"] = 2;
    base["pointRadius"] = 0;
    base["pointHoverRadius"] = 4;
    base["pointHoverBackgroundColor"] = color;
    base["fill"] = fill;
    base["tension"] = 0.2;
    if (ds.borderDash) base["borderDash"] = ds.borderDash;
  } else {
    if (ds.colors && ds.colors.length > 0) {
      base["backgroundColor"] = ds.colors;
      base["borderColor"] = ds.colors;
    } else {
      base["backgroundColor"] = rgbaFromColor(color, 0.5);
      base["borderColor"] = color;
    }
    base["borderWidth"] = 0;
    base["borderRadius"] = 2;
  }
  base["order"] = dsIndex + 1;

  return JSON.stringify(base);
}

function buildPanelScript(panel: ChartPanel, index: number): string {
  const labelsJson = JSON.stringify(panel.labels);
  const datasetsJson = `[${panel.datasets.map((ds, i) => buildDatasetJs(ds, index, i)).join(",")}]`;
  const yFormat = FORMAT_FNS[panel.yFormat ?? "compact"];
  const y1Format = FORMAT_FNS[panel.y1Format ?? "compact"];
  const hasY1 = panel.datasets.some((d) => d.yAxisID === "y1");

  const scales: string[] = [];
  scales.push(`
          x: {
            ticks: { color: THEME.tick, font: { size: 10 }, maxRotation: 45, minRotation: 0, maxTicksLimit: 12 },
            grid: { color: THEME.grid, tickLength: 0 },
            border: { color: THEME.axisBorder },
          },
          y: {
            type: 'linear',
            position: 'left',
            ticks: { color: THEME.tick, font: { size: 10 }, callback: ${yFormat} },
            grid: { color: THEME.grid },
            border: { color: THEME.axisBorder },
            ${panel.yTitle ? `title: { display: true, text: ${JSON.stringify(panel.yTitle)}, color: '#38bdf8', font: { size: 11, weight: '500' } },` : ""}
          }`);

  if (hasY1) {
    scales.push(`
          y1: {
            type: 'linear',
            position: 'right',
            ticks: { color: THEME.tick, font: { size: 10 }, callback: ${y1Format} },
            grid: { drawOnChartArea: false, color: THEME.gridSecondary },
            border: { color: THEME.axisBorder },
            ${panel.y1Title ? `title: { display: true, text: ${JSON.stringify(panel.y1Title)}, color: '#818cf8', font: { size: 11, weight: '500' } },` : ""}
          }`);
  }

  return `
    new Chart(document.getElementById('chart-${index}').getContext('2d'), {
      data: {
        labels: ${labelsJson},
        datasets: ${datasetsJson},
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: THEME.legend, font: { size: 11 }, padding: 14, usePointStyle: true, pointStyle: 'line' },
          },
          tooltip: {
            backgroundColor: THEME.tooltipBg,
            titleColor: THEME.tooltipTitle,
            bodyColor: THEME.tooltipBody,
            borderColor: THEME.tooltipBorder,
            borderWidth: 1,
            padding: 10,
          },
        },
        scales: {${scales.join(",")}
        },
      },
    });`;
}

export function renderAnalysisDashboardHtml(opts: {
  title: string;
  subtitle: string;
  statCards?: StatCard[];
  panels: ChartPanel[];
}): string {
  const { title, subtitle, statCards = [], panels } = opts;

  const statCardsHtml = statCards
    .map(
      (c) => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(c.label)}</div>
      <div class="stat-value ${c.cls ?? ""}">${escapeHtml(c.value)}</div>
    </div>`,
    )
    .join("");

  const panelsHtml = panels
    .map(
      (p, i) => `
  <div class="chart-wrap">
    <h2 class="panel-title">${escapeHtml(p.title)}</h2>
    <div class="chart-container">
      <canvas id="chart-${i}"></canvas>
    </div>
  </div>`,
    )
    .join("");

  const scripts = panels.map((p, i) => buildPanelScript(p, i)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
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
    .panel-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: #94a3b8;
      margin: 0 0 10px;
      letter-spacing: 0.01em;
    }
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
      margin: 0 auto 16px;
      background: #131929;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px;
      padding: 14px 14px 10px;
    }
    .chart-container { position: relative; height: 38vh; min-height: 240px; }

    /* compact view */
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
      margin: 0 0 12px;
    }
    body.compact .chart-container {
      height: clamp(200px, 36vw, 420px);
      min-height: 180px;
      max-height: 460px;
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
    body.light-theme .panel-title { color: #475569; }
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

  <h1>${escapeHtml(title)}<span class="period">${escapeHtml(subtitle)}</span></h1>

  ${statCardsHtml ? `<div class="stats-grid">${statCardsHtml}</div>` : ""}

  ${panelsHtml}

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

    ${scripts}

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function safeChartFilename(name: string, symbol: string, from: string, to: string): string {
  return `${name} ${symbol} ${from}_${to}.html`.replace(/[^a-zA-Z0-9 ._-]/g, "_");
}
