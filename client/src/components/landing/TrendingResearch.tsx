import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

export interface TrendingTaskChain {
  chainId: string;
  name: string;
  description: string | null;
  totalExecutions: number;
  lastUsedAt: number | null;
  shareCode: string | null;
}

interface TrendingResearchProps {
  onTaskChainClick: (chain: TrendingTaskChain) => void;
  containerStyle?: CSSProperties;
}

const getRankingBadge = (index: number) => {
  const badges = ['🥇', '🥈', '🥉'];
  return badges[index] || `#${index + 1}`;
};

const getRankingColor = (index: number) => {
  const colors = [
    'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
    'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
    'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
  ];
  return colors[index] || 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400';
};

export const TrendingResearch: React.FC<TrendingResearchProps> = ({ onTaskChainClick, containerStyle }) => {
  const { t } = useTranslation();

  // Fetch trending task chains from API
  const { data: response, isLoading } = useQuery<{ success: boolean; trending: TrendingTaskChain[] }>({
    queryKey: ['trending-taskchains'],
    queryFn: async () => {
      const BASE_URL =
        import.meta.env.VITE_SERVER_BASE_URL ||
        window.location.origin;
      const apiResponse = await fetch(`${BASE_URL}/trending-taskchains?limit=3`);
      if (!apiResponse.ok) throw new Error(t('landing.trendingResearch.loadError'));
      return apiResponse.json();
    },
    retry: 1,
  });

  const trendingChains = response?.trending ?? [];

  if (isLoading || trendingChains.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-6xl mx-auto py-12" style={containerStyle}>
      <div className="flex items-center gap-3 mb-8">
        <span className="text-2xl">🔥</span>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t("landing.trendingResearch.title")}
        </h2>
      </div>

      <div className="flex flex-col gap-4">
        {trendingChains.map((chain, index) => (
          <button
            key={chain.chainId}
            onClick={() => onTaskChainClick(chain)}
            className={`group p-5 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-xl transition-all duration-200 text-left relative overflow-hidden flex items-center gap-4 ${
              chain.shareCode ? "" : "opacity-60 cursor-not-allowed"
            }`}
            disabled={!chain.shareCode}
          >
            {/* Ranking Badge */}
            <div className="flex-shrink-0">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg ${getRankingColor(index)}`}>
                {getRankingBadge(index)}
              </div>
            </div>

            {/* Task Chain Content */}
            <div className="flex-1 min-w-0">
              {/* Task Chain Name */}
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
                {chain.name}
              </h3>

              {/* Description */}
              {chain.description && (
                <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                  {chain.description}
                </p>
              )}
            </div>

            {/* Hover Indicator */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-400 to-purple-400 transform scale-x-0 group-hover:scale-x-100 transition-transform duration-200" />
          </button>
        ))}
      </div>

      {trendingChains.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400">
            {t("landing.trendingResearch.empty")}
          </p>
        </div>
      )}
    </div>
  );
};
