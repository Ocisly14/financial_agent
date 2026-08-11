import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import type { StoredStrategy, StrategyPhase } from "@/types/core";
import { cn } from "@/lib/utils";
import { summarizePhase } from "@/lib/strategySummary";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

export interface StrategyApprovalDialogData {
    threadId: string;
    approvalId: string;
    strategy_id: string;
    summary?: string;
    mode?: "paper" | "shadow";
    phases?: number;
    strategy?: StoredStrategy;
}

export interface StrategyApprovalDialogProps {
    isOpen: boolean;
    data: StrategyApprovalDialogData;
    onApprove: () => Promise<void> | void;
    onReject: () => Promise<void> | void;
}

function phaseTone(phase: StrategyPhase): string {
    return phase.action.side === "BUY"
        ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-50"
        : "border-rose-400/25 bg-rose-500/10 text-rose-50";
}

function ModeBadge({ mode }: { mode: "paper" | "shadow" }) {
    const label = mode === "paper" ? "Paper" : "Shadow";
    return (
        <span className="rounded-md border border-sky-400/25 bg-sky-500/10 px-2 py-1 text-xs font-medium uppercase tracking-wide text-sky-100">
            {label}
        </span>
    );
}

export function StrategyApprovalDialog({
    isOpen,
    data,
    onApprove,
    onReject,
}: StrategyApprovalDialogProps) {
    const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null);
    const strategy = data.strategy;
    const dsl = strategy?.dsl;
    const mode = data.mode ?? dsl?.mode ?? "paper";
    const phases = useMemo(() => dsl?.phases ?? [], [dsl]);
    const summary = data.summary || (dsl ? phases.map(summarizePhase).join(" | ") : "");
    const name = dsl?.name || strategy?.symbol || data.strategy_id;

    const submit = async (decision: "approve" | "reject") => {
        if (submitting) return;
        setSubmitting(decision);
        try {
            await (decision === "approve" ? onApprove() : onReject());
        } catch {
            setSubmitting(null);
        }
    };

    return (
        <Dialog open={isOpen}>
            <DialogContent
                hideCloseButton
                className="max-w-2xl gap-0 overflow-hidden border-sep bg-raised p-0 text-label-1 shadow-e3-rim"
                data-testid="strategy-approval-dialog"
            >
                <DialogHeader className="border-b border-sep px-5 py-4 text-left">
                    <div className="flex flex-wrap items-center gap-2">
                        <DialogTitle className="text-base font-semibold">
                            Approve Strategy Activation
                        </DialogTitle>
                        <ModeBadge mode={mode} />
                    </div>
                    <DialogDescription className="text-sm text-label-2">
                        {name}
                    </DialogDescription>
                </DialogHeader>

                <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-md border border-sep bg-fill-1 px-3 py-2">
                            <div className="fin-label text-label-3">Strategy ID</div>
                            <div className="fin-figure mt-1 truncate text-xs text-label-1" title={data.strategy_id}>
                                {data.strategy_id}
                            </div>
                        </div>
                        <div className="rounded-md border border-sep bg-fill-1 px-3 py-2">
                            <div className="fin-label text-label-3">Symbol</div>
                            <div className="fin-figure mt-1 text-sm text-label-1">
                                {strategy?.symbol ?? "-"}
                            </div>
                        </div>
                        <div className="rounded-md border border-sep bg-fill-1 px-3 py-2">
                            <div className="fin-label text-label-3">Phases</div>
                            <div className="fin-figure mt-1 text-sm text-label-1">
                                {data.phases ?? phases.length}
                            </div>
                        </div>
                    </div>

                    {summary && (
                        <section className="rounded-md border border-sep bg-fill-1 px-3 py-3">
                            <h3 className="fin-label text-label-3">Summary</h3>
                            <p className="mt-2 text-sm leading-6 text-label-1">{summary}</p>
                        </section>
                    )}

                    {phases.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="fin-label text-label-3">Execution Phases</h3>
                            {phases.map((phase, index) => (
                                <div
                                    key={phase.id ?? `${phase.name}-${index}`}
                                    className={cn("rounded-md border px-3 py-3", phaseTone(phase))}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-medium">{phase.name}</div>
                                            <div className="mt-1 text-xs leading-5 text-label-2">
                                                {summarizePhase(phase)}
                                            </div>
                                        </div>
                                        <span className="fin-figure shrink-0 rounded-sm bg-fill-2 px-2 py-1 text-xs">
                                            {String(index + 1).padStart(2, "0")}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}
                </div>

                <DialogFooter className="gap-2 border-t border-sep px-5 py-4 sm:space-x-0">
                    <Button
                        type="button"
                        variant="outline"
                        className="border-sep bg-fill-1 text-label-1 hover:bg-fill-2 hover:text-label-1"
                        disabled={submitting !== null}
                        onClick={() => void submit("reject")}
                    >
                        <X className="size-4" />
                        Reject
                    </Button>
                    <Button
                        type="button"
                        className="bg-brand text-white hover:bg-brand/90"
                        disabled={submitting !== null}
                        onClick={() => void submit("approve")}
                    >
                        <Check className="size-4" />
                        Activate
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
