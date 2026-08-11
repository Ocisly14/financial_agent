import assert from "node:assert/strict";
import test from "node:test";
import { fetchTreasury30y, fetchTreasuryYield, parseTreasury30y, parseTreasuryYield } from "../treasuryYield.ts";

function entry(date: string, bc30: string | undefined, bc10?: string): string {
  const bc30Field = bc30 === undefined ? "" : `<d:BC_30YEAR m:type="Edm.Double">${bc30}</d:BC_30YEAR>\n<d:BC_30YEARDISPLAY m:type="Edm.Double">${bc30}</d:BC_30YEARDISPLAY>`;
  const bc10Field = bc10 === undefined ? "" : `<d:BC_10YEAR m:type="Edm.Double">${bc10}</d:BC_10YEAR>`;
  return `<entry>
<content type="application/xml">
<m:properties>
<d:Id m:type="Edm.Int32">1</d:Id>
<d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>
<d:BC_1MONTH m:type="Edm.Double">3.72</d:BC_1MONTH>
${bc10Field}
${bc30Field}
</m:properties>
</content>
</entry>`;
}

function feed(entries: string[]): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns="http://www.w3.org/2005/Atom">
<title type="text">DailyTreasuryYieldCurveRateData</title>
${entries.join("\n")}
</feed>`;
}

test("parses NEW_DATE/BC_30YEAR pairs, converting percent points to decimals", () => {
  const xml = feed([entry("2026-01-02", "4.86"), entry("2026-01-05", "4.85")]);
  const points = parseTreasury30y(xml);
  assert.deepEqual(points, [
    { date: "2026-01-02", value: 0.0486 },
    { date: "2026-01-05", value: 0.0485 },
  ]);
});

test("an entry missing BC_30YEAR (pre-2006 months carry no 30-year point) is skipped, not NaN", () => {
  const xml = feed([entry("1998-01-02", undefined), entry("1998-01-05", "5.13")]);
  const points = parseTreasury30y(xml);
  assert.deepEqual(points, [{ date: "1998-01-05", value: 0.0513 }]);
});

test("an empty month's feed (no entries) parses to an empty list", () => {
  assert.deepEqual(parseTreasury30y(feed([])), []);
});

test("fetchTreasury30y picks the latest point on or before asOfDate within the same month", async () => {
  const xml = feed([entry("2026-01-02", "4.86"), entry("2026-01-05", "4.85"), entry("2026-01-06", "4.90")]);
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(xml, { status: 200 });
  };
  const result = await fetchTreasury30y("2026-01-05", fetchImpl as typeof fetch);
  assert.deepEqual(result, { value: 0.0485, curveDate: "2026-01-05" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /field_tdr_date_value_month=202601/);
});

test("fetchTreasury30y rolls back to the previous month when asOfDate precedes any point in its own month", async () => {
  const currentMonthXml = feed([entry("2026-02-03", "4.80")]); // nothing on/before Feb 1
  const priorMonthXml = feed([entry("2026-01-28", "4.83"), entry("2026-01-30", "4.84")]);
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("202602") ? currentMonthXml : priorMonthXml;
    return new Response(body, { status: 200 });
  };
  const result = await fetchTreasury30y("2026-02-01", fetchImpl as typeof fetch);
  assert.deepEqual(result, { value: 0.0484, curveDate: "2026-01-30" });
  assert.equal(calls.length, 2);
});

test("fetchTreasury30y resolves to undefined, never throwing, when the feed errors", async () => {
  const fetchImpl = async () => new Response("", { status: 500 });
  const result = await fetchTreasury30y("2026-01-05", fetchImpl as typeof fetch);
  assert.equal(result, undefined);
});

test("fetchTreasury30y resolves to undefined when fetch itself rejects", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  const result = await fetchTreasury30y("2026-01-05", fetchImpl as typeof fetch);
  assert.equal(result, undefined);
});

test("fetchTreasury30y resolves to undefined when both months are empty", async () => {
  const fetchImpl = async () => new Response(feed([]), { status: 200 });
  const result = await fetchTreasury30y("2026-01-01", fetchImpl as typeof fetch);
  assert.equal(result, undefined);
});

test("parseTreasuryYield extracts each tenor's own field, distinguishing 10Y from 30Y in the same entry", () => {
  const xml = feed([entry("2026-01-02", "4.86", "4.10"), entry("2026-01-05", "4.85", "4.05")]);
  assert.deepEqual(parseTreasuryYield(xml, "30Y"), [
    { date: "2026-01-02", value: 0.0486 },
    { date: "2026-01-05", value: 0.0485 },
  ]);
  assert.deepEqual(parseTreasuryYield(xml, "10Y"), [
    { date: "2026-01-02", value: 0.041 },
    { date: "2026-01-05", value: 0.0405 },
  ]);
});

test("fetchTreasuryYield rolls back to the previous month for a non-30Y term when asOfDate precedes any point in its own month", async () => {
  const currentMonthXml = feed([entry("2026-02-03", "4.80", "4.20")]); // nothing on/before Feb 1
  const priorMonthXml = feed([entry("2026-01-28", "4.83", "4.18"), entry("2026-01-30", "4.84", "4.19")]);
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("202602") ? currentMonthXml : priorMonthXml;
    return new Response(body, { status: 200 });
  };
  const result = await fetchTreasuryYield("10Y", "2026-02-01", fetchImpl as typeof fetch);
  assert.deepEqual(result, { value: 0.0419, curveDate: "2026-01-30" });
  assert.equal(calls.length, 2);
});
