import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionContext } from "../../toolRegistry.ts";
import { createTreasuryYieldTool, TREASURY_YIELD_TOOL } from "../treasuryYieldTool.ts";

const CONTEXT: ToolExecutionContext = { sessionId: "s1", agentId: "a1" };

function feed(date: string, bc30: string): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns="http://www.w3.org/2005/Atom">
<entry>
<content type="application/xml">
<m:properties>
<d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>
<d:BC_1YEAR m:type="Edm.Double">${bc30}</d:BC_1YEAR>
<d:BC_30YEAR m:type="Edm.Double">${bc30}</d:BC_30YEAR>
</m:properties>
</content>
</entry>
</feed>`;
}

test("name constant matches the tool's registered name", () => {
  assert.equal(TREASURY_YIELD_TOOL, "get_treasury_yield");
});

test("happy path: fetches the requested tenor, formats the summary as a percent, and carries the data shape", async () => {
  const fetchImpl = async () => new Response(feed("2026-08-08", "5.19"), { status: 200 });
  const tool = createTreasuryYieldTool(fetchImpl as unknown as typeof fetch);
  const result = await tool.execute({ term: "30Y", asOfDate: "2026-08-08" }, CONTEXT);
  assert.equal(result.error, undefined);
  assert.equal(result.summary, "30Y Treasury yield 5.19% as of 2026-08-08 (treasury.gov)");
  assert.deepEqual(result.generation_context?.data, {
    term: "30Y", value: 0.0519, curve_date: "2026-08-08", source: "treasury.gov daily yield curve",
  });
});

test("feed failure resolves to a treasury_yield_unavailable error result, not a throw", async () => {
  const fetchImpl = async () => new Response("", { status: 500 });
  const tool = createTreasuryYieldTool(fetchImpl as unknown as typeof fetch);
  const result = await tool.execute({ term: "10Y", asOfDate: "2026-08-08" }, CONTEXT);
  assert.equal(result.error?.code, "treasury_yield_unavailable");
  assert.match(result.error!.message, /10Y/);
  assert.match(result.error!.message, /2026-08-08/);
});

test("schema rejects an unknown term", async () => {
  const fetchImpl = async () => new Response(feed("2026-08-08", "5.19"), { status: 200 });
  const tool = createTreasuryYieldTool(fetchImpl as unknown as typeof fetch);
  const result = await tool.execute({ term: "15Y" }, CONTEXT);
  assert.equal(result.error?.code, "invalid_tool_input");
});

test("asOfDate defaults to today when omitted", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(feed(new Date().toISOString().slice(0, 10), "4.50"), { status: 200 });
  };
  const tool = createTreasuryYieldTool(fetchImpl as unknown as typeof fetch);
  const result = await tool.execute({ term: "1Y" }, CONTEXT);
  assert.equal(result.error, undefined);
  const currentMonth = new Date().toISOString().slice(0, 7).replace("-", "");
  assert.match(calls[0]!, new RegExp(`field_tdr_date_value_month=${currentMonth}`));
});
