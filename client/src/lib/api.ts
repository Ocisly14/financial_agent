import type { StoredStrategy, ExecutionLogEntry } from "@/types/core";

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

// ── Agents/rooms ─────────────────────────────────────────────────────────────
// The app has one implicit agent. Room metadata and transcripts are persisted
// by the backend in the same local SQLite database.
export const DEFAULT_AGENT_ID = "default";

export const apiClient = {
    getAgents: (): Promise<{ agents: Array<{ id: string; name: string }> }> =>
        Promise.resolve({ agents: [{ id: DEFAULT_AGENT_ID, name: "Financial Agent" }] }),
    tts: (agentId: string, text: string) =>
        fetcher({
            url: `/${agentId}/tts`,
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
    whisper: async (agentId: string, audioBlob: Blob) => {
        const formData = new FormData();
        formData.append("file", audioBlob, "recording.wav");
        return fetcher({
            url: `/${agentId}/whisper`,
            method: "POST",
            body: formData,
        });
    },
    // Room management — backed by the server's local SQLite database.
    createRoom: (agentId: string, name?: string): Promise<{ success: boolean; room: { id: string; name: string; createdAt: number } }> =>
        fetcher({ url: `/api/agents/${encodeURIComponent(agentId)}/rooms`, method: "POST", body: { name } }),

    getRooms: (agentId: string): Promise<{ success: boolean; rooms: Array<{ id: string; name: string; createdAt: number; lastMessage: { text: string; createdAt: number } | null; messageCount: number }> }> => {
        return fetcher({ url: `/api/agents/${encodeURIComponent(agentId)}/rooms`, method: "GET" });
    },

    deleteRoom: (agentId: string, roomId: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}`,
            method: "DELETE",
        }),

    batchDeleteRooms: async (agentId: string, roomIds: string[]): Promise<{
        success: boolean;
        message: string;
        results: Array<{ roomId: string; success: boolean; error?: string }>;
    }> => {
        const results = await Promise.all(roomIds.map(async (roomId) => {
            try {
                await apiClient.deleteRoom(agentId, roomId);
                return { roomId, success: true };
            } catch (error) {
                return { roomId, success: false, error: error instanceof Error ? error.message : String(error) };
            }
        }));
        return {
            success: results.every((result) => result.success),
            message: results.every((result) => result.success) ? "deleted" : "some rooms could not be deleted",
            results,
        };
    },

    renameRoom: (agentId: string, roomId: string, name: string): Promise<{ success: boolean; message: string; room: { id: string; name: string } }> =>
        fetcher({
            url: `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}`,
            method: "PUT",
            body: { name },
        }),

    // Get historical messages for a room
    getMessages: (
        agentId: string,
        roomId: string,
        params?: { limit?: number; before?: string }
    ): Promise<{ agentId?: string; roomId?: string; memories?: any[]; messages?: any[]; hasMore?: boolean; oldestId?: string }> => {
        void agentId;
        const query = new URLSearchParams();
        if (params?.limit !== undefined) query.set("limit", String(params.limit));
        if (params?.before) query.set("before", params.before);
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        return fetcher({
            url: `/api/sessions/${encodeURIComponent(roomId)}/messages${suffix}`,
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
    agentId: string,
    response: string,
    artifacts: ChatArtifact[],
    visualizations: Record<string, unknown>[] = [],
    sources: Record<string, unknown>[] = [],
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
        userId: agentId,
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

    private hasActiveStreamForAgent(agentId: string): boolean {
        for (const key of this.activeStreams.keys()) {
            if (key.startsWith(agentId)) return true;
        }
        return false;
    }

    /**
     * Mark that the user intentionally stopped processing for this agent.
     * Only sticks if there is actually an in-flight stream to protect; this
     * prevents the flag from leaking into an unrelated future stream when the
     * user clicks Stop in an edge state (no active stream).
     */
    registerUserStopIntent(agentId: string): void {
        if (this.hasActiveStreamForAgent(agentId)) {
            this.userStoppedAgentIds.add(agentId);
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
    cancelStreamForAgent(agentId: string) {
        let aborted = false;
        for (const [key, controller] of this.activeStreams.entries()) {
            if (key.startsWith(agentId)) {
                controller.abort();
                this.activeStreams.delete(key);
                aborted = true;
            }
        }
        if (aborted) {
            this.userStoppedAgentIds.add(agentId);
        }
    }
    
    async sendMessageStream(
        agentId: string,
        message: string,
        roomId: string,
        onStep: (step: ProcessingStep) => void,
        onActionResponse: (response: any) => void,
        onIntermediateResponse: (response: any) => void,
        onFinalResponse: (responses: any[]) => void,
        onRoomUpdate: ((room: { id: string; name: string }) => void) | undefined,
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
    ) {
        // Create a unique key for request deduplication.
        const classificationKeySegment = messageClassification ?? "";
        const requestKey = `${agentId}-${roomId}-${message.substring(0, 50)}-${classificationKeySegment}`;
        
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
            this.userStoppedAgentIds.delete(agentId);
        }

        // Create new AbortController for this request
        const abortController = new AbortController();
        this.activeStreams.set(requestKey, abortController);
        
        // Clean up on completion
        const cleanup = () => {
            this.activeStreams.delete(requestKey);
        };
        
        // financial-agent's POST /api/chat takes a plain JSON { message, sessionId }.
        // The room id doubles as the session id (the backend reuses it and echoes
        // it back via X-Session-Id). File uploads are not supported by this backend.
        void selectedFiles; void messageClassification;
        void language;
        const body: string = JSON.stringify({ message, sessionId: roomId });
        const headers: HeadersInit = { "Content-Type": "application/json", "X-Agent-Id": agentId };

        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        // Set true once a `final` event arrives, so a clean stream close (the
        // backend ends the HTTP body after `final` WITHOUT a [DONE]/done event)
        // resolves as completion instead of a spurious STREAM_ENDED error.
        let finalReceived = false;

        const finishAsUserStopIfNeeded = (): boolean => {
            if (!this.userStoppedAgentIds.has(agentId)) {
                return false;
            }
            this.userStoppedAgentIds.delete(agentId);
            cleanup();
            onComplete?.();
            return true;
        };

        try {
            const response = await fetch(`${BASE_URL}/api/chat`, {
                method: 'POST',
                headers,
                body,
                // Use combined signal for both timeout and manual abort
                signal: AbortSignal.any([
                    AbortSignal.timeout(17 * 60 * 1000), // covers 15-minute trading approval waits
                    abortController.signal,
                ]),
            });

            if (!response.body) {
                throw new Error('No response body');
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // The backend mints/echoes the session id; keep the room in sync if
            // it differs from the room id we passed as sessionId.
            const headerSessionId = response.headers?.get?.('X-Session-Id');
            if (headerSessionId && headerSessionId !== roomId) {
                onRoomUpdate?.({ id: headerSessionId, name: '' });
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
                            data: { task_id: parsed.task_id, agent: parsed.agent, task: parsed.task },
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
                            userId: agentId,
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
                        this.userStoppedAgentIds.delete(agentId);
                        if (parsed.sessionId && parsed.sessionId !== roomId) {
                            onRoomUpdate?.({ id: parsed.sessionId, name: '' });
                        }
                        onFinalResponse([
                            buildAssistantResponse(
                                agentId,
                                parsed.response ?? '',
                                parsed.artifacts ?? [],
                                parsed.visualizations ?? [],
                                parsed.sources ?? [],
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
                                    threadId: roomId,
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
                    onError(
                        "Request timed out during analysis. The analysis may be too complex - please try a simpler request.",
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
                        agentId,
                        message,
                        roomId,
                        onStep,
                        onActionResponse,
                        onIntermediateResponse,
                        onFinalResponse,
                        onRoomUpdate,
                        onError,
                        onComplete,
                        onStreamingUpdate,
                        selectedFiles,
                        messageClassification,
                        language,
                        retryCount + 1,
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
