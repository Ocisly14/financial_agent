import type { ContentWithUser } from "./types";
import i18n from "@/i18n";

export const formatSourceName = (source: string | undefined | null): string => {
    if (!source) return "";

    switch (source) {
        case "regular_message":
            return i18n.t("chat.sources.regularMessage");
        case "task_chain_action":
            return i18n.t("chat.sources.taskChain");
        case "task_chain_planning":
            return i18n.t("chat.sources.taskPlanning");
        case "direct":
            return "";
        default:
            return source
                .replace(/_handler|_action/g, "")
                .replace(/_/g, " ")
                .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
};

export const extractChartPaths = (text: string): string[] => {
    const chartPaths: string[] = [];
    const patterns = [
        /(generated|chart|saved to|Chart URL:|Chart saved at):\s*([^\s]+saved_data[\/\\]Charts[\/\\][^\s]+\.(html|png))/gi,
        /([^\s]*saved_data[\/\\]Charts[\/\\][^\s]+\.(html|png))/gi,
        /([\w-]+_chart_[^\s]*\.(html|png))/gi,
    ];

    for (const pattern of patterns) {
        let match: RegExpExecArray | null = pattern.exec(text);
        while (match !== null) {
            let path = match[2] ?? match[1] ?? match[0];
            if (!path) continue;

            path = path.replace(/`/g, "");

            if (path.includes("saved_data")) {
                const savedDataIndex = path.indexOf("saved_data");
                path = path.substring(savedDataIndex);
            }

            if (path.startsWith("Charts/") || path.startsWith("outputs/")) {
                path = `saved_data/${path}`;
            } else if (path.endsWith(".html") || path.endsWith(".png")) {
                path = `saved_data/Charts/${path}`;
            }

            if (!path.includes("/Reports/") && !chartPaths.includes(path)) {
                chartPaths.push(path);
            }

            match = pattern.exec(text);
        }
    }

    return chartPaths;
};

export const extractReportPaths = (text: string): string[] => {
    const reportPaths: string[] = [];
    const patterns = [
        /(?:find.*?report at|saved to|at):\s*([^\s]+saved_data[\/\\]Reports[\/\\][^\s]+\.html)/gi,
        /([^\s]*saved_data[\/\\]Reports[\/\\][^\s]+\.html)/gi,
    ];

    for (const pattern of patterns) {
        let match: RegExpExecArray | null = pattern.exec(text);
        while (match !== null) {
            let path = match[1] ?? match[0];
            if (!path) continue;

            path = path.replace(/`/g, "");

            if (path.includes("saved_data")) {
                const savedDataIndex = path.indexOf("saved_data");
                path = path.substring(savedDataIndex);
            }

            if (!reportPaths.includes(path)) {
                reportPaths.push(path);
            }

            match = pattern.exec(text);
        }
    }

    return reportPaths;
};

export const getChartId = (messageId: string | number | undefined, chartPath: string): string => {
    const fileName = chartPath
        .split("/")
        .pop()
        ?.split("\\")
        .pop()
        ?.replace(/\.(html|png)$/, "") || chartPath;
    const safeId = messageId ?? "unknown";
    return `chart-${safeId}-${fileName}`;
};

export const resolveMessageId = (message: ContentWithUser): string | number | undefined => {
    const candidateId = message.id as unknown;
    if (typeof candidateId === "string" || typeof candidateId === "number") {
        return candidateId;
    }

    const candidateCreatedAt = message.createdAt as unknown;
    if (typeof candidateCreatedAt === "string" || typeof candidateCreatedAt === "number") {
        return candidateCreatedAt;
    }

    return undefined;
};

export interface GetMessageChartPathsOptions {
    /**
     * When true (default), include chart paths discovered in metadata.chartPaths arrays.
     * Disable to avoid attaching global chart collections from summary messages.
     * when rendering individual action nodes.
     */
    includeMetadataArray?: boolean;
    /**
     * When true, metadata-derived chart paths are only included if the message text references
     * the path or its filename. Helps avoid attaching unrelated charts for high-level summaries.
     */
    requireTextReference?: boolean;
}

export const getMessageChartPaths = (
    message: ContentWithUser,
    deletedFiles: ReadonlySet<string>,
    options?: GetMessageChartPathsOptions
): string[] => {
    const { includeMetadataArray = true, requireTextReference = false } = options ?? {};
    const chartPaths: string[] = [];
    const metadata = (message as { content?: { metadata?: Record<string, unknown> }; metadata?: Record<string, unknown> }).content?.metadata
        ?? (message as { metadata?: Record<string, unknown> }).metadata;
    const content = (message as { content?: Record<string, unknown> }).content;
    const messageText = typeof message.text === "string" ? message.text.toLowerCase() : "";

    // Helper function to add chart path if valid
    const addChartPathIfValid = (chartPath: string) => {
        if (typeof chartPath !== "string") return;
        let relativePath = chartPath;
        if (relativePath.includes("saved_data")) {
            const savedDataIndex = relativePath.indexOf("saved_data");
            relativePath = relativePath.substring(savedDataIndex);
        }
        if (requireTextReference && messageText) {
            const normalizedPath = relativePath.replace(/\\/g, "/").toLowerCase();
            const fileName = normalizedPath.split("/").pop() ?? "";
            const fileNameNoExt = fileName.replace(/\.(html|png)$/, "");
            const fileNameSpaced = fileNameNoExt.replace(/[_-]+/g, " ");

            const references = [
                normalizedPath,
                fileName,
                fileNameNoExt,
                fileNameSpaced,
            ].filter(Boolean);

            const hasReference = references.some((token) => token && messageText.includes(token));
            if (!hasReference) {
                return;
            }
        } else if (requireTextReference && !messageText) {
            return;
        }

        if (!deletedFiles.has(relativePath) && !chartPaths.includes(relativePath)) {
            chartPaths.push(relativePath);
        }
    };

    // Extract from metadata.chartPath
    if (metadata) {
        if (typeof metadata.chartPath === "string") {
            addChartPathIfValid(metadata.chartPath);
        }

        // Extract from metadata.chartPaths array
        if (includeMetadataArray && Array.isArray(metadata.chartPaths)) {
            for (const chartPath of metadata.chartPaths) {
                addChartPathIfValid(chartPath);
            }
        }
    }

    // Extract from content.chartPath (StandardActionResponse format)
    if (content) {
        if (typeof content.chartPath === "string") {
            addChartPathIfValid(content.chartPath);
        }

        // Extract from content.visualizations (StandardActionResponse format)
        if (content.visualizations && typeof content.visualizations === "object") {
            const visualizations = content.visualizations as Record<string, unknown>;
            // Check for interactive_chart or other chart-related fields
            if (typeof visualizations.interactive_chart === "string") {
                addChartPathIfValid(visualizations.interactive_chart);
            }
            // Check for other visualization types that might contain chart paths
            for (const [key, value] of Object.entries(visualizations)) {
                if (key.includes("chart") && typeof value === "string") {
                    addChartPathIfValid(value);
                }
            }
        }
    }

    // Fallback: extract from message text if no charts found
    if (chartPaths.length === 0 && message.text) {
        for (const path of extractChartPaths(message.text)) {
            if (!deletedFiles.has(path) && !chartPaths.includes(path)) {
                chartPaths.push(path);
            }
        }
    }

    return chartPaths;
};

// ── Inline artifact segments (financial-agent {{artifact:N}} placeholders) ────
// The backend embeds `{{artifact:N}}` markers in the narrative and ships the
// artifact list on content.metadata.artifacts (+ the raw text on
// content.metadata.artifactText). Split the raw text on the markers so each
// chart renders inline at its exact position.
export interface InlineArtifact {
    n: number;
    type: string;
    ref: string;
    label?: string;
}

export type ArtifactSegment = { text: string } | { chartPath: string };

export const getArtifactSegments = (message: ContentWithUser): ArtifactSegment[] | null => {
    const metadata = (message as { content?: { metadata?: Record<string, unknown> }; metadata?: Record<string, unknown> }).content?.metadata
        ?? (message as { metadata?: Record<string, unknown> }).metadata;
    const artifacts = metadata?.artifacts as InlineArtifact[] | undefined;
    const raw = metadata?.artifactText as string | undefined;
    if (!Array.isArray(artifacts) || artifacts.length === 0 || typeof raw !== "string") {
        return null;
    }

    const byN = new Map(artifacts.map((a) => [a.n, a]));
    const segments: ArtifactSegment[] = [];
    for (const part of raw.split(/(\{\{artifact:\d+\}\})/g)) {
        const marker = part.match(/^\{\{artifact:(\d+)\}\}$/);
        if (marker) {
            const artifact = byN.get(Number(marker[1]));
            if (artifact && artifact.type === "chart") {
                segments.push({ chartPath: artifact.ref });
            } else if (artifact && artifact.label) {
                segments.push({ text: artifact.label });
            }
        } else if (part.trim()) {
            segments.push({ text: part });
        }
    }
    return segments.length > 0 ? segments : null;
};

export interface ChartSegment {
    text: string;
    charts: string[];
}

export interface ParsedMessageWithCharts {
    segments: ChartSegment[];
    chartsAtEnd?: string[];
    hasInlineCharts: boolean;
}

export const parseMessageWithCharts = (message: ContentWithUser, charts: string[]): ParsedMessageWithCharts => {
    const messageText = message.text ?? "";
    if (!messageText || charts.length === 0) {
        return { segments: [{ text: messageText, charts: [] }], hasInlineCharts: false };
    }

    const chartPositions: Array<{ path: string; index: number; endIndex: number }> = [];

    for (const chartPath of charts) {
        const fileName = chartPath.split("/").pop()?.split("\\").pop() ?? "";
        const patterns = [chartPath, fileName, fileName.replace(/\.(html|png)$/, "")];

        for (const pattern of patterns) {
            let searchIndex = 0;
            while (searchIndex < messageText.length) {
                const index = messageText.indexOf(pattern, searchIndex);
                if (index === -1) break;

                if (!chartPositions.some((cp) => cp.path === chartPath)) {
                    chartPositions.push({ path: chartPath, index, endIndex: index + pattern.length });
                }

                searchIndex = index + pattern.length;
                break;
            }
            if (chartPositions.some((cp) => cp.path === chartPath)) {
                break;
            }
        }
    }

    if (chartPositions.length === 0) {
        return {
            segments: [{ text: messageText, charts: [] }],
            chartsAtEnd: charts,
            hasInlineCharts: false,
        };
    }

    chartPositions.sort((a, b) => a.index - b.index);

    const segments: ChartSegment[] = [];
    let lastIndex = 0;

    for (const chartPos of chartPositions) {
        let paragraphEnd = chartPos.endIndex;
        const nextNewline = messageText.indexOf("\n\n", chartPos.endIndex);
        if (nextNewline !== -1) {
            paragraphEnd = nextNewline + 2;
        } else {
            paragraphEnd = messageText.length;
        }

        segments.push({
            text: messageText.substring(lastIndex, paragraphEnd),
            charts: [chartPos.path],
        });

        lastIndex = paragraphEnd;
    }

    if (lastIndex < messageText.length) {
        segments.push({ text: messageText.substring(lastIndex), charts: [] });
    }

    const foundCharts = chartPositions.map((cp) => cp.path);
    const unfoundCharts = charts.filter((chart) => !foundCharts.includes(chart));
    if (unfoundCharts.length > 0) {
        if (segments.length > 0) {
            segments[segments.length - 1].charts.push(...unfoundCharts);
        } else {
            segments.push({ text: "", charts: unfoundCharts });
        }
    }

    return { segments, hasInlineCharts: true };
};

export interface ParsedActionResult {
    action: string;
    phase: string;
    status: "success" | "failed" | "pending";
    content: string;
    summary: string;
}

export const parseActionResults = (messageText: string): ParsedActionResult[] | null => {
    const actionResultsPattern = /## Action Results Summary[\s\S]*?### (Data Gathering Phase|Analysis Phase|Prediction Phase)[\s\S]*?(?=##|\n\n|\Z)/gi;
    const matches = messageText.match(actionResultsPattern);

    if (!matches) return null;

    const actionResults: ParsedActionResult[] = [];

    const phasePatterns: Record<string, RegExp> = {
        data_gathering: /### Data Gathering Phase \((\d+) actions\)([\s\S]*?)(?=###|\n\n|$)/gi,
        analysis: /### Analysis Phase \((\d+) actions\)([\s\S]*?)(?=###|\n\n|$)/gi,
        prediction: /### Prediction Phase \((\d+) actions\)([\s\S]*?)(?=###|\n\n|$)/gi,
    };

    for (const [phase, pattern] of Object.entries(phasePatterns)) {
        const phaseMatch = pattern.exec(messageText);
        if (!phaseMatch) continue;

        const actionsText = phaseMatch[2];
        const actionLines = actionsText.match(/- ([^:]+): (.+)/g);
        if (!actionLines) continue;

        for (const line of actionLines) {
            const actionMatch = line.match(/- ([^:]+): (.+)/);
            if (!actionMatch) continue;

            const [, actionName, actionDetails] = actionMatch;
            const normalizedDetails = actionDetails.trim();
            let status: "success" | "failed" | "pending" = "pending";
            if (normalizedDetails.includes("Completed")) {
                status = "success";
            } else if (normalizedDetails.includes("Failed")) {
                status = "failed";
            }

            actionResults.push({
                action: actionName.trim(),
                phase,
                status,
                content: normalizedDetails,
                summary: `${actionName.trim()} execution result: ${normalizedDetails}`,
            });
        }
    }

    return actionResults.length > 0 ? actionResults : null;
};
