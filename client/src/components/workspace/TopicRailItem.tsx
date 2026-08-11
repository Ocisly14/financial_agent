import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { Edit, MoreVertical, Tag, Trash2 } from "lucide-react";
import { TOPIC_CATEGORIES, type TopicCategory, type TopicSummary, type UUID } from "@/types/core";
import { apiClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { markdownPreviewText } from "@/lib/semanticMarks";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type RowMode = "idle" | "renaming";

interface TopicRailItemProps {
    agentId: UUID;
    topic: TopicSummary;
    isActive: boolean;
    /** Rail is at its 56px width — render only the ticker badge. */
    collapsed: boolean;
    selectionMode: boolean;
    selected: boolean;
    onToggleSelected: () => void;
    /** Called after any successful mutation so the parent can refetch the list. */
    onMutated: () => void;
}

/**
 * One row: the fin-figure ticker chip (derived from the topic's charts —
 * absent for topics with no chart tabs), the topic name, and a single-line
 * preview of the last message. The row's own dropdown carries rename, category
 * and delete. Binding a SYMBOL is still not one of them: that intent belongs to
 * the chart tab bar (`ChartTabBar`), because a symbol is a statement about what
 * the topic charts. A category is a statement about what the topic IS — it has
 * no other home, and overriding the model's guess has to be possible from
 * wherever that guess is visible, which is here.
 */
export function TopicRailItem({
    agentId,
    topic,
    isActive,
    collapsed,
    selectionMode,
    selected,
    onToggleSelected,
    onMutated,
}: TopicRailItemProps) {
    const { t } = useTranslation();
    const { toast } = useToast();
    const [mode, setMode] = useState<RowMode>("idle");
    const [draftName, setDraftName] = useState(topic.name);

    const badge = topic.leadSymbol ? (
        <span
            className={cn(
                "fin-figure inline-flex h-5 shrink-0 items-center justify-center rounded-[4px] border px-1.5 text-[10px] font-semibold tracking-wide",
                isActive
                    ? "border-transparent bg-fill-3 text-label-1"
                    : "border-sep bg-fill-1 text-label-2",
            )}
        >
            {topic.leadSymbol}
        </span>
    ) : null;

    const commitRename = async () => {
        const trimmed = draftName.trim();
        if (!trimmed) {
            setDraftName(topic.name);
            setMode("idle");
            return;
        }
        setMode("idle");
        if (trimmed === topic.name) return;
        try {
            await apiClient.updateTopic(agentId, topic.id, { name: trimmed });
            onMutated();
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("topics.rename"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        }
    };

    /** `null` hands the topic back to the background classifier. */
    const setCategory = async (category: TopicCategory | null) => {
        try {
            await apiClient.updateTopic(agentId, topic.id, { category });
            onMutated();
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("topics.setCategory"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        }
    };

    const handleDelete = async () => {
        try {
            await apiClient.deleteTopic(agentId, topic.id);
            onMutated();
        } catch (error) {
            toast({
                variant: "destructive",
                title: t("topics.delete"),
                description: error instanceof Error ? error.message : t("common.unexpectedError"),
            });
        }
    };

    if (collapsed) {
        return (
            <NavLink
                to={`/topic/${agentId}/${topic.id}`}
                className={cn(
                    "flex items-center justify-center rounded-md py-1.5 transition-colors",
                    isActive ? "bg-brand-sub" : "hover:bg-fill-1",
                )}
                title={topic.leadSymbol ?? topic.name}
            >
                {badge ?? (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-fill-1 text-[10px] font-semibold text-label-3">
                        {topic.name.trim().charAt(0).toUpperCase() || "?"}
                    </span>
                )}
            </NavLink>
        );
    }

    if (mode === "renaming") {
        return (
            <div className="px-2 py-1">
                <Input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") {
                            setDraftName(topic.name);
                            setMode("idle");
                        }
                    }}
                    onBlur={commitRename}
                    className="h-8 text-sm"
                />
            </div>
        );
    }

    return (
        <div className="group flex items-center gap-1">
            {selectionMode && (
                <div className="pl-2">
                    <Checkbox checked={selected} onCheckedChange={onToggleSelected} />
                </div>
            )}
            {selectionMode ? (
                <button
                    type="button"
                    onClick={onToggleSelected}
                    className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-md p-2 text-left transition-colors",
                        selected ? "bg-brand-sub" : "hover:bg-fill-1",
                    )}
                >
                    {badge}
                    <RowText topic={topic} />
                </button>
            ) : (
                <NavLink
                    to={`/topic/${agentId}/${topic.id}`}
                    className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-md border-l-2 p-2 text-left transition-colors",
                        isActive
                            ? "border-brand bg-brand-sub text-label-1"
                            : "border-transparent hover:bg-fill-1",
                    )}
                >
                    {badge}
                    <RowText topic={topic} />
                </NavLink>
            )}
            {!selectionMode && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            aria-label={t("topics.rename")}
                            className="shrink-0 rounded-sm p-1 text-label-3 opacity-0 transition-opacity hover:bg-fill-1 hover:text-label-1 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                        >
                            <MoreVertical className="size-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem
                            onClick={() => {
                                setDraftName(topic.name);
                                setMode("renaming");
                            }}
                        >
                            <Edit className="mr-2 size-4" />
                            {t("topics.rename")}
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Tag className="mr-2 size-4" />
                                {t("topics.setCategory")}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {/* A radio group, not plain items: the category is
                                    single-valued and the current one must be legible
                                    without the user having to remember it. "Automatic"
                                    is the selected row precisely when nothing is
                                    locked, so an unclassified topic and one the model
                                    has classified read the same way here — in both
                                    cases the model still owns the choice. */}
                                <DropdownMenuRadioGroup
                                    value={topic.categoryLocked && topic.category ? topic.category : "auto"}
                                    onValueChange={(value) =>
                                        void setCategory(value === "auto" ? null : (value as TopicCategory))
                                    }
                                >
                                    <DropdownMenuRadioItem value="auto">
                                        {t("topics.categoryAuto")}
                                        {topic.category && !topic.categoryLocked && (
                                            <span className="ml-1.5 text-label-3">
                                                ({t(`topics.categories.${topic.category}`)})
                                            </span>
                                        )}
                                    </DropdownMenuRadioItem>
                                    <DropdownMenuSeparator />
                                    {TOPIC_CATEGORIES.map((category) => (
                                        <DropdownMenuRadioItem key={category} value={category}>
                                            {t(`topics.categories.${category}`)}
                                        </DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={handleDelete} className="text-destructive">
                            <Trash2 className="mr-2 size-4" />
                            {t("topics.delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}

function RowText({ topic }: { topic: TopicSummary }) {
    const preview = topic.lastMessage ? markdownPreviewText(topic.lastMessage.text) : "";
    return (
        <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{topic.name}</span>
            {preview && <span className="truncate text-label-3">{preview}</span>}
        </div>
    );
}
