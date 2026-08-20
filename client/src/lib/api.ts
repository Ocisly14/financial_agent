import type {
    StoredStrategy,
    ExecutionLogEntry,
    TopicCategory,
    TopicSummary,
    TopicChartPreference,
    ResearchSummary,
    ResearchMember,
    UserInputRequestView,
    UserInputSubmission,
} from "@/types/core";
import type { ModelContextView, ModelRevisionFrame, ModelView } from "@/types/financialModel";

export type ProcessingStep = {
    id: string;
    name: string;
    status: "pending" | "in_progress" | "completed" | "error";
    message: string;
    timestamp: number;
    data?: unknown;
    error?: string;
};

const BASE_URL =
    import.meta.env.VITE_SERVER_BASE_URL ||
    window.location.origin;
export const API_BASE_URL = BASE_URL;

// financial-agent has no auth backend — no Bearer tokens, no CSRF, no cookies.
const fetcher = async ({
    url,
    method,
    body,
    headers,
}: {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    body?: object | FormData;
    headers?: HeadersInit;
}) => {
    const requestHeaders: HeadersInit = headers
        ? headers
        : {
              Accept: "application/json",
              "Content-Type": "application/json",
          };

    const options: RequestInit = {
        method: method ?? "GET",
        headers: requestHeaders,
    };

    if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
        if (body instanceof FormData) {
            if (options.headers && typeof options.headers === "object") {
                // Create new headers object without Content-Type
                options.headers = Object.fromEntries(
                    Object.entries(
                        options.headers as Record<string, string>
                    ).filter(([key]) => key !== "Content-Type")
                );
            }
            options.body = body;
        } else {
            options.body = JSON.stringify(body);
        }
    }

    return fetch(`${BASE_URL}${url}`, options).then(async (resp) => {
        const contentType = resp.headers.get("Content-Type");
        if (contentType === "audio/mpeg") {
            return await resp.blob();
        }

        if (!resp.ok) {
            const errorText = await resp.text();

            let errorMessage = "An error occurred.";
            let errorReason: string | undefined;
            try {
                const errorObj = JSON.parse(errorText);
                errorMessage =
                    (typeof errorObj?.message === "string" && errorObj.message) ||
                    (typeof errorObj?.error === "string" && errorObj.error) ||
                    (typeof errorObj?.detail === "string" && errorObj.detail) ||
                    errorMessage;
                // Server-supplied scrubbed reason code (e.g. "11000",
                // "ECONNRESET"). Append to the message so the toast / console
                // shows it without per-call wiring, and attach as a typed
                // property for callers that want finer-grained handling.
                if (typeof errorObj?.reason === "string" && errorObj.reason) {
                    errorReason = errorObj.reason;
                    errorMessage = `${errorMessage} (code: ${errorReason})`;
                }
            } catch {
                errorMessage = errorText || errorMessage;
            }

            const error: Error & {
                status?: number;
                statusText?: string;
                reason?: string;
            } = new Error(errorMessage);
            error.status = resp.status;
            error.statusText = resp.statusText;
            if (errorReason) error.reason = errorReason;
            throw error;
        }

        return resp.json();
    });
};

// ── Agents/topics ─────────────────────────────────────────────────────────────
// The app has one implicit agent. Topic metadata and transcripts are persisted
// by the backend in the same local SQLite database.
/** The tenant this client speaks for — the owner key behind every topic, research and model,
 *  sent as the x-tenant-id header. Not an agent: the agents
 *  are the workers the server declares in its topology, served by getAgentRoster. */
export const DEFAULT_TENANT_ID = "default";

export const apiClient = {
    /** Whose workspace this is. Stubbed to a single tenant until accounts exist. */
    getTenants: (): Promise<{ tenants: Array<{ id: string; name: string }> }> =>
        Promise.resolve({ tenants: [{ id: DEFAULT_TENANT_ID, name: "Financial Agent" }] }),
    /** The agent roster, served from the server's own topology — the one place agents are declared. */
    getAgentRoster: (): Promise<{ agents: Array<{ name: string; description: string }> }> =>
        fetcher({ url: "/api/agent-roster", method: "GET" }),
    tts: (tenantId: string, text: string) =>
        fetcher({
            url: `/${tenantId}/tts`,
            method: "POST",
            body: {
                text,
            },
            headers: {
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
                "Transfer-Encoding": "chunked",
            },
        }),
    whisper: async (tenantId: string, audioBlob: Blob) => {
        const formData = new FormData();
        formData.append("file", audioBlob, "recording.wav");
        return fetcher({
            url: `/${tenantId}/whisper`,
            method: "POST",
            body: formData,
        });
    },
    // Topic management — backed by the server's local SQLite database.
    createTopic: (tenantId: string, name?: string): Promise<{ success: boolean; topic: TopicSummary }> =>
        fetcher({ url: `/api/tenants/${encodeURIComponent(tenantId)}/topics`, method: "POST", body: { name } }),

    getTopics: (tenantId: string): Promise<{ success: boolean; topics: TopicSummary[] }> =>
        fetcher({ url: `/api/tenants/${encodeURIComponent(tenantId)}/topics` }),

    /** `category: null` means "back to automatic" — it clears the user's lock
     *  and lets the next background digest classify the topic again. */
    updateTopic: (
        tenantId: string,
        topicId: string,
        patch: { name?: string; category?: TopicCategory | null },
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/topics/${encodeURIComponent(topicId)}`,
            method: "PUT",
            body: patch,
        }),

    deleteTopic: (tenantId: string, topicId: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/topics/${encodeURIComponent(topicId)}`,
            method: "DELETE",
        }),

    batchDeleteTopics: async (tenantId: string, topicIds: string[]) => {
        const results = await Promise.all(topicIds.map((topicId) => apiClient.deleteTopic(tenantId, topicId)));
        return {
            success: results.every((result) => result.success),
            message: results.every((result) => result.success) ? "deleted" : "some topics could not be deleted",
        };
    },

    getTopicCharts: (tenantId: string, topicId: string): Promise<{ success: boolean; charts: TopicChartPreference[] }> =>
        fetcher({ url: `/api/tenants/${encodeURIComponent(tenantId)}/topics/${encodeURIComponent(topicId)}/charts` }),

    setTopicCharts: (
        tenantId: string,
        topicId: string,
        charts: TopicChartPreference[],
    ): Promise<{ success: boolean; charts: TopicChartPreference[] }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/topics/${encodeURIComponent(topicId)}/charts`,
            method: "PUT",
            body: { charts },
        }),

    // Research management (spec §8) — a Research groups several Topics under
    // one controller agent. Its id doubles as its chat session id, same trick
    // as a Topic. See src/server/server.ts for the routes as actually built.
    getResearches: (tenantId: string): Promise<{ success: boolean; researches: ResearchSummary[] }> =>
        fetcher({ url: `/api/tenants/${encodeURIComponent(tenantId)}/researches` }),

    createResearch: (
        tenantId: string,
        body: { name?: string; topicIds: string[] },
    ): Promise<{ success: boolean; research: ResearchSummary; members: ResearchMember[] }> =>
        fetcher({ url: `/api/tenants/${encodeURIComponent(tenantId)}/researches`, method: "POST", body }),

    // Not in spec §8's route list, but the server implements it (GET
    // /api/tenants/:tenantId/researches/:id) and the client needs it to render
    // a single Research plus its member row without listing every Research.
    getResearch: (
        tenantId: string,
        researchId: string,
    ): Promise<{ success: boolean; research: ResearchSummary; members: ResearchMember[] }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/researches/${encodeURIComponent(researchId)}`,
        }),

    updateResearch: (
        tenantId: string,
        researchId: string,
        patch: { name: string },
    ): Promise<{ success: boolean; research: ResearchSummary }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/researches/${encodeURIComponent(researchId)}`,
            method: "PUT",
            body: patch,
        }),

    deleteResearch: (tenantId: string, researchId: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/researches/${encodeURIComponent(researchId)}`,
            method: "DELETE",
        }),

    // Also not in spec §8's route list but implemented server-side (GET
    // .../researches/:id/members) — lets the member row refresh independently
    // of the parent Research fetch.
    getResearchMembers: (
        tenantId: string,
        researchId: string,
    ): Promise<{ success: boolean; members: ResearchMember[] }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/researches/${encodeURIComponent(researchId)}/members`,
        }),

    // Whole-set replace — the client always sends the full membership list it
    // wants; the server preserves each surviving member's digest/seen marker.
    setResearchMembers: (
        tenantId: string,
        researchId: string,
        topicIds: string[],
    ): Promise<{ success: boolean; members: ResearchMember[] }> =>
        fetcher({
            url: `/api/tenants/${encodeURIComponent(tenantId)}/researches/${encodeURIComponent(researchId)}/members`,
            method: "PUT",
            body: { topicIds },
        }),

    // Get historical messages for a topic (topic.id === session id)
    getMessages: (
        tenantId: string,
        topicId: string,
        params?: { limit?: number; before?: string }
    ): Promise<{ tenantId?: string; memories?: any[]; messages?: any[]; hasMore?: boolean; oldestId?: string }> => {
        void tenantId;
        const query = new URLSearchParams();
        if (params?.limit !== undefined) query.set("limit", String(params.limit));
        if (params?.before) query.set("before", params.before);
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        return fetcher({
            url: `/api/sessions/${encodeURIComponent(topicId)}/messages${suffix}`,
            method: "GET",
        });
    },
    // §7.7 — list strategies.
    listStrategies: (): Promise<{
        success: boolean;
        strategies: StoredStrategy[];
    }> => fetcher({ url: `/user/strategies` }),

    // §7.7 — strategy detail (config + execution history).
    getStrategy: (
        id: string,
    ): Promise<{ success: boolean; strategy: StoredStrategy; executions: ExecutionLogEntry[] }> =>
        fetcher({ url: `/user/strategies/${id}` }),

    // §7.7 — approve/reject a pending_approval strategy.
    activateStrategy: (
        id: string,
        decision: "approve" | "reject",
        options?: { threadId?: string; approvalId?: string },
    ): Promise<{ success: boolean; status: string }> =>
        fetcher({
            url: `/user/strategies/${id}/activate`,
            method: "POST",
            body: { decision, threadId: options?.threadId, approvalId: options?.approvalId },
        }),

    setStrategyStatus: (
        id: string,
        op: "pause" | "resume" | "cancel",
    ): Promise<{ success: boolean; status: string }> =>
        fetcher({
            url: `/user/strategies/${id}/status`,
            method: "PUT",
            body: { op },
        }),

    getTopicModels: (tenantId: string, topicId: string) =>
        fetcher({ url: `/api/tenants/${tenantId}/topics/${topicId}/models` }) as Promise<{
            success: boolean; models: ModelView[];
        }>,

    getFinancialModel: (modelId: string) =>
        fetcher({ url: `/api/financial-models/${modelId}` }) as Promise<
            { success: boolean } & ModelContextView
        >,

};

/** True when the browser/proxy tore down a fetch in a way typical of user abort or HTTP/2 reset. */
function isLikelyStreamAbortError(err: unknown): boolean {
    if (err == null) return false;
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (!(err instanceof Error)) return false;
    const name = err.name;
    const msg = err.message.toLowerCase();
    if (name === "AbortError") return true;
    if (msg.includes("user aborted")) return true;
    if (msg.includes("network error")) return true;
    if (msg.includes("failed to fetch")) return true;
    if (msg.includes("load failed")) return true;
    if (msg.includes("http2") || msg.includes("err_http2")) return true;
    return false;
}

// File/URL artifact emitted by the financial-agent backend `final` event.
type ChatArtifact = { n: number; type: "file" | "url"; ref: string; label?: string };

/**
 * Translate a backend `final` event into the assistant-message object that
 * chat.tsx renders. File/URL artifact markers become their human label;
 * visualization data travels through its own structured side-channel.
 */
function buildAssistantResponse(
    tenantId: string,
    response: string,
    artifacts: ChatArtifact[],
    visualizations: Record<string, unknown>[] = [],
    sources: Record<string, unknown>[] = [],
    inputRequest?: UserInputRequestView,
) {
    const byN = new Map(artifacts.map((a) => [a.n, a]));
    const text = response
        .replace(/\{\{artifact:(\d+)\}\}/g, (_m, n) => {
            const a = byN.get(Number(n));
            return a?.label ?? "";
        })
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}`;
    return {
        id,
        userId: tenantId,
        user: "system",
        createdAt: Date.now(),
        text,
        source: "regular_message",
        content: {
            text,
            source: "regular_message",
            metadata: {
                artifacts,
                visualizations,
                sources,
                ...(inputRequest ? { inputRequest } : {}),
            },
        },
    };
}

export class StreamingApiClient {
    private activeStreams = new Map<string, AbortController>();
    /**
     * Agents for which Stop was clicked while a stream is live. The flag is
     * consumed by `finishAsUserStopIfNeeded` in the stream's catch/end paths
     * so browser/proxy teardown (HTTP/2 reset, AbortError, "network error",
     * etc.) is classified as an intentional stop instead of "Analysis Error".
     *
     * Contract:
     * - Set only when there is at least one active stream for the agent.
     * - Cleared on [DONE], on successful user-stop handling, and when a new
     *   stream starts for that agent (so stale intent never leaks into an
     *   unrelated future stream).
     */
    private userStoppedAgentIds = new Set<string>();

    private hasActiveStreamForAgent(tenantId: string): boolean {
        for (const key of this.activeStreams.keys()) {
            if (key.startsWith(tenantId)) return true;
        }
        return false;
    }

    /**
     * Mark that the user intentionally stopped processing for this agent.
     * Only sticks if there is actually an in-flight stream to protect; this
     * prevents the flag from leaking into an unrelated future stream when the
     * user clicks Stop in an edge state (no active stream).
     */
    registerUserStopIntent(tenantId: string): void {
        if (this.hasActiveStreamForAgent(tenantId)) {
            this.userStoppedAgentIds.add(tenantId);
        }
    }

    // Cancel all active streams
    cancelAllStreams() {
        for (const [key, controller] of this.activeStreams.entries()) {
            controller.abort();
            this.activeStreams.delete(key);
        }
    }

    // Cancel specific stream by agent ID
    cancelStreamForAgent(tenantId: string) {
        let aborted = false;
        for (const [key, controller] of this.activeStreams.entries()) {
            if (key.startsWith(tenantId)) {
                controller.abort();
                this.activeStreams.delete(key);
                aborted = true;
            }
        }
        if (aborted) {
            this.userStoppedAgentIds.add(tenantId);
        }
    }
    
    async sendMessageStream(
        tenantId: string,
        message: string,
        topicId: string,
        onStep: (step: ProcessingStep) => void,
        onActionResponse: (response: any) => void,
        onIntermediateResponse: (response: any) => void,
        onFinalResponse: (responses: any[]) => void,
        onTopicUpdate: ((topic: { id: string; name: string }) => void) | undefined,
        onError: (error: string | { code?: string; message?: string }) => void,
        onComplete?: () => void,
        /**
         * Live LLM-token mirror for long-running actions. Receives the
         * cumulative buffered text for a given streaming key (default
         * 'pending') each time a new `token` SSE event arrives. Use it to
         * paint a ghost bubble that grows as the model streams.
         */
        onStreamingUpdate?: (params: { key: string; text: string }) => void,
        selectedFiles?: File[],
        messageClassification?: "TASK_CHAIN_MESSAGE",
        language?: string,
        retryCount = 0,
        inputResponse?: UserInputSubmission,
        onModelRevision?: (frame: ModelRevisionFrame) => void,
        /** Model currently open in the workspace. It is advisory context for
         * the agent, never a client-side command to mutate it. */
        activeModelId?: string,
    ) {
        // Create a unique key for request deduplication.
        const classificationKeySegment = messageClassification ?? "";
        const requestKey = `${tenantId}-${topicId}-${message.substring(0, 50)}-${classificationKeySegment}`;
        
        // Cancel any existing request with the same key
        if (this.activeStreams.has(requestKey)) {
            this.activeStreams.get(requestKey)?.abort();
            this.activeStreams.delete(requestKey);
        }

        // A fresh user-initiated stream supersedes any prior "user stop" intent
        // for this agent. Without this, a stale flag (e.g. Stop clicked with no
        // active stream, or a prior stream that ended without consuming the
        // flag) could silently swallow a real error on the new stream.
        // Retry paths set retryCount > 0 — keep the flag in that case so a
        // user stop during retries still classifies correctly.
        if (retryCount === 0) {
            this.userStoppedAgentIds.delete(tenantId);
        }

        // Create new AbortController for this request
        const abortController = new AbortController();
        this.activeStreams.set(requestKey, abortController);

        // Idle timeout, not a wall-clock cap. A DCF build streams progress for
        // 20+ minutes; a fixed AbortSignal.timeout() killed exactly those runs
        // — the stream it aborted was healthy and the backend finished anyway.
        // What a timeout is FOR is a stream that went silent, so the timer
        // resets on every chunk received and only sustained silence aborts.
        // 17 minutes of silence covers the 15-minute trading approval wait,
        // during which the backend sends nothing.
        const IDLE_TIMEOUT_MS = 17 * 60 * 1000;
        const idleController = new AbortController();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const armIdleTimeout = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(
                () => idleController.abort(new DOMException("Stream idle timeout", "TimeoutError")),
                IDLE_TIMEOUT_MS,
            );
        };

        // Clean up on completion
        const cleanup = () => {
            clearTimeout(idleTimer);
            this.activeStreams.delete(requestKey);
        };
        
        // financial-agent's POST /api/chat takes a plain JSON { message, sessionId }.
        // The topic id doubles as the session id (the backend reuses it and echoes
        // it back via X-Session-Id). File uploads are not supported by this backend.
        void selectedFiles; void messageClassification;
        void language;
        const body: string = JSON.stringify({
            ...(inputResponse ? { inputResponse } : { message }),
            sessionId: topicId,
            ...(activeModelId ? { activeModelId } : {}),
        });
        const headers: HeadersInit = { "Content-Type": "application/json", "X-Tenant-Id": tenantId };

        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        // Set true once a `final` event arrives, so a clean stream close (the
        // backend ends the HTTP body after `final` WITHOUT a [DONE]/done event)
        // resolves as completion instead of a spurious STREAM_ENDED error.
        let finalReceived = false;

        const finishAsUserStopIfNeeded = (): boolean => {
            if (!this.userStoppedAgentIds.has(tenantId)) {
                return false;
            }
            this.userStoppedAgentIds.delete(tenantId);
            cleanup();
            onComplete?.();
            return true;
        };

        try {
            armIdleTimeout();
            const response = await fetch(`${BASE_URL}/api/chat`, {
                method: 'POST',
                headers,
                body,
                // Combined signal: sustained silence or manual abort — never
                // total elapsed time while frames are still arriving.
                signal: AbortSignal.any([
                    idleController.signal,
                    abortController.signal,
                ]),
            });

            if (!response.ok) {
                let message = `HTTP ${response.status}: ${response.statusText}`;
                try {
                    const payload = await response.json() as { error?: unknown; message?: unknown };
                    if (typeof payload.error === "string") message = payload.error;
                    else if (typeof payload.message === "string") message = payload.message;
                } catch {
                    // Keep the HTTP fallback when the response is not JSON.
                }
                throw new Error(message);
            }

            if (!response.body) {
                throw new Error('No response body');
            }

            // The backend mints/echoes the session id; keep the topic in sync if
            // it differs from the topic id we passed as sessionId.
            const headerSessionId = response.headers?.get?.('X-Session-Id');
            if (headerSessionId && headerSessionId !== topicId) {
                onTopicUpdate?.({ id: headerSessionId, name: '' });
            }

            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            // Cumulative streamed-token text for the in-flight assistant bubble.
            let pendingText = '';

            // Translate one financial-agent SSE event into the 2.0 callback
            // contract chat.tsx consumes. Returns true on a terminal event so
            // the reader loop can stop.
            const handleEvent = (parsed: any): boolean => {
                switch (parsed.type) {
                    case 'dispatch':
                        onStep({
                            id: parsed.task_id,
                            name: 'dispatch',
                            status: 'in_progress',
                            message: `${parsed.agent ?? ''}: ${parsed.task ?? ''}`.trim(),
                            timestamp: Date.now(),
                            data: { task_id: parsed.task_id, agent: parsed.agent, task: parsed.task, thread_id: parsed.thread_id, parent_task_id: parsed.parent_task_id },
                        });
                        break;
                    case 'progress':
                        onStep({
                            id: parsed.task_id,
                            name: parsed.phase ?? 'progress',
                            status: parsed.pct === 100 ? 'completed' : 'in_progress',
                            message: parsed.note ?? parsed.phase ?? '',
                            timestamp: Date.now(),
                            data: { pct: parsed.pct },
                        });
                        break;
                    case 'task_done':
                        onStep({
                            id: parsed.task_id,
                            name: 'task_done',
                            status: parsed.status === 'ok' ? 'completed' : 'error',
                            message: parsed.summary ?? '',
                            timestamp: Date.now(),
                        });
                        break;
                    case 'topic_dispatch':
                        // Research-layer frame (docs/superpowers/specs/2026-07-30-research-layer-design.md §4.5):
                        // the controller dispatching a sub-task to one of its member
                        // Topics. The driven Topic's own dispatch/tool_call frames are
                        // NOT forwarded — this is the only signal for that hop, so it
                        // rides the existing step list rather than a new callback.
                        onStep({
                            id: parsed.topicId,
                            name: 'topic_dispatch',
                            status:
                                parsed.status === 'ok'
                                    ? 'completed'
                                    : parsed.status === 'running'
                                        ? 'in_progress'
                                        : 'error',
                            message: `${parsed.topicName ?? ''}: ${parsed.task ?? ''}`.trim(),
                            timestamp: Date.now(),
                            data: {
                                topicId: parsed.topicId,
                                topicName: parsed.topicName,
                                task: parsed.task,
                                status: parsed.status,
                            },
                        });
                        break;
                    case 'model_revision':
                        // A committed model revision is not a unit of work — routing
                        // it through onStep would file "the agent committed rev 47"
                        // next to "the agent ran a scan" in the same progress list.
                        onModelRevision?.(parsed as ModelRevisionFrame);
                        break;
                    case 'topic_focus':
                        // Research-layer transient frame (spec §4.5 / §7.5): the
                        // controller moved the member focus. Nothing is written
                        // server-side, so there is nothing to undo and nothing to
                        // refetch — the Research view only replays a one-shot ring
                        // on that member's chip. It rides `onStep` like
                        // `topic_dispatch` rather than getting its own callback,
                        // and `useTopicStream` peels it off before the task
                        // aggregation so it never becomes a progress row.
                        onStep({
                            id: String(parsed.topicId ?? ''),
                            name: 'topic_focus',
                            status: 'completed',
                            message: '',
                            timestamp: Date.now(),
                            data: { topicId: parsed.topicId, symbol: parsed.symbol },
                        });
                        break;
                    case 'layout_changed':
                        // Research-layer persistent frame (spec §6): the controller
                        // wrote a tab or membership change. `previous`/`next` carry
                        // the full before/after state so a single-level undo can be
                        // offered; `source` is only ever on the frame (there is no
                        // `source` column), which is why the undo is session-live.
                        onStep({
                            id: `layout-${parsed.scope ?? ''}-${parsed.topicId ?? parsed.researchId ?? ''}`,
                            name: 'layout_changed',
                            status: 'completed',
                            message: '',
                            timestamp: Date.now(),
                            data: {
                                scope: parsed.scope,
                                researchId: parsed.researchId,
                                topicId: parsed.topicId,
                                source: parsed.source,
                                previous: parsed.previous,
                                next: parsed.next,
                            },
                        });
                        break;
                    case 'strategy_created':
                        onStep({
                            id: parsed.strategy_id,
                            name: 'strategy_created',
                            status: 'completed',
                            message: parsed.summary ?? 'Strategy draft created',
                            timestamp: Date.now(),
                            data: {
                                strategy_id: parsed.strategy_id,
                                status: parsed.status,
                                summary: parsed.summary,
                            },
                        });
                        break;
                    case 'step_reply': {
                        const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `step-${Date.now()}`;
                        onIntermediateResponse({
                            id,
                            userId: tenantId,
                            user: 'system',
                            createdAt: Date.now(),
                            text: parsed.content ?? '',
                            source: 'regular_message',
                            content: { text: parsed.content ?? '', source: 'regular_message' },
                        });
                        pendingText = '';
                        onStreamingUpdate?.({ key: 'pending', text: '' });
                        break;
                    }
                    case 'token':
                        pendingText += parsed.delta ?? '';
                        onStreamingUpdate?.({ key: 'pending', text: pendingText });
                        break;
                    case 'final':
                        finalReceived = true;
                        this.userStoppedAgentIds.delete(tenantId);
                        if (parsed.sessionId && parsed.sessionId !== topicId) {
                            onTopicUpdate?.({ id: parsed.sessionId, name: '' });
                        }
                        onFinalResponse([
                            buildAssistantResponse(
                                tenantId,
                                parsed.response ?? '',
                                parsed.artifacts ?? [],
                                parsed.visualizations ?? [],
                                parsed.sources ?? [],
                                parsed.input_request,
                            ),
                        ]);
                        break;
                    case 'approval_required': {
                        const { approval_id, payload = {} } = parsed as {
                            approval_id: string;
                            payload: Record<string, unknown>;
                        };
                        if (payload.kind === 'strategy_activation' || payload.actionName === 'activate_strategy') {
                            onStep({
                                id: approval_id,
                                name: 'strategy_approval_required',
                                status: 'in_progress',
                                message: 'Strategy activation approval required',
                                timestamp: Date.now(),
                                data: {
                                    type: 'strategy_activation',
                                    threadId: topicId,
                                    approvalId: approval_id,
                                    ...payload,
                                },
                            });
                            break;
                        }
                        onError('Unsupported approval request received.');
                        break;
                    }
                    case 'error':
                        onError(typeof parsed.message === 'string' ? parsed.message : 'Unknown error');
                        break;
                    case 'done':
                        cleanup();
                        onComplete?.();
                        return true;
                }
                return false;
            };

            const processLine = (line: string): boolean => {
                if (!line.startsWith('data: ')) return false;
                const data = line.slice(6).trim();
                if (!data) return false;
                try {
                    return handleEvent(JSON.parse(data));
                } catch (e) {
                    if (data.length > 50_000) {
                        console.warn('[StreamingApiClient] SSE JSON parse failed for large payload', e);
                    }
                    return false;
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // Bytes arrived — the stream is alive, push the deadline out.
                armIdleTimeout();
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (processLine(line)) return;
                }
            }
            if (buffer.trim()) {
                for (const line of buffer.split('\n')) {
                    if (processLine(line)) return;
                }
            }

            // The backend ends the HTTP body after `final` WITHOUT a done/[DONE]
            // event. Treat a clean close after `final` as success — otherwise
            // every successful chat would surface a spurious STREAM_ENDED error.
            if (finalReceived) {
                cleanup();
                onComplete?.();
                return;
            }
            // Reader finished without a final (proxy reset, user stop, crash).
            if (finishAsUserStopIfNeeded()) {
                return;
            }
            onError({
                code: 'STREAM_ENDED',
                message: 'Connection closed before response completed. Please try again.',
            });
        } catch (streamError: unknown) {
            // 1. User-stop short-circuit: if the user clicked Stop, any
            //    teardown (AbortError, HTTP/2 reset, "network error",
            //    "Load failed", etc.) is intentional. Finish as complete,
            //    skip the error toast, skip retries.
            if (finishAsUserStopIfNeeded()) {
                return;
            }

            // 2. Abort / timeout classification. An AbortError with
            //    abortController.signal.aborted=true means a same-request-key
            //    dedup replaced this stream (not a user stop, because user
            //    stop is handled in step 1); report it as stopped to let the
            //    caller no-op cleanly. Combined-signal timeouts show up as
            //    AbortError with signal.aborted=false and as TimeoutError.
            if (
                streamError instanceof DOMException ||
                streamError instanceof Error
            ) {
                const name = streamError.name;
                if (name === "AbortError") {
                    if (abortController.signal.aborted) {
                        onError("Processing was stopped as requested");
                    } else {
                        onError(
                            "Request timed out during analysis. The analysis may be too complex - please try a simpler request.",
                        );
                    }
                    return;
                }
                if (name === "TimeoutError") {
                    // Only sustained silence trips this (see armIdleTimeout) —
                    // an actively streaming run can no longer time out here.
                    onError(
                        "No data received from the server for a long time, so the connection was closed. The backend may still be working — check back shortly or try again.",
                    );
                    return;
                }
            }

            // 3. Retry transient network errors BEFORE the generic soft-error
            //    classifier below — otherwise "Load failed" / HTTP/2 reset
            //    would be shown to the user immediately instead of being
            //    retried with exponential backoff.
            const isRetryableError =
                streamError instanceof TypeError && streamError.message.includes('Load failed');

            if (isRetryableError && retryCount < 3) {
                const delay = Math.pow(2, retryCount) * 1000;

                onStep({
                    id: 'retry_connection',
                    name: 'Connection Retry',
                    status: 'in_progress',
                    message: `Connection lost, retrying (${retryCount + 1}/3)...`,
                    timestamp: Date.now(),
                });

                setTimeout(() => {
                    this.sendMessageStream(
                        tenantId,
                        message,
                        topicId,
                        onStep,
                        onActionResponse,
                        onIntermediateResponse,
                        onFinalResponse,
                        onTopicUpdate,
                        onError,
                        onComplete,
                        onStreamingUpdate,
                        selectedFiles,
                        messageClassification,
                        language,
                        retryCount + 1,
                        inputResponse,
                        onModelRevision,
                        activeModelId,
                    );
                }, delay);
                return;
            }

            // 4. Soft "streaming error" surface for browser/proxy teardown
            //    (HTTP/2 reset, generic "network error") that was NOT a user
            //    stop and NOT a retryable "Load failed" TypeError. Chat-level
            //    handler shows a non-destructive toast so the user sees a
            //    clear signal but is not shown a full "Analysis Error".
            if (isLikelyStreamAbortError(streamError)) {
                onError(`Streaming error: ${streamError instanceof Error ? streamError.message : 'network error'}`);
                return;
            }

            if (streamError instanceof TypeError && streamError.message.includes('Load failed')) {
                onError(
                    `Network connection lost during analysis after ${retryCount} retries. Please check your connection and try again.`,
                );
            } else {
                const errorMessage = streamError instanceof Error ? streamError.message : 'Unknown error';
                onError(`Streaming error: ${errorMessage}`);
            }
        } finally {
            cleanup();
            try {
                reader?.releaseLock();
            } catch {
                /* reader may already be released */
            }
        }
    }
}
