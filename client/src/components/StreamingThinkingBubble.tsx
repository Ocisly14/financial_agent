import type React from 'react';
import { useState, useEffect, useRef } from 'react';
import { Brain, CheckCircle, XCircle, Loader2, Circle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProcessingStep } from '@/types';
import { useTranslation } from 'react-i18next';

interface StreamingThinkingBubbleProps {
    steps: ProcessingStep[];
    isComplete: boolean;
    className?: string;
    onDismiss?: () => void;
}

const getStepIcon = (status: ProcessingStep['status']) => {
    switch (status) {
        case 'completed':
            return <CheckCircle className="size-4 text-green-500" />;
        case 'error':
            return <XCircle className="size-4 text-red-500" />;
        case 'in_progress':
            return <Loader2 className="size-4 text-blue-500 animate-spin" />;
        case 'pending':
            return <Circle className="size-4 text-gray-400" />;
        default:
            return <Circle className="size-4 text-gray-400" />;
    }
};

const getStepColor = (status: ProcessingStep['status']) => {
    switch (status) {
        case 'completed':
            return 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950';
        case 'error':
            return 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950';
        case 'in_progress':
            return 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950';
        case 'pending':
            return 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900';
        default:
            return 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900';
    }
};

export const StreamingThinkingBubble: React.FC<StreamingThinkingBubbleProps> = ({ 
    steps, 
    isComplete, 
    className,
    onDismiss 
}) => {
    const { t, i18n } = useTranslation();
    const [visibleSteps, setVisibleSteps] = useState<ProcessingStep[]>([]);
    const [isCollapsed, setIsCollapsed] = useState(false); // Start expanded to show details
    const stepMapRef = useRef(new Map<string, ProcessingStep>());
    
    // Reset the step map when component mounts (new bubble instance)
    useEffect(() => {
        stepMapRef.current.clear();
    }, []); // Empty dependency array means this runs only on mount

    useEffect(() => {
        // If steps array is empty, clear the internal map
        if (steps.length === 0) {
            stepMapRef.current.clear();
            setVisibleSteps([]);
            return;
        }
        
        // Process incoming steps and merge with existing ones
        steps.forEach(step => {
            // Use a combination of name and initial timestamp as key
            // For updates to the same logical step, we'll find by name and update
            let existingEntry = null;
            
            // First, try to find an existing step with the same ID
            for (const [key, existingStep] of stepMapRef.current.entries()) {
                if (existingStep.id === step.id) {
                    existingEntry = key;
                    break;
                }
            }
            
            // If no ID match, look for a step with the same name that could be updated
            if (!existingEntry) {
                for (const [key, existingStep] of stepMapRef.current.entries()) {
                    if (existingStep.name === step.name && 
                        existingStep.status === 'in_progress' && 
                        (step.status === 'completed' || step.status === 'error')) {
                        existingEntry = key;
                        break;
                    }
                }
            }
            
            if (existingEntry) {
                // Update existing step
                stepMapRef.current.set(existingEntry, step);
            } else {
                // Add new step with unique key
                const key = `${step.name}-${step.id}-${step.timestamp}`;
                stepMapRef.current.set(key, step);
            }
        });
        
        // Convert map to array and sort by timestamp
        let newSteps = Array.from(stepMapRef.current.values()).sort((a, b) => a.timestamp - b.timestamp);
        
        // Auto-complete certain steps when processing is complete
        if (isComplete) {
            const autoCompleteSteps = ['initialize', 'action_discovery'];
            newSteps = newSteps.map(step => {
                if (autoCompleteSteps.includes(step.name) && 
                    (step.status === 'in_progress' || step.status === 'pending')) {
                    return {
                        ...step,
                        status: 'completed' as const,
                        message: step.message || t('progress.stepCompleted', { name: step.name })
                    };
                }
                return step;
            });
        }
        
        setVisibleSteps(newSteps);
    }, [steps, isComplete, t]);

    // Auto-collapse after completion (disabled to keep bubble visible)
    // useEffect(() => {
    //     if (isComplete && visibleSteps.length > 0) {
    //         const timer = setTimeout(() => {
    //             setIsCollapsed(true);
    //         }, 5000); // Auto-collapse after 5 seconds
    //         return () => clearTimeout(timer);
    //     }
    // }, [isComplete, visibleSteps.length]);

    if (visibleSteps.length === 0) return null;

    const currentStep = visibleSteps[visibleSteps.length - 1];
    const completedSteps = visibleSteps.filter(s => s.status === 'completed').length;
    const errorSteps = visibleSteps.filter(s => s.status === 'error').length;
    // Total steps is the current visible steps count
    const totalSteps = visibleSteps.length;
    // Progress calculation: completed + error steps (both are "finished") vs total
    const finishedSteps = completedSteps + errorSteps;

    return (
        <div className={cn(
            "border border-dashed border-muted-foreground/30 bg-muted/20 rounded-lg p-3 mb-2 w-full transition-all duration-300",
            isCollapsed && "cursor-pointer hover:bg-muted/30",
            className
        )}>
            {/* Header - Only show if not using card layout (when onDismiss is provided and className contains specific classes) */}
            {!(className?.includes('border-0') && className?.includes('rounded-none')) && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
                    <div 
                        className="flex items-center gap-2 cursor-pointer flex-1"
                        onClick={() => setIsCollapsed(!isCollapsed)}
                    >
                        <Brain className="size-4" />
                        <span className="font-medium">
                            {isComplete ? t('progress.processingComplete') : t('progress.aiProcessing')}
                        </span>
                        {isComplete && (
                            <CheckCircle className="size-4 text-green-500" />
                        )}
                        {!isComplete && (
                            <Loader2 className="size-4 text-blue-500 animate-spin" />
                        )}
                    </div>
                    {/* Dismiss button - only show when complete */}
                    {isComplete && onDismiss && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onDismiss();
                            }}
                            className="p-1 hover:bg-muted rounded-sm transition-colors"
                            title={t('common.dismiss')}
                        >
                            <X className="size-3" />
                        </button>
                    )}
                </div>
            )}

            {/* Progress bar */}
            {!isCollapsed && (
                <div className={cn(
                    "mb-3",
                    className?.includes('border-0') ? "mt-0" : "mt-2"
                )}>
                    <div className="flex justify-between text-xs text-muted-foreground mb-2">
                        <span className="font-medium">{t('progress.progress')}</span>
                        <span className="font-mono">{finishedSteps}/{totalSteps}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2 dark:bg-gray-700">
                        <div 
                            className="bg-gradient-to-r from-blue-500 to-green-500 h-2 rounded-full transition-all duration-500 ease-out"
                            style={{ width: `${totalSteps > 0 ? (finishedSteps / totalSteps) * 100 : 0}%` }}
                        />
                    </div>
                </div>
            )}


            {/* Current step display (always visible when not collapsed) */}
            {!isCollapsed && currentStep && (
                <div className={cn(
                    "rounded-md p-3 mb-3 border transition-all duration-200",
                    getStepColor(currentStep.status)
                )}>
                    <div className="flex items-start gap-2 mb-2">
                        <div className="mt-0.5">{getStepIcon(currentStep.status)}</div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-sm font-semibold truncate">{currentStep.name}</span>
                                <span className="text-xs text-muted-foreground ml-2 whitespace-nowrap">
                                    {new Date(currentStep.timestamp).toLocaleTimeString(i18n.language)}
                                </span>
                            </div>
                            <div className="text-sm text-foreground leading-relaxed">
                                {currentStep.message}
                            </div>
                            {/* Show task configuration details */}
                            {currentStep.name.includes('action_selection') && currentStep.data && (
                                <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-950 rounded border border-blue-200 dark:border-blue-800">
                                    <div className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2 flex items-center gap-1">
                                        {currentStep.data.taskType === 'action' ? '🎯' : '🧠'} 
                                        {currentStep.data.taskType === 'action'
                                            ? t('progress.actionsSelectedFor', { name: currentStep.data.taskName })
                                            : t('progress.llmTaskConfiguredFor', { name: currentStep.data.taskName })}
                                    </div>
                                    
                                    {/* Show actions for action tasks */}
                                    {currentStep.data.taskType === 'action' && currentStep.data.selectedActions && (
                                        <div className="space-y-2">
                                            {currentStep.data.selectedActions.map((action: any, idx: number) => (
                                                <div key={idx} className="text-xs bg-white dark:bg-gray-900 p-2 rounded border">
                                                    <div className="font-medium text-blue-700 dark:text-blue-300">
                                                        {action.action}
                                                    </div>
                                                    {action.parameters && Object.keys(action.parameters).length > 0 && (
                                                        <div className="mt-1 text-muted-foreground">
                                                            {t('progress.parametersLabel')}: {Object.entries(action.parameters).map(([key, value]) => 
                                                                `${key}: ${value}`
                                                            ).join(', ')}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    
                                    {/* Show task type for LLM tasks */}
                                    {currentStep.data.taskType === 'llm' && (
                                        <div className="text-xs bg-white dark:bg-gray-900 p-2 rounded border">
                                            <div className="font-medium text-blue-700 dark:text-blue-300">
                                                {t('progress.analysisSynthesisTask')}
                                            </div>
                                            <div className="mt-1 text-muted-foreground">
                                                {t('progress.analysisSynthesisDescription')}
                                            </div>
                                        </div>
                                    )}
                                    
                                    {currentStep.data.description && (
                                        <div className="mt-2 text-xs text-blue-700 dark:text-blue-300">
                                            {currentStep.data.description}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    {currentStep.error && (
                        <div className="text-sm text-red-600 dark:text-red-400 mt-3 p-3 bg-red-50 dark:bg-red-950 rounded border border-red-200 dark:border-red-800">
                            <div className="font-semibold mb-1 flex items-center gap-1">
                                ⚠️ {t('progress.errorLabel')}:
                            </div>
                            <div className="leading-relaxed">{currentStep.error}</div>
                        </div>
                    )}
                </div>
            )}

            {/* Collapsed view - just show current step */}
            {isCollapsed && currentStep && (
                <div className="mt-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {getStepIcon(currentStep.status)}
                        <span>{currentStep.message}</span>
                    </div>
                </div>
            )}

            {/* All steps (expandable) */}
            {!isCollapsed && visibleSteps.length > 1 && (
                <details open className="mt-4">
                    <summary className="text-sm font-medium text-muted-foreground cursor-pointer hover:text-foreground mb-3 flex items-center gap-2">
                        📋 {t('progress.allProcessingSteps', { count: visibleSteps.length })}
                    </summary>
                    <div className="mt-3 space-y-2 max-h-64 overflow-y-auto pr-1">
                        {visibleSteps.map((step, index) => (
                            <div key={step.id} className={cn(
                                "flex flex-col gap-2 p-3 rounded border text-xs transition-all duration-200",
                                getStepColor(step.status),
                                index === visibleSteps.length - 1 && "ring-2 ring-blue-200 dark:ring-blue-800" // Highlight current step
                            )}>
                                <div className="flex items-start gap-2">
                                    <div className="mt-0.5">{getStepIcon(step.status)}</div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="font-medium truncate">{step.name}</span>
                                            <span className="text-muted-foreground/70 ml-2 whitespace-nowrap">
                                                {new Date(step.timestamp).toLocaleTimeString(i18n.language)}
                                            </span>
                                        </div>
                                        <div className="text-muted-foreground leading-relaxed">
                                            {step.message}
                                        </div>
                                        {/* Show task configuration in detailed view */}
                                        {step.name.includes('action_selection') && step.data && (
                                            <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-950 rounded border border-blue-200 dark:border-blue-800">
                                                <div className="text-xs font-medium text-blue-800 dark:text-blue-200 mb-1">
                                                    {step.data.taskType === 'action' ? '🎯' : '🧠'} 
                                                    {step.data.taskType === 'action' 
                                                        ? t('progress.actionsListLabel', {
                                                            actions: step.data.selectedActions?.map((a: any) => a.action).join(', ') || t('progress.none'),
                                                        })
                                                        : t('progress.llmAnalysisTask')
                                                    }
                                                </div>
                                                {step.data.description && (
                                                    <div className="text-xs text-blue-700 dark:text-blue-300">
                                                        {step.data.description}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                {step.error && (
                                    <div className="mt-2 p-2 bg-red-50 dark:bg-red-950 rounded border border-red-200 dark:border-red-800">
                                        <div className="text-red-600 dark:text-red-400 font-medium text-xs flex items-center gap-1">
                                            ⚠️ {t('progress.errorLabel')}: {step.error}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
}; 
