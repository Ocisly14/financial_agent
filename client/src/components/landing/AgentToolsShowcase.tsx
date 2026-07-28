import type { CSSProperties } from 'react';
import { TrendingUp, BarChart3, Brain, Newspaper, Activity, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface AgentTool {
  id: string;
  name: string;
  description: string;
  icon: string;
  metric?: string;
  preview?: string;
}

interface AgentToolsShowcaseProps {
  containerStyle?: CSSProperties;
}

const getIconComponent = (iconName: string) => {
  const icons: Record<string, React.ReactNode> = {
    sentiment: <TrendingUp className="w-8 h-8" />,
    technical: <BarChart3 className="w-8 h-8" />,
    prediction: <Brain className="w-8 h-8" />,
    news: <Newspaper className="w-8 h-8" />,
    onchain: <Activity className="w-8 h-8" />,
    market: <Target className="w-8 h-8" />,
  };
  return icons[iconName] || <TrendingUp className="w-8 h-8" />;
};

export const AgentToolsShowcase: React.FC<AgentToolsShowcaseProps> = ({ containerStyle }) => {
  const { t } = useTranslation();
  const agentTools = t("landing.agentTools.tools", { returnObjects: true }) as AgentTool[];
  const previews: Record<string, string> = {
    sentiment: "📊",
    comprehensive: "📊",
    prediction: "🔮",
    technical: "📈",
    onchain: "⛓️",
    news: "📰",
  };

  return (
    <div className="w-full max-w-6xl mx-auto py-12" style={containerStyle}>
      <div className="flex items-center gap-3 mb-8">
        <span className="text-2xl">🛠️</span>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t("landing.agentTools.title")}
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {agentTools.map((tool) => (
          <div
            key={tool.id}
            className="p-6 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="p-3 bg-gray-100 dark:bg-gray-700 rounded-xl text-blue-600 dark:text-blue-400">
                {getIconComponent(tool.icon)}
              </div>
              {previews[tool.id] && (
                <span className="text-3xl opacity-20">
                  {previews[tool.id]}
                </span>
              )}
            </div>

            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
              {tool.name}
            </h3>

            {tool.metric && (
              <div className="mb-2">
                <span className="text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2 py-1 rounded">
                  {tool.metric}
                </span>
              </div>
            )}

            <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
              {tool.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};
