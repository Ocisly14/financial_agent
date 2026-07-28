import React from 'react';
import { cn } from '../lib/utils';
import { CheckCircle, XCircle, Loader2, Circle, Database, BarChart3, TrendingUp, Zap } from "lucide-react";
import { useTranslation } from 'react-i18next';

interface ComprehensiveActionResult {
  action: string;
  phase: string;
  status: 'success' | 'failed' | 'pending';
  content: string;
  summary?: string;
  message?: any;
}

interface ComprehensiveTOCProps {
  actionResults: ComprehensiveActionResult[];
  selectedPhase: string | null;
  selectedAction: string | null;
  onPhaseClick: (phase: string) => void;
  onActionClick: (phase: string, action: string) => void;
  className?: string;
  unstyled?: boolean;
}

const getPhaseIcon = (phase: string) => {
  switch (phase) {
    case 'data_gathering':
      return <Database className="size-4 text-blue-500" />;
    case 'analysis':
      return <BarChart3 className="size-4 text-purple-500" />;
    case 'prediction':
      return <TrendingUp className="size-4 text-green-500" />;
    case 'writing_report':
      return <Zap className="size-4 text-amber-500" />;
    default:
      return <Circle className="size-4 text-gray-400" />;
  }
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'success':
      return <CheckCircle className="size-3 text-green-500" />;
    case 'failed':
      return <XCircle className="size-3 text-red-500" />;
    case 'pending':
      return <Loader2 className="size-3 text-blue-500 animate-spin" />;
    default:
      return <Circle className="size-3 text-gray-400" />;
  }
};

const getPhaseLabel = (phase: string, t: (key: string) => unknown): string => {
  switch (phase) {
    case 'data_gathering':
      return String(t('progress.phase.dataCollection'));
    case 'analysis':
      return String(t('progress.phase.analysis'));
    case 'prediction':
      return String(t('progress.phase.prediction'));
    case 'writing_report':
      return String(t('progress.phase.writingReport'));
    default:
      return String(t('progress.phase.processing'));
  }
};

const formatActionName = (actionName: string): string => {
  return actionName
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(' ')
    .filter(word => word.length > 0)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

/**
 * ComprehensiveTOC component for comprehensive analysis navigation
 * Displays a two-level table of contents with phases and actions
 */
export const ComprehensiveTOC: React.FC<ComprehensiveTOCProps> = ({
  actionResults,
  selectedPhase,
  selectedAction,
  onPhaseClick,
  onActionClick,
  className,
  unstyled = false
}) => {
  const { t } = useTranslation();
  // Group actions by phase
  const actionsByPhase = React.useMemo(() => {
    const phases = new Map<string, ComprehensiveActionResult[]>();
    const phaseOrder = ['data_gathering', 'analysis', 'prediction', 'writing_report'];

    actionResults.forEach(action => {
      const phase = action.phase || 'other';
      if (!phases.has(phase)) {
        phases.set(phase, []);
      }
      phases.get(phase)?.push(action);
    });

    // Sort phases by defined order
    const sortedPhases = new Map<string, ComprehensiveActionResult[]>();
    phaseOrder.forEach(phase => {
      if (phases.has(phase)) {
        sortedPhases.set(phase, phases.get(phase)!);
      }
    });

    // Add any remaining phases not in the order
    phases.forEach((actions, phase) => {
      if (!sortedPhases.has(phase)) {
        sortedPhases.set(phase, actions);
      }
    });

    return sortedPhases;
  }, [actionResults]);

  const navItems = (
    <div className="space-y-2">
      {Array.from(actionsByPhase.entries()).map(([phase, actions], phaseIndex) => {
        const phaseNumber = phaseIndex + 1;
        const isPhaseSelected = selectedPhase === phase && !selectedAction;

        return (
          <div key={phase} className="space-y-1">
            {/* Phase (Level 1) */}
            <button
              onClick={() => onPhaseClick(phase)}
              className={cn(
                "relative w-full text-left text-sm md:text-xs transition-colors duration-200 rounded-lg px-2.5 py-2.5 md:py-2 border min-h-[44px] md:min-h-0",
                "flex items-center gap-2 backdrop-blur-sm",
                isPhaseSelected
                  ? "backdrop-blur-md bg-emerald-50 dark:bg-white/20 border-emerald-200 dark:border-white/30 text-emerald-600 dark:text-emerald-500/90 font-semibold shadow"
                  : "border-transparent text-slate-700 dark:text-foreground/70 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:border-slate-200 dark:hover:border-white/25"
              )}
              type="button"
            >
              <span className={cn(
                "flex size-5 items-center justify-center rounded-full border border-transparent",
                isPhaseSelected && "border-emerald-300/70 bg-emerald-400/10"
              )}>
                {getPhaseIcon(phase)}
              </span>
              <span className={cn(
                "text-slate-600 dark:text-foreground/60",
                isPhaseSelected && "text-emerald-600 dark:text-emerald-500"
              )}>
                {phaseNumber}
              </span>
              <span className={cn(
                "flex-1",
                isPhaseSelected && "text-emerald-600 dark:text-emerald-500"
              )}>
                {getPhaseLabel(phase, t)}
              </span>
              <span className={cn(
                "text-slate-500 dark:text-foreground/40 text-[10px]",
                isPhaseSelected && "text-emerald-600 dark:text-emerald-500"
              )}>
                {actions.filter(a => a.status === 'success').length}/{actions.length}
              </span>
            </button>

            {/* Actions (Level 2) */}
            {actions.map((action, actionIndex) => {
              const actionNumber = `${phaseNumber}.${actionIndex + 1}`;
              const isActionSelected = selectedPhase === phase && selectedAction === action.action;

              return (
                <button
                  key={action.action}
                  onClick={() => onActionClick(phase, action.action)}
                  className={cn(
                    "relative w-full text-left text-sm md:text-xs transition-colors duration-200 rounded-lg px-2.5 py-2 md:py-1.5 border min-h-[40px] md:min-h-0",
                    "flex items-center gap-2 backdrop-blur-sm",
                    "pl-8",
                    isActionSelected
                      ? "backdrop-blur-md bg-emerald-50 dark:bg-white/20 border-emerald-200 dark:border-white/30 text-emerald-600 dark:text-emerald-500/90 font-semibold shadow"
                      : "border-transparent text-slate-600 dark:text-foreground/60 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:border-slate-200 dark:hover:border-white/25"
                  )}
                  type="button"
                >
                  <span className={cn(
                    "flex size-4 items-center justify-center",
                    isActionSelected && "text-emerald-600 dark:text-emerald-500"
                  )}>
                    {getStatusIcon(action.status)}
                  </span>
                  <span className={cn(
                    "text-slate-500 dark:text-foreground/50 text-[10px]",
                    isActionSelected && "text-emerald-600 dark:text-emerald-500"
                  )}>
                    {actionNumber}
                  </span>
                  <span className={cn(
                    "flex-1 line-clamp-1 leading-relaxed",
                    isActionSelected && "text-emerald-600 dark:text-emerald-500"
                  )}>
                    {formatActionName(action.action)}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );

  if (unstyled) {
    return (
      <nav className={cn("space-y-2", className)} aria-label={t('progress.analysisSteps')}>
        {navItems}
      </nav>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 dark:border-white/10",
        "bg-white/20 dark:bg-white/5 backdrop-blur-xl",
        "shadow-[0_12px_30px_rgba(15,23,42,0.15)] dark:shadow-[0_12px_30px_rgba(15,23,42,0.45)]",
        "supports-[backdrop-filter]:bg-white/15 supports-[backdrop-filter]:dark:bg-white/5",
        "flex flex-col max-h-full",
        className
      )}
    >
      <div className="flex-shrink-0 p-3 pb-2 border-b border-slate-200 dark:border-white/10">
        <h3 className="text-sm font-medium text-foreground/80">
          {t('progress.analysisSteps')}
        </h3>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-2 scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent" aria-label={t('progress.analysisSteps')}>
        {navItems}
      </nav>
    </div>
  );
};
