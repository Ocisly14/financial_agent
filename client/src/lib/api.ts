import type { UUID, Character, StoredStrategy, ExecutionLogEntry } from "@/types/core";
import type { ProcessingStep, ResearchReport } from "../types";

export type FavoriteTaskChainPayload = {
    favoriteId?: string;
    id?: string;
    name?: string;
    originalName?: string;
    description?: string;
    taskChain?: unknown;
    createdAt?: number;
    lastUsedAt?: number;
    [key: string]: unknown;
};

const BASE_URL =
    import.meta.env.VITE_SERVER_BASE_URL ||
    window.location.origin;
export const API_BASE_URL = BASE_URL;
const LOCAL_ANALYTICS_BASE_URL =
    import.meta.env.VITE_ANALYTICS_BASE_URL ||
    BASE_URL;
export const ANALYTICS_API_BASE_URL = LOCAL_ANALYTICS_BASE_URL;

// financial-agent has no auth backend — no Bearer tokens, no CSRF, no cookies.
const fetcher = async ({
    url,
    method,
    body,
    headers,
    baseUrl,
}: {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    body?: object | FormData;
    headers?: HeadersInit;
    baseUrl?: string;
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

    const requestBaseUrl = baseUrl || BASE_URL;
    return fetch(`${requestBaseUrl}${url}`, options).then(async (resp) => {
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

// ── Local agents/rooms (no backend agents/rooms API) ─────────────────────────
// financial-agent has a single implicit agent and no rooms endpoint. We model a
// "room" as a chat session whose id we pass as `sessionId` to POST /api/chat,
// persisted in localStorage so the sidebar + room list work offline.
export const DEFAULT_AGENT_ID = "default";

type LocalRoom = { id: string; name: string; createdAt: number };

const roomsStorageKey = (agentId: string) => `financial-agent:rooms:${agentId}`;

const readLocalRooms = (agentId: string): LocalRoom[] => {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(roomsStorageKey(agentId));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const writeLocalRooms = (agentId: string, rooms: LocalRoom[]) => {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(roomsStorageKey(agentId), JSON.stringify(rooms));
    } catch {
        /* localStorage unavailable — rooms just won't persist */
    }
};

const newRoomName = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `Chat ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const apiClient = {
    getAgents: (): Promise<{ agents: Array<{ id: string; name: string }> }> =>
        Promise.resolve({ agents: [{ id: DEFAULT_AGENT_ID, name: "Financial Agent" }] }),
    getAgent: (agentId: string): Promise<{ id: UUID; character: Character }> =>
        fetcher({ url: `/agents/${agentId}` }),
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
    getChartUrl: (chartPath: string) => {
        if (!chartPath) return '';
        if (chartPath.startsWith('http')) return chartPath;
        // financial-agent serves charts at /charts/:filename (basename only).
        // artifact.ref is a full local path — take just the basename.
        const filename = chartPath.replace(/\\/g, '/').split('/').pop() ?? chartPath;
        const origin =
            typeof window !== "undefined" && typeof window.location?.origin === "string"
                ? window.location.origin
                : BASE_URL;
        return `${origin}/charts/${encodeURIComponent(filename)}`;
    },
    getReportUrl: (reportPath: string) => {
        // Remove leading slash and convert to server URL
        let relativePath = reportPath.replace(/^\/+/, '');
        // Replace backslashes with forward slashes for web URLs
        relativePath = relativePath.replace(/\\/g, '/');

        // Remove 'saved_data/' prefix since /reports serves saved_data/ directory
        if (relativePath.startsWith('saved_data/')) {
            relativePath = relativePath.substring('saved_data/'.length);
        }

        const origin =
            typeof window !== "undefined" && typeof window.location?.origin === "string"
                ? window.location.origin
                : BASE_URL;
        return `${origin}/reports/${relativePath}`;
    },
    getWeeklyReports: async (): Promise<{ success: boolean; reports: ResearchReport[] }> => {
        const response = (await fetcher({
            url: "/research-reports",
        })) as { success: boolean; reports?: ResearchReport[] };

        const reports = (response.reports ?? []).map((report) => {
            const normalizedPath = report.downloadPath?.startsWith("/")
                ? report.downloadPath
                : `/${report.downloadPath ?? ""}`;

            return {
                ...report,
                downloadUrl: report.downloadUrl || `${BASE_URL}${normalizedPath}`,
            };
        });

        return { success: response.success, reports };
    },
		    getCoinMarketCapPrice: (symbol: string, convert = "USD") => {
		        const qs = new URLSearchParams({ symbol, convert });
		        return fetcher({
		            url: `/market/coinmarketcap/price?${qs.toString()}`,
		            method: "GET",
		        });
		    },
		    deleteFile: (filePath: string, agentId?: string, roomId?: string): Promise<{ success: boolean; message: string }> =>
		        fetcher({
		            url: "/files",
		            method: "DELETE",
            body: { filePath, agentId, roomId },
        }),
    stopProcessing: (agentId: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: `/agents/${agentId}/stop`,
            method: "POST",
            body: {},
        }),
    getAnalyticsSummary: (): Promise<{
        success: boolean;
        generatedAt: number;
        dailyLabels: string[];
        totals: {
            usage: { activeUsers: number; messageCount: number };
            usageSegments: {
                anonymous: { activeUsers: number; messageCount: number };
                free: { activeUsers: number; messageCount: number };
                plus: { activeUsers: number; messageCount: number };
                pro: { activeUsers: number; messageCount: number };
            };
            main: { sessions: number; visitors: number; avgDurationMs: number };
            signup: { sessions: number; visitors: number; avgDurationMs: number };
            register: { sessions: number; visitors: number; avgDurationMs: number };
            mainAnonymousVisitors: { visitors: number };
            registerAnonymousVisitors: { visitors: number };
            registrations: { registrations: number };
            signupLinkSends: { linkSends: number };
            mainAuth: {
                loggedInVisitors: number;
                loggedInAvgDurationMs: number;
                anonymousVisitors: number;
                anonymousAvgDurationMs: number;
            };
        };
        usage: Array<{ day: string; activeUsers: number; messageCount: number }>;
        usageSegments: {
            anonymous: Array<{ day: string; activeUsers: number; messageCount: number }>;
            free: Array<{ day: string; activeUsers: number; messageCount: number }>;
            plus: Array<{ day: string; activeUsers: number; messageCount: number }>;
            pro: Array<{ day: string; activeUsers: number; messageCount: number }>;
        };
        main: Array<{ day: string; sessions: number; visitors: number; avgDurationMs: number }>;
        signup: Array<{ day: string; sessions: number; visitors: number; avgDurationMs: number }>;
        register: Array<{ day: string; sessions: number; visitors: number; avgDurationMs: number }>;
        mainAnonymousVisitors: Array<{ day: string; visitors: number }>;
        registerAnonymousVisitors: Array<{ day: string; visitors: number }>;
        loggedInVisitors: Array<{ day: string; visitors: number }>;
        registrations: Array<{ day: string; registrations: number }>;
        signupLinkSends: Array<{ day: string; linkSends: number }>;
        mainAuth: Array<{
            day: string;
            loggedInVisitors: number;
            loggedInAvgDurationMs: number;
            anonymousVisitors: number;
            anonymousAvgDurationMs: number;
        }>;
        hourlyMain: Array<{ hour: string; sessions: number; visitors: number; avgDurationMs: number }>;
    }> =>
        fetcher({
            url: "/analytics/summary",
            baseUrl: ANALYTICS_API_BASE_URL,
        }),
    sendPageSession: (payload: {
        path: string;
        referrer?: string | null;
        durationMs: number;
        clickCount: number;
        startedAt: number;
        isAuthenticated?: boolean;
        userId?: string | null;
        userEmail?: string | null;
        userName?: string | null;
    }): Promise<{ success: boolean }> =>
        fetcher({
            url: "/analytics/page-session",
            method: "POST",
            body: payload,
            baseUrl: ANALYTICS_API_BASE_URL,
        }),
    getReferralCodesToday: (): Promise<{
        success: boolean;
        generatedAt: number;
        date: string;
        summary: {
            totalCodes: number;
            totalPending: number;
            totalCompleted: number;
        };
        data: Array<{
            referralCode: string;
            pendingCount: number;
            completedCount: number;
        }>;
    }> =>
        fetcher({
            url: "/analytics/referral-codes-today",
            baseUrl: ANALYTICS_API_BASE_URL,
        }),
    getReferralCodesLast30Days: (): Promise<{
        success: boolean;
        generatedAt: number;
        range: {
            from: string;
            to: string;
        };
        summary: {
            totalCodes: number;
            totalPending: number;
            totalCompleted: number;
        };
        data: Array<{
            referralCode: string;
            pendingCount: number;
            completedCount: number;
        }>;
    }> =>
        fetcher({
            url: "/analytics/referral-codes-last-30-days",
            baseUrl: ANALYTICS_API_BASE_URL,
        }),

    // Room management — localStorage-backed (no backend rooms API).
    createRoom: (agentId: string, name?: string): Promise<{ success: boolean; room: { id: string; name: string; createdAt: number } }> => {
        const room: LocalRoom = {
            id: (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `room-${Date.now()}`),
            name: name && name.trim() ? name.trim() : newRoomName(),
            createdAt: Date.now(),
        };
        const rooms = readLocalRooms(agentId);
        rooms.unshift(room);
        writeLocalRooms(agentId, rooms);
        return Promise.resolve({ success: true, room });
    },

    getRooms: (agentId: string): Promise<{ success: boolean; rooms: Array<{ id: string; name: string; createdAt: number; lastMessage: { text: string; createdAt: number } | null; messageCount: number }> }> => {
        const rooms = readLocalRooms(agentId)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((r) => ({ ...r, lastMessage: null, messageCount: 0 }));
        return Promise.resolve({ success: true, rooms });
    },

    deleteRoom: (agentId: string, roomId: string): Promise<{ success: boolean; message: string }> => {
        writeLocalRooms(agentId, readLocalRooms(agentId).filter((r) => r.id !== roomId));
        return Promise.resolve({ success: true, message: "deleted" });
    },

    batchDeleteRooms: (agentId: string, roomIds: string[]): Promise<{
        success: boolean;
        message: string;
        results: Array<{ roomId: string; success: boolean; error?: string }>;
    }> => {
        const toRemove = new Set(roomIds);
        writeLocalRooms(agentId, readLocalRooms(agentId).filter((r) => !toRemove.has(r.id)));
        return Promise.resolve({
            success: true,
            message: "deleted",
            results: roomIds.map((roomId) => ({ roomId, success: true })),
        });
    },

    renameRoom: (agentId: string, roomId: string, name: string): Promise<{ success: boolean; message: string; room: { id: string; name: string } }> => {
        const rooms = readLocalRooms(agentId).map((r) => (r.id === roomId ? { ...r, name } : r));
        writeLocalRooms(agentId, rooms);
        return Promise.resolve({ success: true, message: "renamed", room: { id: roomId, name } });
    },

    getFavoriteTaskChains: (agentId: string): Promise<{ success: boolean; favorites: any[] }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains`,
            method: "GET",
        }),

    addFavoriteTaskChain: (
        agentId: string,
        payload: {
            chainId: string;
            name: string;
            originalName?: string;
            description?: string;
            taskChain: unknown;
            isPublic?: boolean;
        }
    ): Promise<{ success: boolean; favorite: any }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains`,
            method: "POST",
            body: payload,
        }),

    updateFavoriteTaskChainVisibility: (
        agentId: string,
        favoriteId: string,
        isPublic: boolean
    ): Promise<{ success: boolean; favorite: any }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}/visibility`,
            method: "PATCH",
            body: { isPublic },
        }),

    deleteFavoriteTaskChain: (
        agentId: string,
        favoriteId: string
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}`,
            method: "DELETE",
        }),

    updateFavoriteTaskChainName: (
        agentId: string,
        favoriteId: string,
        name: string
    ): Promise<{ success: boolean; favoriteId: string; name: string }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}`,
            method: "PATCH",
            body: { name },
        }),

    markFavoriteTaskChainUsed: (
        agentId: string,
        favoriteId: string,
        timestamp?: number
    ): Promise<{ success: boolean; favoriteId: string; lastUsedAt: number }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}/use`,
            method: "POST",
            body: { timestamp },
        }),

    shareFavoriteTaskChain: (
        agentId: string,
        favoriteId: string,
    ): Promise<{ success: boolean; share: any }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}/share`,
            method: "POST",
        }),

    getSharedTaskChainByCode: (
        shareCode: string
    ): Promise<{ success: boolean; share: any }> =>
        fetcher({
            url: `/shared-taskchains/${shareCode}`,
            method: "GET",
        }),

    createSharedChat: (
        agentId: string,
        roomId: string,
    ): Promise<{ success: boolean; share: { shareCode: string } }> =>
        fetcher({
            url: `/agents/${agentId}/rooms/${roomId}/shared-chat`,
            method: "POST",
        }),

    getShareSummary: (
        agentId: string,
        roomId: string,
    ): Promise<{ success: boolean; title?: string; summary: string }> =>
        fetcher({
            url: `/agents/${agentId}/rooms/${roomId}/share-summary`,
            method: "POST",
        }),

    getSharedChatByCode: (
        shareCode: string
    ): Promise<{
        success: boolean;
        share: { shareCode: string; agentId: string; roomId: string; createdAt: number };
        memories: Array<{
            id: string;
            userId: string;
            agentId: string;
            createdAt: number;
            content: {
                text: string;
                action?: unknown;
                source?: unknown;
                url?: unknown;
                inReplyTo?: unknown;
                metadata?: unknown;
                actionData?: unknown;
                actionResults?: unknown;
                attachments?: Array<{
                    id?: string;
                    url: string;
                    title?: string;
                    source?: string;
                    description?: string;
                    text?: string;
                    contentType?: string;
                }>;
            };
            roomId: string;
        }>;
    }> =>
        fetcher({
            url: `/shared-chats/${shareCode}`,
            method: "GET",
        }),

    getSharedRoom: (
        agentId: string,
        roomId: string
    ): Promise<{
        success: boolean;
        agentId: string;
        roomId: string;
        room?: { id: string; name?: string; createdAt?: string | number | null } | null;
        shareAgentId?: string;
        memories: Array<{
            id: string;
            userId: string;
            agentId: string;
            createdAt: number;
            content: {
                text: string;
                action?: unknown;
                source?: unknown;
                url?: unknown;
                inReplyTo?: unknown;
                metadata?: unknown;
                actionData?: unknown;
                actionResults?: unknown;
                attachments?: Array<{
                    id?: string;
                    url: string;
                    title?: string;
                    source?: string;
                    description?: string;
                    text?: string;
                    contentType?: string;
                }>;
            };
            roomId: string;
        }>;
    }> =>
        fetcher({
            url: `/shared-rooms/${agentId}/${roomId}`,
            method: "GET",
        }),

    // Authentication endpoints
    login: (email: string, password: string): Promise<{ user?: any; message?: string }> =>
        fetcher({
            url: "/authentication/validation/",
            method: "POST",
            body: { email, password },
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    sendSignUpToken: (email: string): Promise<{ message: string }> =>
        fetcher({
            url: "/authentication/enrollment/token/",
            method: "POST",
            body: { email },
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    createAccount: (regToken: string, formData: object): Promise<{ message: string }> =>
        fetcher({
            url: `/authentication/creation/${regToken}/`,
            method: "POST",
            body: formData,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    validateToken: (regToken: string): Promise<any> =>
        fetcher({
            url: `/authentication/creation/${regToken}/`,
            method: "GET",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    logout: (): Promise<{ message: string }> =>
        fetcher({
            url: "/authentication/logout/",
            method: "POST",
            body: {},
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    refreshToken: (): Promise<{ user?: any }> =>
        fetcher({
            url: "/authentication/refresh/",
            method: "POST",
            body: {},
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    getMe: (): Promise<{ user: any }> =>
        fetcher({
            url: "/authentication/me/",
            method: "GET",
            headers: {
                Accept: "application/json",
                credentials: "include",
            },
        }),
    getReferralCode: (): Promise<{ referralCode: string; referralLink: string; totalInvites: number }> =>
        fetcher({
            url: "/authentication/referral-code/",
            method: "GET",
            headers: {
                Accept: "application/json",
                credentials: "include",
            },
        }),

    // Get historical messages for a room
    getMessages: (
        agentId: string,
        roomId: string,
        _params?: { limit?: number; before?: string }
    ): Promise<{ agentId?: string; roomId?: string; memories?: any[]; messages?: any[]; hasMore?: boolean; oldestId?: string }> => {
        // No backend history store — chat transcript lives only in the live
        // session. Return an empty transcript so loadMessageHistory is a no-op.
        return Promise.resolve({ agentId, roomId, messages: [], memories: [], hasMore: false });
    },
    getSubscriptionStatus: (email?: string): Promise<{
        success: boolean;
        email: string;
        planName: "Plus" | "Pro" | "Enterprise" | null;
        // Canonical tier field for all user classification logic.
        resolvedTier: "free" | "plus" | "pro" | "enterprise";
        primarySubscriptionId: string | null;
        primarySubscriptionNickname: string | null;
        primarySubscription: {
            id: string;
            status: string;
            cancelAtPeriodEnd: boolean;
            currentPeriodStart: number | null;
            currentPeriodEnd: number | null;
            items: Array<{
                id: string;
                priceId: string | null;
                productId: string | null;
                nickname: string | null;
                currency: string | null;
                unitAmount: number | null;
                interval: string | null;
                intervalCount: number | null;
            }>;
            latestInvoiceId: string | null;
        } | null;
        customers: Array<{
            customerId: string;
            customerEmail: string | null;
            subscriptions: Array<{
                id: string;
                status: string;
                cancelAtPeriodEnd: boolean;
                currentPeriodStart: number | null;
                currentPeriodEnd: number | null;
                items: Array<{
                    id: string;
                    priceId: string | null;
                    productId: string | null;
                    nickname: string | null;
                    currency: string | null;
                    unitAmount: number | null;
                    interval: string | null;
                    intervalCount: number | null;
                }>;
                latestInvoiceId: string | null;
            }>;
        }>;
    }> =>
        fetcher({
            url:
                email && email.trim().length > 0
                    ? `/billing/subscription?email=${encodeURIComponent(email.trim())}`
                    : "/billing/subscription",
            method: "GET",
        }),
    clearAnonymousHistory: (options?: { force?: boolean }): Promise<{ success: boolean; cleaned: boolean }> =>
        fetcher({
            url: "/anonymous/cleanup",
            method: "POST",
            body: options ?? {},
        }),
    submitFeedback: (feedback: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: "/feedback",
            method: "POST",
            body: { feedback },
        }),
    submitChainApproval: (
        agentId: string,
        threadId: string,
        decision: 'approved' | 'rejected',
        taskChain: unknown,
        feedback?: string
    ): Promise<{ success: boolean; message: string; chainId: string; chainName: string }> =>
        fetcher({
            url: `/agents/${agentId}/task-chain/approval`,
            method: "POST",
            body: { threadId, decision, feedback, taskChain },
        }),
    getQuotaStatus: (agentId: string): Promise<{
        success: boolean;
        isUnlimited: boolean;
        isFreeUser: boolean;
        isLimitedUser?: boolean;
        quotaTier?: "free" | "plus" | "unlimited";
        quotaStatus?: {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            inputLimit: number;
            outputLimit: number;
            inputPercentage: number;
            outputPercentage: number;
            isQuotaExceeded: boolean;
            warningLevel: "none" | "warning" | "critical" | "exceeded";
            percentageTier: number;
            resetDate: string;
            daysUntilReset: number;
        };
        error?: string;
    }> => fetcher({ url: `/${agentId}/quota/status`, method: "GET" }),
    // Exchange registry (list of supported CEX exchanges).
    getExchanges: () =>
        fetcher({
            url: `/trading/exchanges`,
            method: "GET",
        }) as Promise<{
            success: boolean;
            exchanges: Array<{
                id: string;
                name: string;
                defaultAuthType: string | null;
                authTypes: Array<{
                    type: string;
                    fields: Array<{
                        id: string;
                        label: string;
                        type: "string" | "secret";
                        required: boolean;
                        description?: string;
                        placeholder?: string;
                    }>;
                }>;
            }>;
        }>,
    // Exchange credential storage (user-specific auths). Matches client-direct API:
    // GET with no authType returns full exchangeAuths for that exchange (all auth types).
    // GET with authType returns single auth type's fieldPresent/fieldPreview/updatedAt.
    getExchangeAuths: (exchangeId: string, authType?: string) =>
        fetcher({
            url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}${authType != null && authType !== "" ? `?authType=${encodeURIComponent(authType)}` : ""}`,
            method: "GET",
        }) as Promise<
            | {
                  success: boolean;
                  exchangeId: string;
                  isDefault?: boolean;
                  exchangeAuths: Record<
                      string,
                      {
                          fieldPresent: Record<string, boolean>;
                          fieldPreview: Record<string, string | null>;
                          updatedAt: number | null;
                      }
                  >;
              }
            | {
                  success: boolean;
                  exchangeId: string;
                  fieldPresent: Record<string, boolean>;
                  fieldPreview: Record<string, string | null>;
                  updatedAt: number | null;
                  isDefault?: boolean;
              }
        >,
    // PUT body: exchangeAuths array; each entry must have authType and field id -> value.
    // If server returns "No valid fields provided" (legacy server expecting flat body), retry with flat body for single entry.
    setExchangeAuths: async (
        exchangeId: string,
        exchangeAuths: Array<{ authType: string; [fieldId: string]: string | undefined }>
    ): Promise<{ success: boolean }> => {
        try {
            return await fetcher({
                url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}`,
                method: "PUT",
                body: { exchangeAuths },
            }) as Promise<{ success: boolean }>;
        } catch (firstErr) {
            const msg = (firstErr as Error)?.message ?? "";
            const isLegacyError = typeof msg === "string" && msg.includes("No valid fields provided");
            if (isLegacyError && exchangeAuths.length === 1) {
                const entry = exchangeAuths[0];
                const flatBody: Record<string, string> = { authType: entry.authType };
                for (const [k, v] of Object.entries(entry)) {
                    if (k !== "authType" && typeof v === "string" && v.trim() !== "") flatBody[k] = v;
                }
                return await fetcher({
                    url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}`,
                    method: "PUT",
                    body: flatBody,
                }) as Promise<{ success: boolean }>;
            }
            throw firstErr;
        }
    },
    // Optional authType: delete only that auth type for the exchange; else delete entire exchange auth.
    deleteExchangeAuths: (exchangeId: string, authType?: string) =>
        fetcher({
            url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}${authType != null && authType !== "" ? `?authType=${encodeURIComponent(authType)}` : ""}`,
            method: "DELETE",
            body: {},
        }) as Promise<{ success: boolean }>,
    setDefaultExchange: (exchangeId: string) =>
        fetcher({
            url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}/default`,
            method: "PUT",
            body: {},
        }) as Promise<{ success: boolean }>,
    getTradingEnabled: () =>
        fetcher({
            url: "/user/trading/enabled",
            method: "GET",
        }) as Promise<{ success: boolean; enabled: boolean }>,
    setTradingEnabled: (enableTrading: boolean) =>
        fetcher({
            url: "/user/trading/enabled",
            method: "PUT",
            body: { enableTrading },
        }) as Promise<{ success: boolean; enabled: boolean }>,
    submitCEXWorkflowApproval: (
        agentId: string,
        threadId: string,
        decision: 'approved' | 'rejected',
        confirmationLevel: 1 | 2,
        parameters?: Record<string, unknown>,
        approvalId?: string
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/agents/${agentId}/cex-workflow/approval`,
            method: "POST",
            body: { threadId, approvalId, decision, confirmationLevel, parameters },
        }),
    submitHumanInputApproval: (
        agentId: string,
        threadId: string,
        decision: "approved" | "rejected",
        confirmationLevel: 1 | 2,
        parameters?: Record<string, unknown>,
        approvalId?: string
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/agents/${agentId}/human-input/approval`,
            method: "POST",
            body: { threadId, approvalId, decision, confirmationLevel, parameters },
        }),

    // §7.1 — fetch the user's trading preferences (mode badge + risk limits source of truth).
    getTradingPreferences: (): Promise<{
        success: boolean;
        preferences:
            | (Record<string, unknown> & {
                  default_mode?: "live" | "paper" | "shadow";
                  kill_switch_active?: boolean;
              })
            | null;
    }> =>
        fetcher({
            url: `/user/trading/preferences`,
        }),

    // §7.3 — patch trading preferences.
    setTradingPreferences: (
        patch: Record<string, unknown>,
    ): Promise<{ success: boolean; code?: string; message?: string }> =>
        fetcher({
            url: `/user/trading/preferences`,
            method: "PUT",
            body: patch,
        }),

    // §7.2 — kill-switch toggle.
    setKillSwitch: (
        active: boolean,
        reason?: string,
    ): Promise<{ success: boolean; kill_switch_active: boolean }> =>
        fetcher({
            url: `/user/trading/kill-switch`,
            method: "PUT",
            body: { active, reason },
        }),

    // §7.6 — list a user's orders.
    listOrders: (params?: {
        limit?: number;
        venue?: string;
        state?: string;
    }): Promise<{ success: boolean; orders: Array<Record<string, unknown>> }> => {
        const qs = new URLSearchParams();
        if (params?.limit) qs.set("limit", String(params.limit));
        if (params?.venue) qs.set("venue", params.venue);
        if (params?.state) qs.set("state", params.state);
        const q = qs.toString();
        return fetcher({ url: `/user/orders${q ? `?${q}` : ""}` });
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

    // §7.8 — consent.
    getConsent: (
        consentType: string,
        version = "v1",
    ): Promise<{ success: boolean; consent: Record<string, unknown> | null }> =>
        fetcher({
            url: `/user/consent/${consentType}?version=${encodeURIComponent(version)}`,
        }),

    recordConsent: (
        consentType: string,
        version = "v1",
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/user/consent`,
            method: "POST",
            body: { consent_type: consentType, version, accepted: true },
        }),

    // §7.9 — notifications.
    listNotifications: (params?: {
        limit?: number;
        unreadOnly?: boolean;
    }): Promise<{
        success: boolean;
        notifications: Array<Record<string, unknown>>;
    }> => {
        const qs = new URLSearchParams();
        if (params?.limit) qs.set("limit", String(params.limit));
        if (params?.unreadOnly) qs.set("unreadOnly", "true");
        const q = qs.toString();
        return fetcher({ url: `/user/notifications${q ? `?${q}` : ""}` });
    },
    markNotificationRead: (id: string): Promise<{ success: boolean }> =>
        fetcher({
            url: `/user/notifications/${id}/read`,
            method: "POST",
        }),

    /**
     * Refresh the order-editor account snapshot for a pair the user
     * just typed in. The server re-derives `baseAsset`/`quoteAsset` from
     * the query so the response always matches the requested pair.
     * Returns `null` on 503 (no credentials, rate-limited, or no
     * provider) — caller should fall back to hiding the Avbl/Max block.
     */
    getCexAccountSnapshot: async (
        agentId: string,
        params: { venue: string; base: string; quote: string },
    ): Promise<{
        baseAvailable: string;
        quoteAvailable: string;
        baseAsset: string;
        quoteAsset: string;
        feeBps?: number;
    } | null> => {
        const qs = new URLSearchParams({
            venue: params.venue,
            base: params.base,
            quote: params.quote,
        });
        try {
            const r = (await fetcher({
                url: `/agents/${agentId}/cex/account-snapshot?${qs.toString()}`,
                method: "GET",
            })) as { snapshot?: {
                baseAvailable: string;
                quoteAvailable: string;
                baseAsset: string;
                quoteAsset: string;
                feeBps?: number;
            }; error?: string };
            return r.snapshot ?? null;
        } catch {
            return null;
        }
    },

    /**
     * F10.3 — live market snapshot for a symbol. Returns the same
     * `{ market_snapshot?, symbol_verification }` shape the approval
     * modal already consumes via the SSE `human_input_required`
     * payload, plus an `est_fill_price` / `slippage_vs_limit_bps` pair
     * when `side` + `limit_price` are supplied. Polled by
     * `useMarketSnapshot` every 5 s while a dialog is open so bid /
     * ask / 24 h stats / depth stay live. Returns `null` on any error
     * so the panel falls back to hiding the block rather than blocking
     * the user.
     */
    getMarketSnapshot: async (
        agentId: string,
        params: {
            symbol: string;
            venue?: string;
            side?: "BUY" | "SELL";
            limit_price?: string;
            action_name?: string;
        },
    ): Promise<{
        market_snapshot?: {
            symbol: string;
            bid?: string;
            bid_qty?: string;
            ask?: string;
            ask_qty?: string;
            spread_bps?: number;
            price_change_pct?: string;
            high_24h?: string;
            low_24h?: string;
            volume_24h?: string;
            quote_volume_24h?: string;
            depth_bids?: Array<{ price: string; qty: string }>;
            depth_asks?: Array<{ price: string; qty: string }>;
            est_fill_price?: number;
            slippage_vs_limit_bps?: number;
            fetched_at_ms: number;
        };
        symbol_verification: {
            matches: boolean;
            extracted_symbol: string;
            user_text_asset_mentions: string[];
            quote_currency_mismatch?: boolean;
            reason?: string;
        };
    } | null> => {
        const qs = new URLSearchParams({ symbol: params.symbol });
        if (params.venue) qs.set("venue", params.venue);
        if (params.side) qs.set("side", params.side);
        if (params.limit_price) qs.set("limit_price", params.limit_price);
        if (params.action_name) qs.set("action_name", params.action_name);
        try {
            const r = await fetcher({
                url: `/agents/${agentId}/cex/market-snapshot?${qs.toString()}`,
                method: "GET",
            });
            return r as {
                market_snapshot?: {
                    symbol: string;
                    bid?: string;
                    bid_qty?: string;
                    ask?: string;
                    ask_qty?: string;
                    spread_bps?: number;
                    price_change_pct?: string;
                    high_24h?: string;
                    low_24h?: string;
                    volume_24h?: string;
                    quote_volume_24h?: string;
                    depth_bids?: Array<{ price: string; qty: string }>;
                    depth_asks?: Array<{ price: string; qty: string }>;
                    est_fill_price?: number;
                    slippage_vs_limit_bps?: number;
                    fetched_at_ms: number;
                };
                symbol_verification: {
                    matches: boolean;
                    extracted_symbol: string;
                    user_text_asset_mentions: string[];
                    quote_currency_mismatch?: boolean;
                    reason?: string;
                };
            };
        } catch {
            return null;
        }
    },

    /**
     * Real historical OHLCV candles for `symbol` (full Binance pair, e.g.
     * "BTCUSDT") at `interval`. Backs the Strategy Floor candlestick scope so
     * it opens with genuine history. Returns `[]` on any upstream error so the
     * chart degrades to the forward-only live tape rather than blocking.
     */
    getKlines: async (
        agentId: string,
        symbol: string,
        interval: string,
        limit = 200,
    ): Promise<Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>> => {
        const qs = new URLSearchParams({ symbol, interval, limit: String(limit) });
        try {
            const r = (await fetcher({
                url: `/agents/${agentId}/cex/klines?${qs.toString()}`,
            })) as { candles?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };
            return r.candles ?? [];
        } catch {
            return [];
        }
    },

    /**
     * List of tradable spot products on `venue` (USDT/USDC/USD-quoted).
     * Backs the Pair combobox in the order editor; client should
     * SWR-cache for ~5 min. Returns `null` if the upstream public
     * endpoint is unavailable — caller falls back to the free-text
     * Pair input.
     */
    getCexTradableProducts: async (
        agentId: string,
        venue: string,
        marginType?: "cross" | "isolated",
    ): Promise<{
        venue: string;
        products: Array<{ product_id: string; base_asset: string; quote_asset: string }>;
        fetched_at_ms: number;
    } | null> => {
        const qs = new URLSearchParams({ venue });
        if (marginType) qs.set("marginType", marginType);
        try {
            return (await fetcher({
                url: `/agents/${agentId}/cex/products?${qs.toString()}`,
                method: "GET",
            })) as {
                venue: string;
                products: Array<{ product_id: string; base_asset: string; quote_asset: string }>;
                fetched_at_ms: number;
            };
        } catch {
            return null;
        }
    },

    /**
     * CEX exchange registry listing — returns all registered exchanges.
     * Alias for `getExchanges` under the CEX-prefixed naming convention
     * used by the trading components.
     */
    getCexExchanges: () =>
        fetcher({
            url: `/trading/exchanges`,
            method: "GET",
        }) as Promise<{
            success: boolean;
            exchanges: Array<{
                id: string;
                name: string;
                defaultAuthType: string | null;
                authTypes: Array<{
                    type: string;
                    fields: Array<{
                        id: string;
                        label: string;
                        type: "string" | "secret";
                        required: boolean;
                        description?: string;
                        placeholder?: string;
                    }>;
                }>;
            }>;
        }>,
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

/**
 * Translate the flat order params from `cex_prepare_order`'s approval
 * payload (`order_type`, `base_size`/`quote_size`, `limit_price`) into the
 * `order_configuration` JSON + `product_id` that `TradingOrderEditor` reads.
 * Without this, the subagent's price/amount/order-type are dropped and the
 * editor renders the order form blank/defaulted.
 */
function buildOrderConfigFromApproval(payload: Record<string, unknown>): {
    order_configuration: string;
    product_id: string;
} {
    const exchange = String(payload.exchange ?? "binance").toLowerCase();
    const symbol = String(payload.symbol ?? "").toUpperCase();
    const side = String(payload.side ?? "").toUpperCase();
    const orderType = String(payload.order_type ?? "market").toLowerCase();
    const baseSize = typeof payload.base_size === "number" ? payload.base_size : undefined;
    const quoteSize = typeof payload.quote_size === "number" ? payload.quote_size : undefined;
    const limitPrice = typeof payload.limit_price === "number" ? payload.limit_price : undefined;

    const quote = exchange === "coinbase" ? "USD" : "USDT";
    const product_id = symbol ? `${symbol}-${quote}` : "";

    let variantKey: string;
    const inner: Record<string, string> = {};

    if (orderType === "limit" || orderType === "stop_limit") {
        variantKey = orderType === "stop_limit" ? "stop_limit_stop_limit_gtc" : "limit_limit_gtc";
        if (limitPrice !== undefined) inner.limit_price = String(limitPrice);
        // Both variants only accept base_size — convert a quote-denominated
        // amount using the given limit price.
        if (baseSize !== undefined) {
            inner.base_size = String(baseSize);
        } else if (quoteSize !== undefined && limitPrice) {
            inner.base_size = String(quoteSize / limitPrice);
        }
        if (orderType === "stop_limit") {
            if (limitPrice !== undefined) inner.stop_price = String(limitPrice);
            inner.stop_direction = side === "BUY" ? "STOP_DIRECTION_STOP_UP" : "STOP_DIRECTION_STOP_DOWN";
        }
    } else {
        variantKey = "market_market_ioc";
        if (quoteSize !== undefined) inner.quote_size = String(quoteSize);
        else if (baseSize !== undefined) inner.base_size = String(baseSize);
    }

    return { order_configuration: JSON.stringify({ [variantKey]: inner }), product_id };
}

// Artifact emitted by the financial-agent backend `final` event.
type ChatArtifact = { n: number; type: string; ref: string; label?: string };

/**
 * Translate a backend `final` event into the assistant-message object that
 * chat.tsx renders. The raw narrative (with `{{artifact:N}}` placeholders) is
 * kept in `content.metadata.artifactText` so the renderer can split on the
 * placeholders and drop each chart inline at its exact position; `text` is a
 * placeholder-stripped copy used for the markdown fallback + copy button.
 */
function buildAssistantResponse(agentId: string, response: string, artifacts: ChatArtifact[]) {
    const byN = new Map(artifacts.map((a) => [a.n, a]));
    const chartPaths = artifacts.filter((a) => a.type === "chart").map((a) => a.ref);
    const text = response
        .replace(/\{\{artifact:(\d+)\}\}/g, (_m, n) => {
            const a = byN.get(Number(n));
            return a && a.type !== "chart" && a.label ? a.label : "";
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
                artifactText: response,
                chartPaths,
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
        favoriteTaskChain?: FavoriteTaskChainPayload,
        selectedFiles?: File[],
        messageClassification?: "TASK_CHAIN_MESSAGE",
        language?: string,
        /**
         * F10 — structured manual-compose payload. When set, the server's
         * CEX workflow handler short-circuits the LLM and uses these
         * parameters verbatim (still subject to risk gates + approval).
         */
        composed?: { action: string; parameters: Record<string, unknown> },
        retryCount = 0,
    ) {
        // Create unique key for request deduplication (userId determined server-side from auth/IP)
        const favoriteKeySegment = favoriteTaskChain
            ? String(
                  favoriteTaskChain.favoriteId
                      ?? favoriteTaskChain.id
                      ?? favoriteTaskChain.name
                      ?? ""
              ).substring(0, 50)
            : "";
        const classificationKeySegment = messageClassification ?? "";
        const requestKey = `${agentId}-${roomId}-${message.substring(0, 50)}-${favoriteKeySegment}-${classificationKeySegment}`;
        
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
        // it back via X-Session-Id). File uploads / favorite chains / composed
        // trade payloads aren't supported by this backend, so they are ignored
        // here (the params remain in the signature for call-site compatibility
        // and are still threaded through the retry path below).
        void favoriteTaskChain; void selectedFiles; void messageClassification;
        void language; void composed;
        const body: string = JSON.stringify({ message, sessionId: roomId });
        const headers: HeadersInit = { "Content-Type": "application/json" };

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
                            buildAssistantResponse(agentId, parsed.response ?? '', parsed.artifacts ?? []),
                        ]);
                        break;
                    case 'approval_required': {
                        // Backend CEX preview tool emits this when an order needs
                        // human confirmation. Translate into the human_input_required
                        // step shape that chat.tsx uses to open HumanInputDialog.
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
                        const { exchange, symbol, side, order_type, base_size, quote_size, limit_price, ...rest } = payload as Record<string, unknown>;
                        const sizeStr = base_size !== undefined
                            ? String(base_size)
                            : quote_size !== undefined ? `$${quote_size}` : '';
                        const { order_configuration, product_id } = buildOrderConfigFromApproval(payload as Record<string, unknown>);
                        onStep({
                            id: approval_id,
                            name: 'human_input_required',
                            status: 'in_progress',
                            message: 'Order approval required',
                            timestamp: Date.now(),
                            data: {
                                type: 'trading_order',
                                threadId: roomId,
                                approvalId: approval_id,
                                interruptType: 'trading_order',
                                title: `Review ${String(side ?? '').toUpperCase()} order${sizeStr ? ` — ${sizeStr} ${symbol ?? ''}` : ''}`,
                                confirmationLevel: 1,
                                confirmationsRequired: 2,
                                actionName: 'create_order',
                                fields: { exchange, symbol, side, order_type, base_size, quote_size, limit_price, product_id, order_configuration, ...rest },
                                fieldSchema: null,
                                accountSnapshot: null,
                            },
                        });
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
                        favoriteTaskChain,
                        selectedFiles,
                        messageClassification,
                        language,
                        composed,
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
