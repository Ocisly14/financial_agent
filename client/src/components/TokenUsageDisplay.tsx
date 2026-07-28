import type React from 'react';
import { cn } from '@/lib/utils';
import type { TokenUsageInfo } from '@/types';
import { useTranslation } from 'react-i18next';

interface TokenUsageDisplayProps {
    tokenUsage: TokenUsageInfo;
    isProcessing?: boolean;
    showDetailed?: boolean;
    showCost?: boolean;
    className?: string;
}

const formatTokenCount = (count: number, locale: string): string => {
    if (count < 1000) {
        return new Intl.NumberFormat(locale).format(count);
    }

    return new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(count);
};

const formatCost = (cost: number, locale: string): string => {
    const digits = cost === 0 ? 2 : cost < 0.01 ? 4 : cost < 1 ? 3 : 2;
    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    }).format(cost);
};

export const TokenUsageDisplay: React.FC<TokenUsageDisplayProps> = ({
    tokenUsage,
    isProcessing = false,
    showDetailed = false,
    showCost = false, // Changed default to false
    className
}) => {
    const { t, i18n } = useTranslation();
    const hasUsage = tokenUsage.totalTokens > 0;
    const hasCost = showCost && tokenUsage.totalCost !== undefined && tokenUsage.totalCost > 0;
    
    if (!hasUsage) {
        return null;
    }

    if (showDetailed) {
        return (
            <div className={cn("text-xs space-y-1", className)}>
                <div className="flex items-center gap-2">
                    <span className={cn(
                        "font-medium",
                        isProcessing ? "text-blue-600 dark:text-blue-400" : "text-green-600 dark:text-green-400"
                    )}>
                        ⚡ {t('usage.tokensTotal', { count: formatTokenCount(tokenUsage.totalTokens, i18n.language) })}
                    </span>
                    {hasCost && (
                        <span className="text-muted-foreground">
                            • {formatCost(tokenUsage.totalCost!, i18n.language)}
                        </span>
                    )}
                </div>
                
                {/* Model and cost breakdown */}
                <div className="text-xs text-muted-foreground/70 space-y-0.5">
                    {tokenUsage.modelName && (
                        <div>{tokenUsage.modelName}</div>
                    )}
                    {hasCost && tokenUsage.inputCost !== undefined && tokenUsage.outputCost !== undefined && (
                        <div className="flex gap-2">
                            <span>{t('usage.inputCost', { value: formatCost(tokenUsage.inputCost, i18n.language) })}</span>
                            <span>{t('usage.outputCost', { value: formatCost(tokenUsage.outputCost, i18n.language) })}</span>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className={cn(
            "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors",
            isProcessing 
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" 
                : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
            className
        )}>
            <span>⚡</span>
            <span>{formatTokenCount(tokenUsage.totalTokens, i18n.language)}</span>
            {hasCost && (
                <>
                    <span className="text-muted-foreground">•</span>
                    <span>{formatCost(tokenUsage.totalCost!, i18n.language)}</span>
                </>
            )}
        </div>
    );
};

export default TokenUsageDisplay;
