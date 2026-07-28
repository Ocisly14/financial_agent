import { useTranslation } from "react-i18next";
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { LandingPageHero } from '../components/landing/LandingPageHero';
import { DailyAnalysis } from '../components/landing/DailyAnalysis';
import { TrendingResearch, type TrendingTaskChain } from '../components/landing/TrendingResearch';
import { AgentToolsShowcase } from '../components/landing/AgentToolsShowcase';
import { SidebarTrigger, useSidebar } from '../components/ui/sidebar';
import { apiClient } from '../lib/api';

interface AgentSummary {
  id: string;
  name?: string;
}

export default function LandingPage() {
  const navigate = useNavigate();
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const { state, isMobile } = useSidebar();
  const [defaultAgent, setDefaultAgent] = useState<AgentSummary | null>(null);
  const agentFetchPromiseRef = useRef<Promise<AgentSummary | null> | null>(null);
  const { t } = useTranslation();

  const dynamicContentWidth = useMemo(() => {
    if (isMobile) {
      return undefined;
    }
    const sidebarWidthVar =
      state === 'collapsed' ? 'var(--sidebar-width-icon)' : 'var(--sidebar-width)';
    return {
      maxWidth: `calc(100vw - ${sidebarWidthVar})`,
    } as CSSProperties;
  }, [isMobile, state]);

  const containerClassName = useMemo(() => {
    const base = 'flex-1 min-h-screen w-full overflow-x-hidden transition-[width] duration-300';
    return isMobile ? `${base} overflow-y-visible` : `${base} overflow-y-auto`;
  }, [isMobile]);

  const resolveDefaultAgent = useCallback(async (): Promise<AgentSummary | null> => {
    if (defaultAgent) {
      return defaultAgent;
    }
    if (agentFetchPromiseRef.current) {
      return agentFetchPromiseRef.current;
    }

    const fetchPromise = (async () => {
      const agentsData = await apiClient.getAgents();
      const agents = agentsData.agents || [];
      if (agents.length === 0) {
        console.error('No agents available');
        return null;
      }
      const defaultAgentRecord: AgentSummary = agents[0];
      setDefaultAgent(defaultAgentRecord);
      return defaultAgentRecord;
    })().finally(() => {
      agentFetchPromiseRef.current = null;
    });

    agentFetchPromiseRef.current = fetchPromise;
    return fetchPromise;
  }, [defaultAgent]);

  useEffect(() => {
    void resolveDefaultAgent();
  }, [resolveDefaultAgent]);

  // Auto-create chat session when user submits search
  const handleSearch = useCallback(
    async (query: string, files?: File[]) => {
      if (!query?.trim() && (!files || files.length === 0)) {
        return;
      }
      try {
        setIsCreatingChat(true);
        const agent = await resolveDefaultAgent();
        if (!agent) {
          console.error('No agents available');
          return;
        }
        const roomData = await apiClient.createRoom(agent.id);
        const room = roomData.room;
        navigate(`/chat/${agent.id}/${room.id}`, {
          state: { initialMessage: query, initialFiles: files },
        });
      } catch (error) {
        console.error('Error creating chat:', error);
      } finally {
        setIsCreatingChat(false);
      }
    },
    [navigate, resolveDefaultAgent]
  );

  const handleTaskChainClick = useCallback((_chain: TrendingTaskChain) => {
    alert(t('landing.alerts.trendingUnavailable'));
  }, [t]);

  const handleVoiceStart = () => {
    alert(t('landing.alerts.voiceUnavailable'));
  };

  return (
    <div
      className={containerClassName}
      style={dynamicContentWidth}
    >
      {/* Mobile Header with Sidebar Trigger */}
      <div className="sticky top-0 z-20 flex items-center gap-2 px-4 py-3 border-b border-slate-300 dark:border-white/20 backdrop-blur-md bg-background/80 md:hidden">
        <SidebarTrigger data-tour="sidebar-toggle" />
      </div>

      {/* Main content */}
      <main className="w-full pb-12 px-4 md:px-8 lg:px-12">
        {/* Hero section */}
        <section className="py-16">
          <LandingPageHero
            onSearch={handleSearch}
            onVoiceStart={handleVoiceStart}
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Daily analysis section */}
        <section className="py-8 border-t border-gray-200 dark:border-gray-700">
          <DailyAnalysis
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Trending task chains section */}
        <section className="py-8 border-t border-gray-200 dark:border-gray-700">
          <TrendingResearch
            onTaskChainClick={handleTaskChainClick}
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Agent tools showcase section */}
        <section className="py-8 border-t border-gray-200 dark:border-gray-700">
          <AgentToolsShowcase
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Footer */}
        <footer className="py-12 px-6 border-t border-gray-200 dark:border-gray-700">
          <div className="max-w-6xl mx-auto" style={dynamicContentWidth}>
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="text-center md:text-left">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                  Financial Agent
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t("landing.footer.tagline")}
                </p>
              </div>
            </div>
            <div className="mt-8 text-center text-xs text-gray-500 dark:text-gray-500">
              {t("landing.footer.copyright")}
            </div>
          </div>
        </footer>
      </main>

      {/* Loading overlay */}
      {isCreatingChat && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent" />
            <p className="text-gray-900 dark:text-white font-medium">
              Starting your conversation...
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
