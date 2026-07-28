import type React from 'react';
import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ProcessingStep, TokenUsageInfo } from '@/types';

interface ThinkingBubbleInstance {
    id: string;
    steps: ProcessingStep[];
    isProcessing: boolean;
    timestamp: number;
    messageId?: string;
    topic?: string;
    isGeneratingTopic?: boolean;
    totalTokenUsage: TokenUsageInfo;
}

interface ThinkingBubbleContextType {
    bubbles: ThinkingBubbleInstance[];
    currentBubbleId: string | null;
    createNewBubble: (messageId?: string) => string;
    updateBubbleSteps: (bubbleId: string, steps: ProcessingStep[] | ((prev: ProcessingStep[]) => ProcessingStep[])) => void;
    setBubbleProcessing: (bubbleId: string, isProcessing: boolean) => void;
    setBubbleTopic: (bubbleId: string, topic: string) => void;
    setBubbleGeneratingTopic: (bubbleId: string, isGeneratingTopic: boolean) => void;
    finalizeBubble: (bubbleId: string) => void;
    clearBubble: (bubbleId: string) => void;
    clearBubbleContent: (bubbleId: string) => void;
    clearAllBubbles: () => void;
}

const ThinkingBubbleContext = createContext<ThinkingBubbleContextType | undefined>(undefined);

export const useThinkingBubble = () => {
    const context = useContext(ThinkingBubbleContext);
    if (!context) {
        throw new Error('useThinkingBubble must be used within a ThinkingBubbleProvider');
    }
    return context;
};

interface ThinkingBubbleProviderProps {
    children: ReactNode;
}

export const ThinkingBubbleProvider: React.FC<ThinkingBubbleProviderProps> = ({ children }) => {
    const [bubbles, setBubbles] = useState<ThinkingBubbleInstance[]>([]);
    const [currentBubbleId, setCurrentBubbleId] = useState<string | null>(null);

    const createNewBubble = (messageId?: string): string => {
        // Ensure we always create a truly unique bubble ID
        const timestamp = Date.now();
        const random = Math.random().toString(36).substr(2, 9);
        const newBubbleId = `bubble-${timestamp}-${random}-${messageId || 'msg'}`;
        
        const newBubble: ThinkingBubbleInstance = {
            id: newBubbleId,
            steps: [],
            isProcessing: true,
            timestamp,
            messageId,
            totalTokenUsage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                modelProvider: '',
                modelName: ''
            }
        };
        
        setBubbles(prev => [...prev, newBubble]);
        setCurrentBubbleId(newBubbleId);
        return newBubbleId;
    };

    // Helper function to accumulate token usage from steps
    const calculateTotalTokenUsage = (steps: ProcessingStep[]): TokenUsageInfo => {
        const totalUsage = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputCost: 0,
            outputCost: 0,
            totalCost: 0,
            modelProvider: '',
            modelName: ''
        };

        steps.forEach(step => {
            if (step.tokenUsage) {
                totalUsage.inputTokens += step.tokenUsage.inputTokens;
                totalUsage.outputTokens += step.tokenUsage.outputTokens;
                totalUsage.totalTokens += step.tokenUsage.totalTokens;
                
                // Add cost calculations if available
                if (step.tokenUsage.inputCost !== undefined) {
                    totalUsage.inputCost += step.tokenUsage.inputCost;
                }
                if (step.tokenUsage.outputCost !== undefined) {
                    totalUsage.outputCost += step.tokenUsage.outputCost;
                }
                if (step.tokenUsage.totalCost !== undefined) {
                    totalUsage.totalCost += step.tokenUsage.totalCost;
                }
                
                // Use the most recent model name from step data
                if (step.data?.modelName) {
                    totalUsage.modelName = step.data.modelName;
                }
                if (step.tokenUsage.modelProvider) {
                    totalUsage.modelProvider = step.tokenUsage.modelProvider;
                }
            }
        });

        return totalUsage;
    };

    const updateBubbleSteps = (bubbleId: string, steps: ProcessingStep[] | ((prev: ProcessingStep[]) => ProcessingStep[])) => {
        setBubbles(prev => prev.map(bubble => {
            if (bubble.id === bubbleId) {
                const newSteps = typeof steps === 'function' ? steps(bubble.steps) : steps;
                const totalTokenUsage = calculateTotalTokenUsage(newSteps);
                return { ...bubble, steps: newSteps, totalTokenUsage };
            }
            return bubble;
        }));
    };

    const setBubbleProcessing = (bubbleId: string, isProcessing: boolean) => {
        setBubbles(prev => prev.map(bubble => {
            if (bubble.id === bubbleId) {
                return { ...bubble, isProcessing };
            }
            return bubble;
        }));
    };

    const setBubbleTopic = (bubbleId: string, topic: string) => {
        setBubbles(prev => prev.map(bubble => {
            if (bubble.id === bubbleId) {
                return { ...bubble, topic, isGeneratingTopic: false };
            }
            return bubble;
        }));
    };

    const setBubbleGeneratingTopic = (bubbleId: string, isGeneratingTopic: boolean) => {
        setBubbles(prev => prev.map(bubble => {
            if (bubble.id === bubbleId) {
                return { ...bubble, isGeneratingTopic };
            }
            return bubble;
        }));
    };

    const finalizeBubble = (bubbleId: string) => {
        setBubbles(prev => prev.map(bubble => {
            if (bubble.id === bubbleId) {
                return { ...bubble, isProcessing: false };
            }
            return bubble;
        }));
        // Clear current bubble ID to ensure next message creates a new bubble
        if (currentBubbleId === bubbleId) {
            setCurrentBubbleId(null);
        }
    };

    const clearBubble = (bubbleId: string) => {
        setBubbles(prev => prev.filter(bubble => bubble.id !== bubbleId));
        if (currentBubbleId === bubbleId) {
            setCurrentBubbleId(null);
        }
    };

    const clearBubbleContent = (bubbleId: string) => {
        setBubbles(prev => prev.map(bubble => {
            if (bubble.id === bubbleId) {
                return { ...bubble, steps: [], isProcessing: false };
            }
            return bubble;
        }));
    };

    const clearAllBubbles = () => {
        setBubbles([]);
        setCurrentBubbleId(null);
    };

    const value = {
        bubbles,
        currentBubbleId,
        createNewBubble,
        updateBubbleSteps,
        setBubbleProcessing,
        setBubbleTopic,
        setBubbleGeneratingTopic,
        finalizeBubble,
        clearBubble,
        clearBubbleContent,
        clearAllBubbles,
    };

    return (
        <ThinkingBubbleContext.Provider value={value}>
            {children}
        </ThinkingBubbleContext.Provider>
    );
}; 