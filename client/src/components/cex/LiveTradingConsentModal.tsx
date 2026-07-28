import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";

// Inline the consent text via raw import. Vite handles `?raw`.
import consentTextV1 from "@/content/consent/liveTrading.v1.md?raw";

const CONSENT_TYPE = "live_trading_tos";
const CONSENT_VERSION = "v1";

interface LiveTradingConsentModalProps {
    /** Controlled-open flag. Omit to use the global event-driven mode. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onAccepted?: () => void;
}

export const LIVE_TRADING_CONSENT_OPEN_EVENT =
    "financial-agent:open-live-trading-consent";
export const LIVE_TRADING_CONSENT_ACCEPTED_EVENT =
    "financial-agent:live-trading-consent-accepted";

/**
 * §7.8 — Live-trading consent modal. Gates the live-mode toggle in Settings
 * and (when integrated) the first live order. Acceptance writes to
 * `consent_log` via `POST /user/consent`; the row is keyed on
 * `(userId, consent_type, version)` so repeated accepts are idempotent.
 *
 * Mount once at app root with no props for the event-driven mode: any
 * caller can dispatch `LIVE_TRADING_CONSENT_OPEN_EVENT` to bring it up
 * and listen for `LIVE_TRADING_CONSENT_ACCEPTED_EVENT` to complete the
 * flow. Controlled-open mode (props) is still supported for tests.
 */
export function LiveTradingConsentModal({
    open: controlledOpen,
    onOpenChange,
    onAccepted,
}: LiveTradingConsentModalProps = {}) {
    const [internalOpen, setInternalOpen] = useState(false);
    const open = controlledOpen ?? internalOpen;
    const [agreed, setAgreed] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (controlledOpen !== undefined) return;
        function handler() {
            setInternalOpen(true);
        }
        window.addEventListener(LIVE_TRADING_CONSENT_OPEN_EVENT, handler);
        return () => {
            window.removeEventListener(LIVE_TRADING_CONSENT_OPEN_EVENT, handler);
        };
    }, [controlledOpen]);

    const setOpen = (next: boolean) => {
        if (controlledOpen === undefined) setInternalOpen(next);
        onOpenChange?.(next);
    };

    useEffect(() => {
        if (!open) setAgreed(false);
    }, [open]);

    const accept = async () => {
        if (!agreed) return;
        setSubmitting(true);
        try {
            const res = await apiClient.recordConsent(CONSENT_TYPE, CONSENT_VERSION);
            if (!res.success) {
                toast.error("Failed to record consent");
                return;
            }
            toast.success("Consent recorded — live mode unlocked");
            onAccepted?.();
            window.dispatchEvent(
                new CustomEvent(LIVE_TRADING_CONSENT_ACCEPTED_EVENT, {
                    detail: { version: CONSENT_VERSION },
                }),
            );
            setOpen(false);
        } catch (err) {
            toast.error(
                `Failed to record consent: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-2xl" data-testid="live-trading-consent-modal">
                <DialogHeader>
                    <DialogTitle>Live trading consent ({CONSENT_VERSION})</DialogTitle>
                </DialogHeader>
                <div className="prose prose-invert prose-sm max-w-none max-h-[60vh] overflow-y-auto whitespace-pre-wrap">
                    {consentTextV1}
                </div>
                <label className="flex items-start gap-2 mt-3 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={agreed}
                        onChange={(e) => setAgreed(e.target.checked)}
                        className="mt-1"
                    />
                    <span className="text-sm">
                        I have read and accept the live-trading risk disclosure ({CONSENT_VERSION}).
                    </span>
                </label>
                <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" onClick={() => setOpen(false)}>
                        Cancel
                    </Button>
                    <Button disabled={!agreed || submitting} onClick={accept}>
                        {submitting ? "Recording…" : "I Accept"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
