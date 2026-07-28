import { useState } from "react";
import { Power, AlertOctagon } from "lucide-react";
import { toast } from "sonner";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    useToggleKillSwitch,
    useTradingPreferences,
} from "@/hooks/useTradingPreferences";

interface KillSwitchToggleProps {
    /** "compact" hides the label and shows only the power icon. */
    variant?: "compact" | "full";
    className?: string;
}

/**
 * §7.2 — Kill-switch toggle. Red, prominent, with a double-confirm modal
 * (type STOP) when transitioning OFF → ON. Turning the switch back OFF is
 * a single click — we want it easy to recover.
 */
export function KillSwitchToggle({ variant = "full", className }: KillSwitchToggleProps) {
    const prefs = useTradingPreferences();
    const toggle = useToggleKillSwitch();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [stopText, setStopText] = useState("");
    const [reason, setReason] = useState("");

    const active = prefs.data?.kill_switch_active ?? false;

    const handleClick = () => {
        if (!active) {
            setConfirmOpen(true);
            setStopText("");
            setReason("");
        } else {
            // Turning OFF — single click is fine; recovery should be easy.
            toggle.mutate(
                { active: false },
                {
                    onSuccess: () => {
                        toast.success("Kill switch OFF — trading resumed");
                    },
                    onError: (err) => {
                        toast.error(
                            `Failed to toggle kill switch: ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        );
                    },
                },
            );
        }
    };

    const confirmActivate = () => {
        if (stopText.trim().toUpperCase() !== "STOP") return;
        toggle.mutate(
            { active: true, reason: reason || undefined },
            {
                onSuccess: () => {
                    setConfirmOpen(false);
                    toast.warning("Kill switch ON — all new trades will be refused");
                },
                onError: (err) => {
                    toast.error(
                        `Failed to activate kill switch: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                },
            },
        );
    };

    return (
        <>
            <button
                type="button"
                onClick={handleClick}
                aria-pressed={active}
                aria-label={active ? "Disable kill switch" : "Activate kill switch"}
                data-testid="kill-switch-toggle"
                title={
                    active
                        ? "Kill switch ON — click to resume trading"
                        : "Activate kill switch — refuses all new trades"
                }
                className={cn(
                    "inline-flex items-center gap-2 px-3 py-1.5 rounded-md ring-1 transition-colors",
                    active
                        ? "bg-rose-600/30 ring-rose-400/60 text-rose-100 hover:bg-rose-600/40"
                        : "bg-emerald-600/15 ring-emerald-400/40 text-emerald-200 hover:bg-emerald-600/25",
                    className,
                )}
            >
                <Power
                    className={cn(
                        "size-4",
                        active && "animate-pulse",
                    )}
                />
                {variant === "full" && (
                    <span className="text-xs font-medium">
                        {active ? "STOP ALL" : "Kill switch"}
                    </span>
                )}
            </button>

            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-rose-300">
                            <AlertOctagon className="size-5" />
                            Activate kill switch
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 text-sm text-white/80">
                        <p>
                            This refuses <strong>all</strong> new write actions (create / cancel / amend) until you turn it off.
                            Open positions are not affected.
                        </p>
                        <div className="space-y-1">
                            <label htmlFor="killswitch-stop" className="block text-xs text-white/50">
                                Type <code>STOP</code> to confirm
                            </label>
                            <Input
                                id="killswitch-stop"
                                value={stopText}
                                onChange={(e) => setStopText(e.target.value)}
                                placeholder="STOP"
                                autoFocus
                            />
                        </div>
                        <div className="space-y-1">
                            <label htmlFor="killswitch-reason" className="block text-xs text-white/50">
                                Reason (optional, for audit log)
                            </label>
                            <Input
                                id="killswitch-reason"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="e.g. unexpected behavior"
                            />
                        </div>
                        <div className="flex gap-2 justify-end pt-2">
                            <Button
                                variant="outline"
                                onClick={() => setConfirmOpen(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                disabled={
                                    stopText.trim().toUpperCase() !== "STOP" || toggle.isPending
                                }
                                onClick={confirmActivate}
                                className="bg-rose-600 hover:bg-rose-700 text-white"
                            >
                                {toggle.isPending ? "Activating…" : "Activate"}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
