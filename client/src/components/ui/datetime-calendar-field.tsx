import { useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker, type Matcher } from "react-day-picker";
import { Calendar } from "lucide-react";

import { cn } from "@/lib/utils";

import "react-day-picker/style.css";

export type DatetimeCalendarFieldProps = {
    valueStr: string;
    onChange: (isoUtc: string) => void;
    /** Inclusive calendar-day lower bound (local midnight). Ignored if minNow is true. */
    minDate?: Date;
    /** Inclusive calendar-day upper bound (local end of day). */
    maxDate?: Date;
    /** When true, calendar cannot select days before today (local). */
    minNow?: boolean;
    placeholder?: string;
    disabled?: boolean;
};

function parseIsoToDate(value: string): Date | undefined {
    const t = value.trim();
    if (!t) return undefined;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

function formatTimeLocal(d: Date): string {
    const h = d.getHours();
    const m = d.getMinutes();
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDisplayLabel(d: Date): string {
    return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function combineLocalDateAndTime(day: Date, timeHHmm: string): Date {
    const [hhRaw, mmRaw] = timeHHmm.split(":");
    const hh = Number.parseInt(hhRaw ?? "0", 10);
    const mm = Number.parseInt(mmRaw ?? "0", 10);
    const out = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number.isFinite(hh) ? hh : 0, Number.isFinite(mm) ? mm : 0, 0, 0);
    return out;
}

export function DatetimeCalendarField({
    valueStr,
    onChange,
    minDate,
    maxDate,
    minNow,
    placeholder = "Pick date & time",
    disabled = false,
}: DatetimeCalendarFieldProps) {
    const parsed = useMemo(() => parseIsoToDate(valueStr), [valueStr]);
    const [open, setOpen] = useState(false);
    const [selectedDay, setSelectedDay] = useState<Date | undefined>(parsed);
    const [timeStr, setTimeStr] = useState(() => (parsed ? formatTimeLocal(parsed) : "12:00"));

    useEffect(() => {
        if (parsed) {
            setSelectedDay(parsed);
            setTimeStr(formatTimeLocal(parsed));
        } else {
            setSelectedDay(undefined);
        }
    }, [parsed, valueStr]);

    const startOfToday = useMemo(() => {
        const n = new Date();
        return new Date(n.getFullYear(), n.getMonth(), n.getDate());
    }, []);

    const disabledMatchers = useMemo(() => {
        const matchers: Matcher[] = [];
        if (minNow) {
            matchers.push({ before: startOfToday });
        } else if (minDate) {
            const d = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
            matchers.push({ before: d });
        }
        if (maxDate) {
            const d = new Date(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate());
            matchers.push({ after: d });
        }
        return matchers;
    }, [minNow, minDate, maxDate, startOfToday]);

    const commit = (day: Date | undefined, time: string) => {
        if (!day) {
            onChange("");
            return;
        }
        const combined = combineLocalDateAndTime(day, time);
        onChange(combined.toISOString());
    };

    const label = parsed ? formatDisplayLabel(parsed) : placeholder;

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    disabled={disabled}
                    className={cn(
                        "flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm font-mono text-white/85",
                        "hover:border-amber-400/30 focus:outline-none focus:border-amber-400/40",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                >
                    <Calendar className="size-4 shrink-0 text-amber-400/80" />
                    <span className={cn(!parsed && "text-white/35")}>{label}</span>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    sideOffset={8}
                    className="z-[200] rounded-xl border border-white/10 bg-[#0b0d12] p-3 shadow-xl"
                    align="start"
                >
                    <div className="space-y-3">
                        <DayPicker
                            mode="single"
                            selected={selectedDay}
                            onSelect={(d) => {
                                setSelectedDay(d);
                                if (d) commit(d, timeStr);
                            }}
                            disabled={disabledMatchers.length > 0 ? disabledMatchers : undefined}
                            classNames={{
                                root: "rdp-root",
                                month_caption: "text-white/90 text-sm font-medium mb-2",
                                weekdays: "text-white/40 text-[10px]",
                                day: "text-white/85",
                                selected: "bg-amber-500/30 text-amber-200 rounded-md",
                                today: "font-bold text-amber-300",
                            }}
                        />
                        <div className="flex items-center gap-2 border-t border-white/10 pt-3">
                            <label className="text-[10px] uppercase tracking-wide text-white/40">Time</label>
                            <input
                                type="time"
                                step={60}
                                value={timeStr}
                                onChange={(e) => {
                                    const next = e.target.value;
                                    setTimeStr(next);
                                    if (selectedDay) commit(selectedDay, next);
                                }}
                                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm font-mono text-white/85 focus:outline-none focus:border-amber-400/40"
                            />
                        </div>
                    </div>
                    <Popover.Arrow className="fill-[#0b0d12]" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
