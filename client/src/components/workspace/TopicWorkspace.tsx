import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import type { ResearchSummary, TopicChartPreference, TopicSummary, UUID } from "@/types/core";
import type { ChartWorkspaceMessage } from "@/lib/chartWorkspace";
import type { ContentWithUser } from "@/components/chat/types";
import { apiClient } from "@/lib/api";
import { useResearchStream } from "@/hooks/useResearchStream";
import { useTopicCharts } from "@/hooks/useTopicCharts";
import { useFinancialModel } from "@/hooks/useFinancialModel";
import { useSplitLayout } from "@/hooks/useSplitLayout";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { useToast } from "@/hooks/use-toast";
import type { ModelChartTab } from "@/lib/topicCharts";
import { StrategyApprovalDialog } from "@/components/Dialog/StrategyApprovalDialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ModelPane } from "@/components/model/ModelPane";
import { ChartPane } from "./ChartPane";
import { ConversationPane } from "./ConversationPane";
import { MemberRow, type MemberChip } from "./MemberRow";
import { StatusBar } from "./StatusBar";
import { TopicRail } from "./TopicRail";

const RAIL_WIDTH = 240;
const RAIL_WIDTH_COLLAPSED = 56;

/**
 * The research workspace shell: rail, charts, conversation.
 *
 * It takes a member **array**, not a single topic. Phase 1 always passes
 * exactly one; phase 2's Research view passes N (spec §11). That is the whole
 * reason this component has this shape — a Topic is a Research with one
 * member, so the shell must already be the isomorphic one.
 *
 * Note what is deliberately absent: any transition on the chart column
 * appearing or disappearing. That column reflects whether chart content
 * exists, not a state the user toggled, and animating it would claim
 * otherwise (spec §7).
 *
 * Phase 2 adds `research`. When it is set, three things change and nothing
 * else does:
 *   1. the conversation is the **Research's** session, not any member's —
 *      focusing a member changes which charts are on screen, never who the
 *      user is talking to (spec §7.1);
 *   2. the member row appears above the chart tab row (spec §7.2/§7.3);
 *   3. the StatusBar reports the Research, not a `leadSymbol` (spec §7.6).
 */
export function TopicWorkspace({
    agentId,
    members,
    activeTopic,
    research,
    demo,
}: {
    agentId: UUID;
    /** Phase 1 always passes one. Research passes N — possibly zero. */
    members: TopicSummary[];
    /** The Topic whose session drives a phase-1 view. Undefined in a Research,
     *  where the session is the Research's own. */
    activeTopic?: TopicSummary;
    research?: ResearchSummary;
    /** Local replay data: production workspaces leave this undefined. */
    demo?: { rail: { topics: TopicSummary[]; researches: ResearchSummary[] }; initialSheetId?: string };
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [railCollapsed, setRailCollapsed] = useState(false);
    const [railSheetOpen, setRailSheetOpen] = useState(false);
    const [input, setInput] = useState("");

    const narrow = useIsNarrow();
    const railWidth = railCollapsed ? RAIL_WIDTH_COLLAPSED : RAIL_WIDTH;

    const isResearch = Boolean(research);
    // A Research id doubles as its chat session id, exactly like a Topic id.
    const sessionId = research?.id ?? activeTopic?.id ?? "";

    // Which member's charts are on screen. NOT in the URL (spec §7.9): the
    // agent can move it, and a history entry per `focus` call would destroy
    // the back button.
    const [focusedMemberId, setFocusedMemberId] = useState<string | undefined>(
        () => activeTopic?.id ?? members[0]?.id,
    );
    const focusedMember = members.find((member) => member.id === focusedMemberId) ?? members[0] ?? activeTopic;
    const chartTopicId = focusedMember?.id;

    // Scoped the same way chart tabs are (`chartTopicId ?? sessionId`): a
    // model belongs to a topic — `GET /api/agents/:agentId/topics/:topicId/models`
    // — not to a Research session, so it follows the focused member exactly
    // like `useTopicCharts` does below.
    const model = useFinancialModel(agentId, chartTopicId ?? sessionId);
    // Which sheet is on screen, and whether the user has steered it away from
    // auto-locate (Task 11 §7.3) themselves during the turn in progress.
    const [activeSheetId, setActiveSheetId] = useState<string | undefined>(() => demo?.initialSheetId);
    const [userPickedThisTurn, setUserPickedThisTurn] = useState(false);

    const stream = useResearchStream(agentId, sessionId, {
        onModelRevision: model.onRevisionFrame,
        activeModelId: model.activeModelId,
    });
    // Called unconditionally: in narrow mode the result goes unused, but a
    // hook that only sometimes runs is not a hook.
    const { containerRef, ratio, setRatio } = useSplitLayout(railWidth);

    // Task 11 §7.3: auto-locate may only steer the sheet while a turn is in
    // flight AND the user hasn't picked a tab themselves during that turn.
    // The latch has to reset on the *rising edge* of isProcessing — not on
    // every render where it happens to be true — or "this turn" would never
    // become a real boundary; it would just be "processing", permanently
    // re-opening or never resetting depending on timing.
    const wasProcessingRef = useRef(false);
    useEffect(() => {
        if (stream.isProcessing && !wasProcessingRef.current) setUserPickedThisTurn(false);
        wasProcessingRef.current = stream.isProcessing;
    }, [stream.isProcessing]);

    // The model's own reported change, but only when it belongs to the model
    // actually on screen: `model.change` can lag behind `model.activeModelId`
    // for one render after the user switches models with no new frame yet to
    // replace it, and reading it unguarded here would auto-navigate off a
    // stale batch built for a model nobody is looking at (same hazard
    // `useFinancialModel`'s own `isCellChanged` already guards against).
    const activeModelChange =
        model.change && model.change.modelId === model.activeModelId ? model.change : undefined;

    useEffect(() => {
        if (!stream.isProcessing || userPickedThisTurn) return;
        const target = activeModelChange?.sheetIds[0];
        // The list is already in strip order (sheetsTouchedBy preserves it), so
        // the first entry is the leftmost changed sheet — a stable choice
        // rather than whichever frame happened to arrive last.
        if (target && target !== activeSheetId) setActiveSheetId(target);
    }, [activeModelChange, stream.isProcessing, userPickedThisTurn, activeSheetId]);

    // In a Research the conversation belongs to the controller, so the charts
    // cannot be derived from it — they belong to the focused member and are
    // read from that member's own history (same query key `useTopicStream`
    // uses, so opening the Topic later is a cache hit).
    const { data: memberMessages } = useQuery<ContentWithUser[]>({
        queryKey: ["messages", agentId, chartTopicId],
        queryFn: async () => {
            const result = await apiClient.getMessages(agentId, chartTopicId!, { limit: 500 });
            return (result.messages ?? []) as ContentWithUser[];
        },
        enabled: isResearch && Boolean(chartTopicId),
        refetchOnWindowFocus: false,
    });

    const chartMessages = (isResearch ? memberMessages ?? [] : stream.messages) as unknown as ChartWorkspaceMessage[];
    const chartStreamingText = isResearch ? "" : stream.streamingText;

    // ChartPane owns the tab state; this read is only to decide whether the
    // column exists at all. Both calls share the same query cache.
    const { tabs } = useTopicCharts(agentId, chartTopicId ?? sessionId, chartMessages, chartStreamingText);

    // Model tabs are not a preference (see ModelChartTab's doc comment in
    // lib/topicCharts.ts) — they come straight from the backend's own model
    // list, folded in here rather than into `tabs` above.
    const modelTabs = useMemo<ModelChartTab[]>(
        () => model.models.map((entry) => ({ kind: "model" as const, modelId: entry.modelId, symbol: entry.symbol })),
        [model.models],
    );
    // A topic with a model but no charted symbol yet still needs the column —
    // that model IS the content the column exists to show.
    const hasCharts = Boolean(chartTopicId) && (tabs.length > 0 || modelTabs.length > 0);
    const showChart = hasCharts && (narrow || ratio > 0);

    // Spec §7.3, row 1 says a single member gets no member row — but that rule
    // is about the plain *Topic* view, which has its own `+ Compare` in the chart
    // tab bar. Inside a Research the row is the only place the `+` lives, so
    // hiding it at exactly one member strands the user: a Research that decays
    // to one member could never grow again. A Research always shows the row.
    const showMemberRow = isResearch;

    // The chip badge count. `MemberChip.chartCount` has no counterpart on
    // `TopicSummary`, so it is derived here: the persisted preference rows for
    // each member, minus hidden ones. The focused member is the one case where
    // the merged tab list is already on hand and is strictly more accurate.
    const memberChartCounts = useQueries({
        queries: members.map((member) => ({
            queryKey: ["topicCharts", agentId, member.id],
            queryFn: async () => (await apiClient.getTopicCharts(agentId, member.id)).charts ?? [],
            enabled: isResearch,
            refetchOnWindowFocus: false,
        })),
        combine: (results) =>
            results.map(
                (result) => ((result.data ?? []) as TopicChartPreference[]).filter((chart) => !chart.hidden).length,
            ),
    });

    const memberChips = useMemo<MemberChip[]>(
        () =>
            members.map((member, index) => ({
                id: member.id,
                name: member.name,
                leadSymbol: member.leadSymbol,
                chartCount: member.id === chartTopicId ? tabs.length : memberChartCounts[index] ?? 0,
            })),
        [members, chartTopicId, tabs.length, memberChartCounts],
    );

    // Navigating to another topic or Research closes the off-canvas rail.
    useEffect(() => {
        setRailSheetOpen(false);
    }, [sessionId]);

    // A new session starts on its own first member; membership shrinking below
    // the focused member falls back to whatever is left.
    useEffect(() => {
        setFocusedMemberId(undefined);
    }, [sessionId]);

    // The controller moved focus (spec §7.5). Transient, session-only.
    useEffect(() => {
        const target = stream.agentFocusTopicId;
        if (target && members.some((member) => member.id === target)) {
            setFocusedMemberId(target);
        }
    }, [stream.agentFocusTopicId, members]);

    const refreshResearch = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: ["research", agentId, research?.id] });
        void queryClient.invalidateQueries({ queryKey: ["researches", agentId] });
    }, [queryClient, agentId, research?.id]);

    const writeMembers = useCallback(
        async (topicIds: string[]) => {
            if (!research) return;
            try {
                await apiClient.setResearchMembers(agentId, research.id, topicIds);
                refreshResearch();
            } catch (error) {
                toast({
                    variant: "destructive",
                    title: t("research.membersFailed"),
                    description: error instanceof Error ? error.message : t("common.unexpectedError"),
                });
            }
        },
        [agentId, research, refreshResearch, toast, t],
    );

    // `onAddMembers` hands back only the freshly picked ids; the endpoint is a
    // whole-set overwrite, so the union has to happen here or the existing
    // members would be dropped.
    const handleAddMembers = useCallback(
        (topicIds: string[]) => {
            const union = Array.from(new Set([...members.map((member) => member.id), ...topicIds]));
            void writeMembers(union);
        },
        [members, writeMembers],
    );

    const handleRemoveMember = useCallback(
        (memberId: string) => {
            void writeMembers(members.filter((member) => member.id !== memberId).map((member) => member.id));
        },
        [members, writeMembers],
    );

    // "+ compare" from a plain Topic view (spec §7.4): create the Research and
    // go there. The name is left to the server, which joins the members'
    // `leadSymbol`-or-name with " · " — duplicating that here would only give
    // the two spellings a chance to drift.
    const handleCompare = useCallback(
        async (topicIds: string[]) => {
            if (!activeTopic) return;
            try {
                const result = await apiClient.createResearch(agentId, {
                    topicIds: Array.from(new Set([activeTopic.id, ...topicIds])),
                });
                void queryClient.invalidateQueries({ queryKey: ["researches", agentId] });
                navigate(`/research/${agentId}/${result.research.id}`);
            } catch (error) {
                toast({
                    variant: "destructive",
                    title: t("research.createFailed"),
                    description: error instanceof Error ? error.message : t("common.unexpectedError"),
                });
            }
        },
        [agentId, activeTopic, navigate, queryClient, toast, t],
    );

    // One member reads as that topic's name; several read as the set. Phase 1
    // only ever takes the first branch, but the pane already speaks both.
    const conversationTitle =
        members.length > 1
            ? members.map((member) => member.name).join(" · ")
            : members[0]?.name ?? research?.name ?? activeTopic?.name ?? "";

    // Auto-locate (Task 11) is the only source of a scroll target: a manual
    // sheet pick passes `undefined`, since WorkbookGrid's own guard fires
    // once per new id and must not fight a scroll position the user already
    // chose for themselves.
    const autoLocating = stream.isProcessing && !userPickedThisTurn;
    // `lineItems` is a Map (insertion order == arrival order), so the first
    // key is the earliest-arriving changed line item in the open batch — the
    // same "stable, not last-frame-wins" choice `sheetIds[0]` makes above.
    const scrollToLineItemId = autoLocating
        ? [...(activeModelChange?.lineItems.keys() ?? [])][0]
        : undefined;

    const modelPane = model.context ? (
        <ModelPane
            context={model.context}
            sheets={model.sheets}
            activeSheetId={activeSheetId}
            onSelectSheet={(sheetId) => {
                setActiveSheetId(sheetId);
                setUserPickedThisTurn(true);
            }}
            markedSheetIds={activeModelChange?.sheetIds ?? []}
            isCellChanged={model.isCellChanged}
            scrollToLineItemId={scrollToLineItemId}
        />
    ) : null;

    const chartPane = chartTopicId ? (
        <ChartPane
            agentId={agentId}
            topicId={chartTopicId}
            messages={chartMessages}
            streamingText={chartStreamingText}
            onCompare={isResearch || demo ? undefined : handleCompare}
            modelTabs={modelTabs}
            modelPane={modelPane}
            modelFocusRequest={model.focusRequest}
            readOnly={demo !== undefined}
        />
    ) : null;

    // Lives on the chart side of the workspace, never in the conversation
    // (spec §7.7) — it controls what the chart area shows, and separating the
    // control from what it controls is the one thing this row must not do.
    // When the chart column is absent it stays at the top of the area the
    // column would have occupied rather than moving under the conversation.
    const memberBand = showMemberRow ? (
        <div className="shrink-0 border-b border-sep bg-background px-3 py-2">
            <MemberRow
                agentId={agentId}
                members={memberChips}
                activeMemberId={chartTopicId}
                onSelectMember={setFocusedMemberId}
                onRemoveMember={handleRemoveMember}
                onAddMembers={handleAddMembers}
                focusSignal={stream.focusSignal}
            />
            {members.length === 0 && (
                <p className="mt-1 text-xs text-label-3">{t("research.emptyMembers")}</p>
            )}
        </div>
    ) : null;

    const conversationPane = (
        <ConversationPane
            agentId={agentId}
            title={conversationTitle}
            subtitle={isResearch ? undefined : activeTopic?.leadSymbol ?? undefined}
            stream={stream}
            input={input}
            onInputChange={setInput}
            readOnly={demo !== undefined}
        />
    );

    return (
        <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-background">
            <StatusBar
                topic={activeTopic}
                research={research ? { name: research.name, memberCount: members.length } : undefined}
                onOpenRail={narrow ? () => setRailSheetOpen(true) : undefined}
            />

            {narrow ? (
                <>
                    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        {!showChart && memberBand}
                        {showChart && (
                            <div className="flex h-[42dvh] shrink-0 flex-col overflow-hidden">
                                {memberBand}
                                <div className="min-h-0 flex-1">{chartPane}</div>
                            </div>
                        )}
                        <div className="min-h-0 flex-1">{conversationPane}</div>
                    </div>
                    <Sheet open={railSheetOpen} onOpenChange={setRailSheetOpen}>
                        <SheetContent side="left" className="w-[240px] p-0 sm:max-w-[240px]">
                            <SheetTitle className="sr-only">{t("topics.title")}</SheetTitle>
                            <div className={demo ? "pointer-events-none h-full" : "h-full"}>
                                <TopicRail
                                    agentId={agentId}
                                    activeTopicId={isResearch ? undefined : activeTopic?.id}
                                    activeResearchId={research?.id}
                                    collapsed={false}
                                    onCollapsedChange={() => setRailSheetOpen(false)}
                                    demoData={demo?.rail}
                                />
                            </div>
                        </SheetContent>
                    </Sheet>
                </>
            ) : (
                <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
                    <div className={demo ? "pointer-events-none h-full" : "h-full"}>
                        <TopicRail
                            agentId={agentId}
                            activeTopicId={isResearch ? undefined : activeTopic?.id}
                            activeResearchId={research?.id}
                            collapsed={railCollapsed}
                            onCollapsedChange={setRailCollapsed}
                            demoData={demo?.rail}
                        />
                    </div>
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                        {!showChart && memberBand}
                        <div className="flex min-h-0 flex-1 overflow-hidden">
                            {showChart && (
                                <>
                                    <div
                                        className="flex min-w-0 shrink-0 flex-col overflow-hidden"
                                        style={{ width: `calc(100% * ${ratio})` }}
                                    >
                                        {memberBand}
                                        <div className="min-h-0 flex-1">{chartPane}</div>
                                    </div>
                                    <SplitHandle
                                        containerRef={containerRef}
                                        railWidth={railWidth}
                                        onRatioChange={setRatio}
                                    />
                                </>
                            )}
                            <div className="min-w-0 flex-1">{conversationPane}</div>
                        </div>
                    </div>
                </div>
            )}

            {/* A workspace-level interrupt, not part of the message flow —
                which is why it hangs off the shell rather than the pane. */}
            {stream.pendingApproval && (
                <StrategyApprovalDialog
                    isOpen
                    data={stream.pendingApproval}
                    onApprove={() => stream.resolveApproval("approve")}
                    onReject={() => stream.resolveApproval("reject")}
                />
            )}
        </div>
    );
}

/**
 * The draggable divider. Ratios are measured against the space left over
 * after the rail, which is what `useSplitLayout` clamps against.
 */
function SplitHandle({
    containerRef,
    railWidth,
    onRatioChange,
}: {
    containerRef: RefObject<HTMLDivElement | null>;
    railWidth: number;
    onRatioChange: (ratio: number) => void;
}) {
    const { t } = useTranslation();
    const draggingRef = useRef(false);

    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const container = containerRef.current;
            if (!container) return;
            event.preventDefault();
            draggingRef.current = true;
            document.body.classList.add("select-none");

            const move = (moveEvent: PointerEvent) => {
                if (!draggingRef.current) return;
                const rect = container.getBoundingClientRect();
                const availableWidth = rect.width - railWidth;
                if (availableWidth <= 0) return;
                onRatioChange((moveEvent.clientX - rect.left - railWidth) / availableWidth);
            };
            const up = () => {
                draggingRef.current = false;
                document.body.classList.remove("select-none");
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
            };

            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        },
        [containerRef, railWidth, onRatioChange],
    );

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("workspace.resizeColumns")}
            onPointerDown={handlePointerDown}
            className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-fill-2"
        />
    );
}
