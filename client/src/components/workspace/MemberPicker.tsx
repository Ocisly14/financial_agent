import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { TopicSummary, UUID } from "@/types/core";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The one member-selection dropdown, shared by two trigger sites (spec
 * §7.4): the trailing "+" on the member row (add to an existing Research)
 * and the "+ Compare" affordance on `ChartTabBar` (spin up a new Research from
 * a Topic view). Both sites decide what to do with the chosen ids —
 * this component only lists, filters, multi-selects, and hands them back.
 *
 * It fetches its own Topic list (the one piece of data-fetching this task's
 * components are allowed) because both call sites need the same "agent's
 * Topics, most-recently-active first, minus whoever is already a member"
 * query, and duplicating that in each caller would drift.
 *
 * `onConfirm` receives only the newly *selected* topic ids — not merged
 * with `excludeTopicIds`. The membership PUT is a whole-set overwrite (see
 * `apiClient.setResearchMembers`), so the caller is the one place that
 * knows whether to union these ids with an existing membership list or use
 * them standalone (e.g. `createResearch`'s topicIds). Baking a merge
 * policy in here would guess wrong for one of the two call sites.
 */
export function MemberPicker({
    tenantId,
    excludeTopicIds,
    onConfirm,
    trigger,
    align = "start",
}: {
    tenantId: UUID;
    /** Topic ids to hide from the list — typically the Research's/Topic's current members. */
    excludeTopicIds: string[];
    onConfirm: (topicIds: string[]) => void;
    /** The element that opens the dropdown — each call site styles its own. */
    trigger: React.ReactNode;
    align?: "start" | "end";
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const { data, isPending } = useQuery({
        queryKey: ["topics", tenantId],
        queryFn: () => apiClient.getTopics(tenantId),
        enabled: open,
        staleTime: 15000,
    });

    const excluded = useMemo(() => new Set(excludeTopicIds), [excludeTopicIds]);

    const candidates = useMemo(() => {
        const list = (data?.topics ?? []).filter((topic: TopicSummary) => !excluded.has(topic.id));
        list.sort((a: TopicSummary, b: TopicSummary) => {
            const aTime = a.lastMessage?.createdAt ?? a.createdAt;
            const bTime = b.lastMessage?.createdAt ?? b.createdAt;
            return bTime - aTime;
        });
        const needle = filter.trim().toLowerCase();
        if (!needle) return list;
        return list.filter((topic: TopicSummary) => topic.name.toLowerCase().includes(needle));
    }, [data, excluded, filter]);

    const toggle = (topicId: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(topicId)) next.delete(topicId);
            else next.add(topicId);
            return next;
        });
    };

    const reset = () => {
        setFilter("");
        setSelected(new Set());
    };

    const handleOpenChange = (next: boolean) => {
        setOpen(next);
        if (!next) reset();
    };

    const handleConfirm = () => {
        if (selected.size === 0) return;
        onConfirm(Array.from(selected));
        setOpen(false);
        reset();
    };

    return (
        <DropdownMenu open={open} onOpenChange={handleOpenChange}>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            <DropdownMenuContent
                align={align}
                className="w-64 p-0"
                onCloseAutoFocus={(event) => event.preventDefault()}
            >
                <div className="border-b border-sep p-2">
                    <Input
                        autoFocus
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder={t("workspace.memberPicker.filterPlaceholder")}
                        className="h-7 text-sm"
                        onKeyDown={(event) => event.stopPropagation()}
                    />
                </div>

                <div className="custom-scrollbar max-h-64 overflow-y-auto p-1">
                    {isPending ? (
                        <div className="p-2 text-xs text-label-3">{t("common.loading")}</div>
                    ) : candidates.length === 0 ? (
                        <div className="p-2 text-xs text-label-3">{t("workspace.memberPicker.empty")}</div>
                    ) : (
                        candidates.map((topic: TopicSummary) => {
                            const isChecked = selected.has(topic.id);
                            return (
                                <button
                                    key={topic.id}
                                    type="button"
                                    onClick={() => toggle(topic.id)}
                                    className={cn(
                                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                                        isChecked ? "bg-fill-2 text-label-1" : "text-label-2 hover:bg-fill-1",
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                                            isChecked ? "border-transparent bg-fill-3" : "border-sep",
                                        )}
                                        aria-hidden="true"
                                    >
                                        {isChecked && <Check className="size-2.5 text-label-1" />}
                                    </span>
                                    {topic.leadSymbol && (
                                        <span className="fin-figure shrink-0 text-[10px] font-semibold tracking-wide text-label-3">
                                            {topic.leadSymbol}
                                        </span>
                                    )}
                                    <span className="min-w-0 flex-1 truncate">{topic.name}</span>
                                </button>
                            );
                        })
                    )}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-sep p-2">
                    <span className="text-xs text-label-3">
                        {t("workspace.memberPicker.selectedCount", { count: selected.size })}
                    </span>
                    <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={selected.size === 0}
                        className="rounded-[5px] bg-fill-3 px-2.5 py-1 text-xs font-semibold text-label-1 transition-opacity disabled:opacity-40"
                    >
                        {t("workspace.memberPicker.confirm")}
                    </button>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
