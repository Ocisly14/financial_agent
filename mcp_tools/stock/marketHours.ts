export type MarketSession = "pre-market" | "regular" | "after-hours" | "closed";

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

type EtClock = { date: string; minutes: number; weekday: string };

function etClock(now: Date): EtClock {
  const parts = ET_PARTS.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false 在部分运行时会把午夜渲染成 "24"
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
    weekday: get("weekday"),
  };
}

/** 美东日历日 "YYYY-MM-DD"。 */
export function etDateString(now: Date): string {
  return etClock(now).date;
}

/**
 * 判定美股所处时段。仅用于文案标注，不处理节假日。
 * 盘前 04:00–09:30、盘中 09:30–16:00、盘后 16:00–20:00（美东）。
 */
export function marketSession(now: Date): MarketSession {
  const { minutes, weekday } = etClock(now);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre-market";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "after-hours";
  return "closed";
}
