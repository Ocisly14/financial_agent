export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number, from = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return d;
}

export function dateRange(from?: string, to?: string, defaultDays = 30): { from: string; to: string } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : daysAgo(defaultDays, end);
  return { from: toIsoDate(start), to: toIsoDate(end) };
}

export function toUnixMs(iso: string): number {
  return new Date(iso).getTime();
}

export function isoFromUnixMs(ms: number): string {
  return toIsoDate(new Date(ms));
}

export function recentDates(n: number): string[] {
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) dates.push(toIsoDate(daysAgo(i)));
  return dates;
}
