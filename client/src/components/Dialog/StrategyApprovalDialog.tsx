import { useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
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
import { ModeBadge } from "@/components/cex/ModeBadge";

export interface StrategyApprovalDialogData {
    threadId: string;
    approvalId: string;
    strategy_id: string;
    summary?: string;
    mode?: "paper" | "shadow" | "live";
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
                className="max-w-2xl gap-0 overflow-hidden border-white/15 bg-slate-950/92 p-0 text-white shadow-2xl"
                data-testid="strategy-approval-dialog"
            >
                <DialogHeader className="border-b border-white/10 px-5 py-4 text-left">
                    <div className="flex flex-wrap items-center gap-2">
                        <DialogTitle className="text-base font-semibold">
                            Approve Strategy Activation
                        </DialogTitle>
                        <ModeBadge mode={mode} />
                    </div>
                    <DialogDescription className="text-sm text-slate-300">
                        {name}
                    </DialogDescription>
                </DialogHeader>

                <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2">
                            <div className="text-[11px] uppercase text-slate-400">Strategy ID</div>
                            <div className="mt-1 truncate font-mono text-xs text-slate-100" title={data.strategy_id}>
                                {data.strategy_id}
                            </div>
                        </div>
                        <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2">
                            <div className="text-[11px] uppercase text-slate-400">Symbol</div>
                            <div className="mt-1 font-mono text-sm text-slate-100">
                                {strategy?.symbol ?? "-"}
                            </div>
                        </div>
                        <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2">
                            <div className="text-[11px] uppercase text-slate-400">Phases</div>
                            <div className="mt-1 font-mono text-sm text-slate-100">
                                {data.phases ?? phases.length}
                            </div>
                        </div>
                    </div>

                    {mode === "live" && (
                        <div className="flex gap-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-3 text-amber-50">
                            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                            <div className="text-sm">
                                Live activation can submit real exchange orders whenever strategy conditions are met.
                            </div>
                        </div>
                    )}

                    {summary && (
                        <section className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-3">
                            <h3 className="text-xs font-medium uppercase text-slate-400">Summary</h3>
                            <p className="mt-2 text-sm leading-6 text-slate-100">{summary}</p>
                        </section>
                    )}

                    {phases.length > 0 && (
                        <section className="space-y-2">
                            <h3 className="text-xs font-medium uppercase text-slate-400">Execution Phases</h3>
                            {phases.map((phase, index) => (
                                <div
                                    key={phase.id ?? `${phase.name}-${index}`}
                                    className={cn("rounded-md border px-3 py-3", phaseTone(phase))}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-medium">{phase.name}</div>
                                            <div className="mt-1 text-xs leading-5 text-slate-200">
                                                {summarizePhase(phase)}
                                            </div>
                                        </div>
                                        <span className="shrink-0 rounded-md bg-white/10 px-2 py-1 font-mono text-xs">
                                            {String(index + 1).padStart(2, "0")}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}
                </div>

                <DialogFooter className="gap-2 border-t border-white/10 px-5 py-4 sm:space-x-0">
                    <Button
                        type="button"
                        variant="outline"
                        className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
                        disabled={submitting !== null}
                        onClick={() => void submit("reject")}
                    >
                        <X className="size-4" />
                        Reject
                    </Button>
                    <Button
                        type="button"
                        className="bg-emerald-500 text-slate-950 hover:bg-emerald-400"
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
