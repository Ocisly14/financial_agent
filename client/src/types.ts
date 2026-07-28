// Update the IAttachment interface
export interface IAttachment {
    url: string;
    contentType?: string; // Make contentType optional
    title?: string; // Make title optional to match Media type
    source?: string; // Add source property to identify the attachment type
    description?: string; // Optional description for the attachment
    text?: string; // Optional text content
    id?: string; // Optional unique identifier
}

// Token usage information interface (matching backend TokenUsage interface)
export interface TokenUsageInfo {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputCost?: number;
    outputCost?: number;  
    totalCost?: number;
    modelProvider?: string;
    modelName?: string;
    actualUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    };
}

// Add ProcessingStep interface for streaming progress
export interface ProcessingStep {
    id: string;
    name: string;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    message: string;
    timestamp: number;
    data?: any;
    error?: string;
    tokenUsage?: TokenUsageInfo;
}

export interface ResearchReport {
    fileName: string;
    downloadPath: string;
    downloadUrl?: string;
    lastModified?: string;
    cachedAt?: string;
    size?: number;
    s3Key?: string;
}

export interface TrendingCoinScore {
    symbol: string;
    weightedScore: number;
    dailyScores: number[];
    rank: number;
}

export interface TrendingSentiscoreResponse {
    success: boolean;
    news: TrendingCoinScore[];
    twitter: TrendingCoinScore[];
    lastUpdated: number;
}
