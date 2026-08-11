import { Languages, PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TopicSummary } from "@/types/core";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ModeChip, useTradingMode } from "@/components/workspace/ModeChip";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

/**
 * The one strip that runs across every topic. Only real signals live here —
 * see spec §8. No market clock, no P&L, no account equity: there is no data
 * source behind any of them, and a fake one becomes a promise that has to be
 * torn out in phase 2.
 *
 * `topic` is optional so the bar can render during the brief window before
 * the active topic has resolved (e.g. list still loading).
 *
 * `onOpenRail` is only supplied below 1024px, where the rail has left the
 * document flow and become an off-canvas sheet (spec §7); the button does not
 * exist at wider sizes, where the rail is always on screen.
 *
 * `research`, when present, replaces the topic identity entirely: a Research
 * shows its own name and its member count and **no `leadSymbol`** (spec §7.6).
 * With several members no single ticker represents the whole, and showing the
 * focused member's would make the bar flicker between symbols every time the
 * agent moved focus — the bar would then be reporting the view, not the thing.
 */
export function StatusBar({
    topic,
    research,
    isConnected,
    onOpenRail,
}: {
    topic: TopicSummary | undefined;
    research?: { name: string; memberCount: number } | undefined;
    isConnected: boolean;
    onOpenRail?: () => void;
}) {
    const { t } = useTranslation();
    const { language, setLanguage } = useLanguage();
    const mode = useTradingMode();

    return (
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-sep bg-surface px-3">
            <div className="flex min-w-0 items-center gap-2">
                {onOpenRail && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("topics.openRail")}
                        onClick={onOpenRail}
                        className="size-[26px] shrink-0 rounded-[5px] text-label-2 hover:bg-fill-1"
                    >
                        <PanelLeft className="size-3.5" />
                    </Button>
                )}
                {research ? (
                    <>
                        <span className="shrink-0 text-label-3" aria-hidden="true">
                            ◇
                        </span>
                        <span className="truncate text-sm font-medium text-label-1">{research.name}</span>
                        <span className="fin-label shrink-0 text-label-3">
                            · {t("research.memberCount", { count: research.memberCount })}
                        </span>
                    </>
                ) : topic ? (
                    <>
                        <span className="truncate text-sm font-medium text-label-1">{topic.name}</span>
                        {topic.leadSymbol && (
                            <span className="fin-figure inline-flex h-5 shrink-0 items-center justify-center rounded-[4px] border border-sep bg-fill-1 px-1.5 text-[10px] font-semibold tracking-wide text-label-2">
                                {topic.leadSymbol}
                            </span>
                        )}
                    </>
                ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-3">
                <span className="fin-label inline-flex items-center gap-1.5 text-label-3">
                    <span
                        className={cn("size-1.5 shrink-0 rounded-full", isConnected ? "bg-up" : "bg-down")}
                        aria-hidden="true"
                    />
                    {isConnected ? t("workspace.statusBar.live") : t("workspace.statusBar.disconnected")}
                </span>

                <ModeChip mode={mode} />

                <ThemeToggle className="size-[26px] rounded-[5px] text-label-2 hover:bg-fill-1" />

                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("workspace.statusBar.toggleLanguage")}
                    onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")}
                    className="size-[26px] rounded-[5px] text-label-2 hover:bg-fill-1"
                >
                    <Languages className="size-3.5" />
                </Button>
            </div>
        </div>
    );
}
