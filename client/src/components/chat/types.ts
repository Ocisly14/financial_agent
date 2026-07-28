import type { Content } from "@/types/core";

export interface ExtraContentFields {
    user: string;
    userId?: string;
    createdAt: number;
    isLoading?: boolean;
    /**
     * Marks a synthetic ghost bubble that mirrors live `token` SSE events
     * during a long-running action's LLM calls. Cleared the moment a real
     * `intermediate_response` / `final_response` arrives.
     */
    isStreaming?: boolean;
    conversationId?: string;
}

export type ContentWithUser = Content & ExtraContentFields & {
    error?: {
        type: string;
        message: string;
        originalError?: string;
        stack?: string | null;
        [key: string]: unknown;
    };
};

export interface ConversationPair {
    userMessage: ContentWithUser;
    responses: ContentWithUser[];
    conversationId: string;
}
