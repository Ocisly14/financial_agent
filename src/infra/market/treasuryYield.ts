/**
 * The official U.S. Treasury daily par yield curve — treasury.gov's own feed, so the risk-free rate
 * the WACC sheet uses (and any other tenor an agent wants to inspect or override with) has a named,
 * checkable source instead of resting on whatever the agent happened to search up.
 *
 * The feed is an OData/Atom XML document, one `<entry>` per trading day, each carrying a `NEW_DATE`
 * and one `BC_<TERM>` field per tenor (percent points, e.g. `4.86`). There is no JSON variant and no
 * dependency pulled in to parse it — the document's shape is simple and stable enough for
 * string/regex parsing.
 */

const FEED_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";

/** Every tenor the daily yield curve feed publishes, in the feed's own field-name order. */
export const TREASURY_TERMS = ["1M", "2M", "3M", "4M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"] as const;
export type TreasuryTerm = (typeof TREASURY_TERMS)[number];

/** Maps each tenor onto the feed's `d:BC_*` field name. */
const FEED_FIELD_BY_TERM: Record<TreasuryTerm, string> = {
  "1M": "BC_1MONTH", "2M": "BC_2MONTH", "3M": "BC_3MONTH", "4M": "BC_4MONTH", "6M": "BC_6MONTH",
  "1Y": "BC_1YEAR", "2Y": "BC_2YEAR", "3Y": "BC_3YEAR", "5Y": "BC_5YEAR", "7Y": "BC_7YEAR",
  "10Y": "BC_10YEAR", "20Y": "BC_20YEAR", "30Y": "BC_30YEAR",
};

export type TreasuryYieldPoint = { date: string; value: number };
export type TreasuryYieldResult = { value: number; curveDate: string };
/** @deprecated kept for existing 30y-only callers; identical shape to `TreasuryYieldPoint`. */
export type Treasury30yPoint = TreasuryYieldPoint;
/** @deprecated kept for existing 30y-only callers; identical shape to `TreasuryYieldResult`. */
export type Treasury30yResult = TreasuryYieldResult;

/** One `<entry>...</entry>` block, non-greedy so consecutive entries do not merge. */
const ENTRY_RE = /<entry>([\s\S]*?)<\/entry>/g;
const NEW_DATE_RE = /<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/;

/**
 * Parses one term's daily yield curve point out of one month's XML. Values arrive in percent points
 * (`4.86`) and are returned as decimals (`0.0486`). An entry missing the requested field (some
 * pre-2006 months carry no 30-year point at all, and short tenors were added even later) is skipped
 * rather than producing a NaN.
 */
export function parseTreasuryYield(xml: string, term: TreasuryTerm): TreasuryYieldPoint[] {
  const fieldRe = new RegExp(`<d:${FEED_FIELD_BY_TERM[term]}(?:\\s[^>]*)?>([^<]+)<\\/d:${FEED_FIELD_BY_TERM[term]}>`);
  const points: TreasuryYieldPoint[] = [];
  for (const match of xml.matchAll(ENTRY_RE)) {
    const entry = match[1]!;
    const dateMatch = NEW_DATE_RE.exec(entry);
    const valueMatch = fieldRe.exec(entry);
    if (!dateMatch || !valueMatch) continue;
    const date = dateMatch[1]!.slice(0, 10);
    const percent = Number(valueMatch[1]);
    if (!Number.isFinite(percent)) continue;
    // Round to avoid the classic 4.86/100 -> 0.048600000000000004 binary-float artifact; six decimals
    // is well past the feed's own two-decimal-point precision.
    points.push({ date, value: Math.round((percent / 100) * 1e6) / 1e6 });
  }
  return points;
}

/**
 * Parses the daily yield curve feed's 30-year point out of one month's XML. Thin wrapper over
 * {@link parseTreasuryYield} kept for existing 30y-only callers.
 */
export function parseTreasury30y(xml: string): Treasury30yPoint[] {
  return parseTreasuryYield(xml, "30Y");
}

function monthUrl(yyyymm: string): string {
  return `${FEED_URL}?data=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}`;
}

function yyyymm(isoDate: string): string {
  return isoDate.slice(0, 7).replace("-", "");
}

/** The month before `yyyymm`, in the same `YYYYMM` shape. */
function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(4, 6)) - 1; // 0-based
  const date = new Date(Date.UTC(year, monthIndex - 1, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function fetchMonth(month: string, term: TreasuryTerm, fetchImpl: typeof fetch): Promise<TreasuryYieldPoint[]> {
  const response = await fetchImpl(monthUrl(month));
  if (!response.ok) throw new Error(`treasury.gov feed returned ${response.status}`);
  return parseTreasuryYield(await response.text(), term);
}

/**
 * A Treasury yield-curve term as of `asOfDate`: the latest published point on or before it. Treasury
 * publishes on business days only, so a weekend/holiday `asOfDate` still resolves to the prior
 * session's close. If `asOfDate`'s own month has no point at or before that date (e.g. asOfDate is the
 * 1st of the month), the previous month is fetched once as a fallback. Never throws — any failure
 * (network, parse, empty feed) resolves to `undefined` so the caller reports the term unreachable
 * instead of crashing a refresh.
 */
export async function fetchTreasuryYield(term: TreasuryTerm, asOfDate: string, fetchImpl: typeof fetch = fetch):
Promise<TreasuryYieldResult | undefined> {
  try {
    const month = yyyymm(asOfDate);
    const points = await fetchMonth(month, term, fetchImpl);
    const eligible = points.filter((point) => point.date <= asOfDate).sort((a, b) => a.date.localeCompare(b.date));
    if (eligible.length > 0) {
      const latest = eligible.at(-1)!;
      return { value: latest.value, curveDate: latest.date };
    }
    const priorPoints = await fetchMonth(previousMonth(month), term, fetchImpl);
    if (priorPoints.length === 0) return undefined;
    const latest = [...priorPoints].sort((a, b) => a.date.localeCompare(b.date)).at(-1)!;
    return { value: latest.value, curveDate: latest.date };
  } catch {
    return undefined;
  }
}

/**
 * The 30-year Treasury yield as of `asOfDate`. Thin wrapper over {@link fetchTreasuryYield} kept for
 * existing 30y-only callers (the WACC sheet's risk-free-rate derivation).
 */
export async function fetchTreasury30y(asOfDate: string, fetchImpl: typeof fetch = fetch):
Promise<Treasury30yResult | undefined> {
  return fetchTreasuryYield("30Y", asOfDate, fetchImpl);
}
