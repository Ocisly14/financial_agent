import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { NavLink, useNavigate } from "react-router-dom";
import { CheckSquare, PanelLeftClose, PanelLeftOpen, Plus, Trash2, TrendingUp, X } from "lucide-react";
import type { ResearchSummary, TopicSummary, UUID } from "@/types/core";
import { apiClient } from "@/lib/api";
import { cn, generateTopicName } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { MemberPicker } from "@/components/workspace/MemberPicker";
import { TopicRailItem } from "./TopicRailItem";

/** Both sections create through the same control: a `+` in the section header.
 *  The two sections hold different kinds of thing, so what they create differs —
 *  but "add one of these" is one gesture, and it should not change shape between
 *  two lists sitting six pixels apart. Shared here rather than copied so the two
 *  cannot drift. */
const ADD_BUTTON_CLASS =
    "rounded-sm p-1 text-label-3 transition-colors hover:bg-fill-1 hover:text-label-1";

interface TopicRailProps {
    agentId: UUID;
    activeTopicId: UUID | undefined;
    /** Set when a Research is open. A Research and a Topic are never both
     *  active — they are two flat sections, not a path. */
    activeResearchId?: UUID | undefined;
    collapsed: boolean;
    onCollapsedChange: (next: boolean) => void;
}

/**
 * The left rail: create, list, and manage Topics for the one agent this app
 * has. Replaces the old room selector and app sidebar. What it deliberately
 * does not carry over from those two: per-agent grouping (there is one
 * agent), the floating collapsed-mode toggle workaround (this rail owns its
 * own collapse state via props), and the strategies link buried in a dialog
 * footer (it is a top-level entry here, at the bottom of the rail).
 *
 * Phase 2 adds a second section, `Research`, **flat and beside** `Topics` —
 * never nested inside it (spec §7.8). A Topic can belong to several
 * Researches, so nesting would print it once per Research and turn a list of
 * things into a list of paths. Membership is shown inside the Research view
 * and nowhere else.
 */
export function TopicRail({
    agentId,
    activeTopicId,
    activeResearchId,
    collapsed,
    onCollapsedChange,
}: TopicRailProps) {
    const { t } = useTranslation();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const navigate = useNavigate();

    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const { data, isPending } = useQuery({
        queryKey: ["topics", agentId],
        queryFn: () => apiClient.getTopics(agentId),
        refetchInterval: 30000,
        staleTime: 15000,
    });

    // Clone before sorting — never mutate the React Query cache in place.
    const topics = useMemo(() => {
        const list = [...(data?.topics ?? [])];
        list.sort((a: TopicSummary, b: TopicSummary) => {
            const aTime = a.lastMessage?.createdAt ?? a.createdAt;
            const bTime = b.lastMessage?.createdAt ?? b.createdAt;
            return bTime - aTime;
        });
        return list;
    }, [data]);

    const { data: researchData } = useQuery({
        queryKey: ["researches", agentId],
        queryFn: () => apiClient.getResearches(agentId),
        refetchInterval: 30000,
        staleTime: 15000,
    });
    const researches: ResearchSummary[] = useMemo(() => {
        const list = [...(researchData?.researches ?? [])];
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        return list;
    }, [researchData]);

    const refetchTopics = () => {
        queryClient.invalidateQueries({ queryKey: ["topics", agentId] });
    };

    // "+ compare" from the rail (spec §7.4). The Topic view's chart tab row
    // carries the same affordance, but a Topic with no charts has no tab row —
    // without this entry point such a Topic could never join a comparison.
    // The name is the server's job (members' leadSymbol-or-name joined by " · ").
    const handleCreateResearch = async (topicIds: string[]) => {
        try {
            const result = await apiClient.createResearch(agentId, { topicIds });
            void queryClient.invalidateQueries({ queryKey: ["researches", agentId] });
            navigate(`/research/${agentId}/${result.research.id}`);
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("research.createFailed"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        }
    };

    const handleCreate = async () => {
        try {
            const result = await apiClient.createTopic(agentId, generateTopicName());
            if (result.success) {
                refetchTopics();
            }
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("topics.new"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        }
    };

    const toggleSelected = (topicId: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(topicId)) next.delete(topicId);
            else next.add(topicId);
            return next;
        });
    };

    const handleBatchDelete = async () => {
        const ids = Array.from(selectedIds);
        try {
            await apiClient.batchDeleteTopics(agentId, ids);
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("topics.delete"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        } finally {
            setSelectedIds(new Set());
            setSelectionMode(false);
            refetchTopics();
        }
    };

    if (collapsed) {
        return (
            <aside
                className="flex h-full w-[56px] shrink-0 flex-col items-center gap-2 overflow-hidden border-r border-sep bg-background py-2"
                aria-label={t("topics.title")}
            >
                <button
                    type="button"
                    onClick={() => onCollapsedChange(false)}
                    aria-label={t("topics.expand")}
                    title={t("topics.expand")}
                    className="inline-flex size-8 items-center justify-center rounded-md text-label-2 transition-colors hover:bg-fill-1 hover:text-label-1"
                >
                    <PanelLeftOpen className="size-4" />
                </button>
                <div className="mt-1 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
                    {/* Collapsed Research rows: the diamond and the member
                        count, which is all 56px has room for (spec §7.8). */}
                    {researches.map((research) => (
                        <NavLink
                            key={research.id}
                            to={`/research/${agentId}/${research.id}`}
                            title={research.name}
                            className={cn(
                                "flex size-8 shrink-0 flex-col items-center justify-center rounded-md transition-colors",
                                research.id === activeResearchId
                                    ? "bg-fill-3 text-label-1"
                                    : "text-label-2 hover:bg-fill-1 hover:text-label-1",
                            )}
                        >
                            <span aria-hidden="true" className="text-[11px] leading-none">
                                ◇
                            </span>
                            <span className="fin-figure text-[9px] leading-none">{research.memberCount}</span>
                        </NavLink>
                    ))}
                    {researches.length > 0 && <div className="my-1 h-px w-6 shrink-0 bg-fill-2" aria-hidden="true" />}
                    {topics.map((topic) => (
                        <TopicRailItem
                            key={topic.id}
                            agentId={agentId}
                            topic={topic}
                            isActive={topic.id === activeTopicId}
                            collapsed
                            selectionMode={false}
                            selected={false}
                            onToggleSelected={() => {}}
                            onMutated={refetchTopics}
                        />
                    ))}
                </div>
                <NavLink
                    to={`/strategies/${agentId}`}
                    className={({ isActive }) =>
                        cn(
                            "inline-flex size-8 items-center justify-center rounded-md transition-colors",
                            isActive ? "bg-brand-sub text-label-1" : "text-label-2 hover:bg-fill-1 hover:text-label-1",
                        )
                    }
                    title={t("strategies.title")}
                    aria-label={t("strategies.title")}
                >
                    <TrendingUp className="size-4" />
                </NavLink>
            </aside>
        );
    }

    return (
        <aside
            className="flex h-full w-[240px] shrink-0 flex-col overflow-hidden border-r border-sep bg-background"
            aria-label={t("topics.title")}
        >
            <header className="flex shrink-0 items-center gap-2 border-b border-sep px-3 py-2.5">
                <div className="flex size-6 shrink-0 items-center justify-center rounded-[5px] bg-fill-3 text-[10px] font-bold text-label-1">
                    FA
                </div>
                <span className="fin-label flex-1 truncate text-label-2">{t("topics.title")}</span>
                <button
                    type="button"
                    onClick={() => onCollapsedChange(true)}
                    aria-label={t("topics.collapse")}
                    title={t("topics.collapse")}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-label-2 transition-colors hover:bg-fill-1 hover:text-label-1"
                >
                    <PanelLeftClose className="size-4" />
                </button>
            </header>

            <div className="group/topics flex min-h-0 flex-1 flex-col overflow-y-auto">
                {/* Section one: Research. Flat, above Topics, never wrapping them. */}
                <div className="flex items-center gap-2 px-2 pb-1 pt-2">
                    <span className="fin-label flex-1 truncate text-label-3">{t("research.title")}</span>
                    <MemberPicker
                        agentId={agentId}
                        excludeTopicIds={[]}
                        onConfirm={(topicIds) => void handleCreateResearch(topicIds)}
                        trigger={
                            <button
                                type="button"
                                aria-label={t("research.new")}
                                title={t("research.new")}
                                className={ADD_BUTTON_CLASS}
                            >
                                <Plus className="size-3.5" />
                            </button>
                        }
                    />
                </div>
                <div className="flex flex-col gap-0.5 px-1 pb-2">
                    {researches.length === 0 ? (
                        <div className="p-2 text-xs text-label-3">{t("research.empty")}</div>
                    ) : (
                        researches.map((research) => (
                            <NavLink
                                key={research.id}
                                to={`/research/${agentId}/${research.id}`}
                                title={research.name}
                                className={cn(
                                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                                    research.id === activeResearchId
                                        ? "bg-fill-3 text-label-1"
                                        : "text-label-2 hover:bg-fill-1 hover:text-label-1",
                                )}
                            >
                                <span aria-hidden="true" className="shrink-0 text-label-3">
                                    ◇
                                </span>
                                <span className="min-w-0 flex-1 truncate">{research.name}</span>
                                <span className="fin-figure shrink-0 text-[10px] text-label-3">
                                    {research.memberCount}
                                </span>
                            </NavLink>
                        ))
                    )}
                </div>

                {/* Section two: Topics. */}
                <div className="flex items-center gap-2 border-t border-sep px-2 pb-1 pt-2">
                    <span className="fin-label flex-1 truncate text-label-3">{t("topics.title")}</span>
                    {topics.length > 0 && (
                        <button
                            type="button"
                            aria-label={selectionMode ? t("topics.exitSelection") : t("topics.selectMultiple")}
                            onClick={() => {
                                setSelectionMode((prev) => !prev);
                                setSelectedIds(new Set());
                            }}
                            className="rounded-sm p-1 text-label-3 opacity-0 transition-opacity hover:bg-fill-1 hover:text-label-1 focus-visible:opacity-100 group-hover/topics:opacity-100 data-[state=open]:opacity-100"
                        >
                            {selectionMode ? <X className="size-3.5" /> : <CheckSquare className="size-3.5" />}
                        </button>
                    )}
                    {/* Last in the row, so it sits at the same x as the Research
                        section's — the two "add" affordances line up vertically
                        and read as one control repeated per section. */}
                    <button
                        type="button"
                        onClick={() => void handleCreate()}
                        aria-label={t("topics.new")}
                        title={t("topics.new")}
                        className={ADD_BUTTON_CLASS}
                    >
                        <Plus className="size-3.5" />
                    </button>
                </div>

                <div className="flex flex-col gap-0.5 px-1 pb-2">
                    {isPending ? (
                        <div className="p-2 text-xs text-label-3">{t("common.loading")}</div>
                    ) : topics.length === 0 ? (
                        <div className="p-2 text-xs text-label-3">{t("topics.empty")}</div>
                    ) : (
                        topics.map((topic) => (
                            <TopicRailItem
                                key={topic.id}
                                agentId={agentId}
                                topic={topic}
                                isActive={topic.id === activeTopicId}
                                collapsed={false}
                                selectionMode={selectionMode}
                                selected={selectedIds.has(topic.id)}
                                onToggleSelected={() => toggleSelected(topic.id)}
                                onMutated={refetchTopics}
                            />
                        ))
                    )}
                </div>
            </div>

            {selectionMode && selectedIds.size > 0 && (
                <div className="material mx-2 mb-2 rounded-lg border border-sep p-3 shadow-e2-rim">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                            {t("topics.selectedCount", { count: selectedIds.size })}
                        </span>
                        <Button size="sm" variant="destructive" onClick={handleBatchDelete}>
                            <Trash2 className="mr-1 size-4" />
                            {t("common.delete")}
                        </Button>
                    </div>
                </div>
            )}

            {/* Top-level entry, not a link buried in a dialog footer. */}
            <NavLink
                to={`/strategies/${agentId}`}
                className={({ isActive }) =>
                    cn(
                        "flex shrink-0 items-center gap-2.5 border-t border-sep px-3 py-2.5 text-left text-sm font-medium transition-colors",
                        isActive ? "bg-brand-sub text-label-1" : "text-label-1 hover:bg-fill-1",
                    )
                }
            >
                <TrendingUp className="size-4 shrink-0 text-label-2" />
                {t("strategies.title")}
            </NavLink>
        </aside>
    );
}
