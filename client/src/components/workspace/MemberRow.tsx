import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UUID } from "@/types/core";
import { cn } from "@/lib/utils";
import { MemberPicker } from "@/components/workspace/MemberPicker";

/** Truncate a display name to `max` characters, ellipsis-suffixed — the full
 *  name always still travels through `title`. */
function truncateName(name: string, max: number): string {
    return name.length > max ? `${name.slice(0, max)}…` : name;
}

/**
 * One Research member as the row needs it: enough to render the chip, not
 * the full `ResearchMember`/`TopicSummary` shape. `chartCount` in particular
 * has no home on `TopicSummary` — the parent derives it (e.g. from
 * `useTopicCharts` per member) and passes it down.
 */
export interface MemberChip {
    id: UUID;
    name: string;
    leadSymbol: string | null;
    chartCount: number;
}

/** One-shot highlight trigger for an agent-driven `focus` change (spec
 *  §7.5). `token` must change even when `memberId` repeats, so a second
 *  focus on the same member still replays the ring. */
export interface MemberFocusSignal {
    memberId: string;
    token: number;
}

const FOCUS_HIGHLIGHT_MS = 600;

/**
 * The member chip row (spec §7.2). Deliberately **pill**-shaped
 * (`rounded-full`) where `ChartTabBar`'s tabs are square `fin-figure`
 * chips — the two rows sit directly on top of each other, and that shape
 * difference is the only thing telling the user "you are switching who you
 * are comparing" vs. "you are switching which chart you are looking at".
 * Do not reconcile the two vocabularies.
 *
 * Holds no data fetching beyond what `MemberPicker` needs to list
 * candidate Topics — membership, selection, and removal all travel through
 * props/callbacks so the parent stays the one source of truth.
 */
export function MemberRow({
    agentId,
    members,
    activeMemberId,
    onSelectMember,
    onRemoveMember,
    onAddMembers,
    focusSignal,
}: {
    agentId: UUID;
    members: MemberChip[];
    activeMemberId: string | undefined;
    onSelectMember: (memberId: string) => void;
    onRemoveMember: (memberId: string) => void;
    /** Called with the freshly chosen topic ids from the picker — the parent unions them with the current membership before the whole-set PUT. */
    onAddMembers: (topicIds: string[]) => void;
    /** Set by the parent when the controller agent moves focus via `focus` — transient, no undo affordance (spec §7.5). */
    focusSignal?: MemberFocusSignal | null;
}) {
    const { t } = useTranslation();
    const [highlightedId, setHighlightedId] = useState<string | null>(null);

    useEffect(() => {
        if (!focusSignal) return;
        setHighlightedId(focusSignal.memberId);
        const timer = setTimeout(() => setHighlightedId(null), FOCUS_HIGHLIGHT_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusSignal?.memberId, focusSignal?.token]);

    return (
        <div
            className="custom-scrollbar flex items-center gap-1.5 overflow-x-auto pb-1"
            role="tablist"
            aria-label={t("workspace.memberRow.label")}
        >
            {members.map((member) => {
                const isActive = member.id === activeMemberId;
                const isHighlighted = member.id === highlightedId;
                const label = member.leadSymbol ?? truncateName(member.name, 12);
                return (
                    <div
                        key={member.id}
                        className={cn(
                            "group/chip relative flex shrink-0 items-center gap-1 rounded-full border pl-2.5 pr-1.5 py-1 transition-shadow duration-500 ease-out",
                            isActive
                                ? "border-transparent bg-fill-3 text-label-1"
                                : "border-sep bg-fill-1 text-label-3 hover:text-label-1",
                            isHighlighted && "ring-2 ring-brand ring-offset-1 ring-offset-canvas",
                        )}
                    >
                        <span
                            className="absolute -right-1 -top-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-sep bg-fill-2 fin-figure text-[8px] font-semibold text-label-2"
                            aria-hidden="true"
                        >
                            {member.chartCount}
                        </span>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            onClick={() => onSelectMember(member.id)}
                            className="fin-figure flex items-center text-xs font-semibold tracking-wide"
                            title={member.name}
                        >
                            {label}
                        </button>
                        <button
                            type="button"
                            onClick={() => onRemoveMember(member.id)}
                            className="flex size-4 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity hover:bg-fill-2 focus-visible:opacity-100 group-hover/chip:opacity-100"
                            aria-label={t("workspace.memberRow.remove", { name: member.name })}
                            title={t("workspace.memberRow.remove", { name: member.name })}
                        >
                            <X className="size-3" />
                        </button>
                    </div>
                );
            })}

            <MemberPicker
                agentId={agentId}
                excludeTopicIds={members.map((member) => member.id)}
                onConfirm={onAddMembers}
                trigger={
                    <button
                        type="button"
                        className="flex size-[26px] shrink-0 items-center justify-center rounded-full border border-dashed border-sep text-label-3 transition-colors hover:border-label-3 hover:bg-fill-1 hover:text-label-1"
                        aria-label={t("workspace.memberRow.addMember")}
                        title={t("workspace.memberRow.addMember")}
                    >
                        <Plus className="size-3.5" />
                    </button>
                }
            />
        </div>
    );
}
