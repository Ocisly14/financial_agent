import test from "node:test";
import assert from "node:assert/strict";
import { createSecClient, SecApiError } from "../secClient.ts";

test("SEC client declares its user agent, resolves dot-class tickers, and caches the ticker map", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const client = createSecClient({
    userAgent: "FinancialAgent tests@example.com",
    minRequestIntervalMs: 0,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({
        0: { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const first = await client.resolveCompany("brk.b");
  const second = await client.resolveCompany("BRK-B");

  assert.deepEqual(first, { cik: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://www.sec.gov/files/company_tickers.json");
  assert.equal(calls[0]!.headers.get("user-agent"), "FinancialAgent tests@example.com");
  assert.equal(calls[0]!.headers.get("accept"), "application/json");
});

test("SEC client uses padded CIK endpoints for submissions and company facts", async () => {
  const urls: string[] = [];
  const client = createSecClient({
    userAgent: "FinancialAgent tests@example.com",
    minRequestIntervalMs: 0,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await client.getSubmissions(320193);
  await client.getCompanyFacts(320193);

  assert.deepEqual(urls, [
    "https://data.sec.gov/submissions/CIK0000320193.json",
    "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
  ]);
});

test("SEC client refuses automated access without an identifiable contact", async () => {
  let calls = 0;
  const client = createSecClient({
    userAgent: "FinancialAgent",
    minRequestIntervalMs: 0,
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    client.resolveCompany("AAPL"),
    (error: unknown) => error instanceof SecApiError && error.code === "sec_configuration_error",
  );
  assert.equal(calls, 0);
});

test("SEC client surfaces HTTP rate limiting as a structured request failure", async () => {
  const client = createSecClient({
    userAgent: "FinancialAgent tests@example.com",
    minRequestIntervalMs: 0,
    fetch: async () => new Response("limited", { status: 429, headers: { "retry-after": "1" } }),
  });

  await assert.rejects(
    client.resolveCompany("AAPL"),
    (error: unknown) => error instanceof SecApiError
      && error.code === "sec_request_failed"
      && error.status === 429
      && /Retry after 1/.test(error.message),
  );
});
