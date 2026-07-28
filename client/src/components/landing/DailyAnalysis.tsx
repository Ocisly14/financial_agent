import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Calendar, ExternalLink, FileText } from 'lucide-react';
import { useSidebar } from '../ui/sidebar';
import { useTranslation } from 'react-i18next';

interface DailyAnalysisItem {
  fileName: string;
  date: string;
  /** Symbol the report covers, e.g. "BTC" or "ETH". Backend tags this from the
   *  filename. Optional for forward-compat with older payloads. */
  symbol?: string;
  summary?: string;
}

interface DailyAnalysisResponse {
  success: boolean;
  reports: DailyAnalysisItem[];
}

interface DailyAnalysisProps {
  containerStyle?: CSSProperties;
}

interface DailyAnalysisCardProps {
  report: DailyAnalysisItem;
  symbol: string;
  isToday: boolean;
  onOpen: (fileName: string) => void;
  formatDate: (dateStr?: string) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const BASE_URL =
  import.meta.env.VITE_SERVER_BASE_URL ||
  window.location.origin;

// Per-symbol palette for the icon tile + accent bar. Anything not listed falls
// back to the generic blue scheme so adding a new symbol on the backend stays
// safe even before the UI is updated.
const SYMBOL_THEMES: Record<
  string,
  {
    iconBg: string;
    iconFg: string;
    accent: string;
    pillBg: string;
    pillFg: string;
  }
> = {
  BTC: {
    iconBg: 'bg-orange-50 dark:bg-orange-900/40',
    iconFg: 'text-orange-600 dark:text-orange-300',
    accent: 'from-orange-500 via-amber-500 to-yellow-500',
    pillBg: 'bg-orange-100 dark:bg-orange-900/30',
    pillFg: 'text-orange-700 dark:text-orange-300',
  },
  ETH: {
    iconBg: 'bg-indigo-50 dark:bg-indigo-900/40',
    iconFg: 'text-indigo-600 dark:text-indigo-300',
    accent: 'from-indigo-500 via-violet-500 to-purple-500',
    pillBg: 'bg-indigo-100 dark:bg-indigo-900/30',
    pillFg: 'text-indigo-700 dark:text-indigo-300',
  },
  SOL: {
    iconBg: 'bg-teal-50 dark:bg-teal-900/40',
    iconFg: 'text-teal-600 dark:text-teal-300',
    accent: 'from-teal-500 via-emerald-500 to-lime-500',
    pillBg: 'bg-teal-100 dark:bg-teal-900/30',
    pillFg: 'text-teal-700 dark:text-teal-300',
  },
};

const DEFAULT_THEME: (typeof SYMBOL_THEMES)['BTC'] = {
  iconBg: 'bg-blue-50 dark:bg-blue-900/40',
  iconFg: 'text-blue-600 dark:text-blue-300',
  accent: 'from-blue-500 via-cyan-500 to-emerald-500',
  pillBg: 'bg-blue-100 dark:bg-blue-900/30',
  pillFg: 'text-blue-700 dark:text-blue-300',
};

function getThemeForSymbol(symbol: string) {
  return SYMBOL_THEMES[symbol.toUpperCase()] ?? DEFAULT_THEME;
}

// Extract the symbol from a report. Prefer the explicit `symbol` field set by
// the backend; fall back to parsing the filename for older payloads
// ("comprehensive analysis BTC 2026-04-29.html" → "BTC").
function getSymbolFromReport(report: DailyAnalysisItem): string {
  if (report.symbol && report.symbol.trim().length > 0) {
    return report.symbol.toUpperCase();
  }
  const match = report.fileName.match(
    /^comprehensive analysis ([A-Z0-9]+) \d{4}-\d{2}-\d{2}\.html$/i,
  );
  return match?.[1]?.toUpperCase() ?? 'UNKNOWN';
}

function DailyAnalysisCard({
  report,
  symbol,
  isToday,
  onOpen,
  formatDate,
  t,
}: DailyAnalysisCardProps) {
  const theme = getThemeForSymbol(symbol);

  return (
    <button
      type="button"
      onClick={() => onOpen(report.fileName)}
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white p-6 text-left transition-all duration-200 hover:-translate-y-1 hover:border-blue-400 hover:shadow-xl dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-600"
    >
      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${theme.accent}`} />

      <div className="mb-5 flex items-start justify-between gap-4">
        <div
          className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl ${theme.iconBg}`}
        >
          <FileText className={`h-6 w-6 ${theme.iconFg}`} />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tracking-wide ${theme.pillBg} ${theme.pillFg}`}
          >
            {symbol}
          </span>
          {isToday ? (
            <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              {t('common.latest')}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex-1">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('landing.dailyAnalysis.cardTitle', { symbol })}
        </h3>

        <div className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200">
          <Calendar className="h-3.5 w-3.5" />
          <span>{formatDate(report.date)}</span>
        </div>

        {report.summary ? (
          <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
            {report.summary}
          </p>
        ) : (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            {t('landing.dailyAnalysis.emptySummary')}
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center gap-1.5 text-sm font-medium text-blue-600 transition-colors group-hover:text-blue-700 dark:text-blue-400 dark:group-hover:text-blue-300">
        <span>{t('landing.dailyAnalysis.cta')}</span>
        <ExternalLink className="h-3.5 w-3.5" />
      </div>
    </button>
  );
}

export const DailyAnalysis: React.FC<DailyAnalysisProps> = ({ containerStyle }) => {
  const navigate = useNavigate();
  const { setOpen } = useSidebar();
  const { t, i18n } = useTranslation();

  // Pull a wider window than we render so we can group by symbol and pick the
  // latest report per symbol (BTC + ETH today = at least 2). Limit 10 leaves
  // headroom if more symbols get added on the backend.
  const { data, isLoading } = useQuery<DailyAnalysisResponse>({
    queryKey: ['daily-analysis', 'recent'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/daily-analysis/recent?limit=15`);
      if (!res.ok) throw new Error(t('landing.dailyAnalysis.loadError'));
      return res.json();
    },
    retry: 1,
    refetchInterval: 5 * 60 * 1000,
  });

  if (isLoading || !data?.reports?.length) {
    return null;
  }

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString(i18n.language, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const openReport = (fileName: string) => {
    setOpen(false);
    navigate(`/report/daily?fileName=${encodeURIComponent(fileName)}`);
  };

  // Render exactly one card per symbol (the most recent report for that
  // symbol). The backend already sorts `listReports()` newest-first with the
  // configured target order as the tie-breaker, so the first occurrence of a
  // symbol in `data.reports` is the one to show.
  const cards: Array<{ report: DailyAnalysisItem; symbol: string; isToday: boolean }> = [];
  const seen = new Set<string>();
  const today = new Date().toISOString().split('T')[0];

  for (const report of data.reports) {
    const symbol = getSymbolFromReport(report);
    if (symbol === 'UNKNOWN') continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    cards.push({ report, symbol, isToday: report.date === today });
  }

  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-6xl mx-auto py-12" style={containerStyle}>
      <div className="mb-6 flex items-center gap-3">
        <span className="text-2xl">📊</span>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t('landing.dailyAnalysis.title')}
        </h2>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {cards.map(({ report, symbol, isToday }) => (
          <DailyAnalysisCard
            key={`${symbol}:${report.fileName}`}
            report={report}
            symbol={symbol}
            isToday={isToday}
            onOpen={openReport}
            formatDate={formatDate}
            t={t}
          />
        ))}
      </div>
    </div>
  );
};
