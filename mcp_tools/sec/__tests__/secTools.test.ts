import test from "node:test";
import assert from "node:assert/strict";
import { registerAllTools, MARKET_RESEARCH_TOOLS } from "../../registerTools.ts";
import { McpToolRegistry } from "../../toolRegistry.ts";
import type { SecDataProvider } from "../secClient.ts";
import { createSecTools, SEC_TOOL_NAMES } from "../secTools.ts";

const CTX = { sessionId: "sec-tool-test", agentId: "agent-1" };

const submissions = {
  cik: "0000320193",
  entityType: "operating",
  sic: "3571",
  sicDescription: "Electronic Computers",
  name: "Apple Inc.",
  tickers: ["AAPL"],
  exchanges: ["Nasdaq"],
  fiscalYearEnd: "0928",
  stateOfIncorporation: "CA",
  website: "https://www.apple.com/",
  investorWebsite: "https://investor.apple.com/",
  category: "Large accelerated filer",
  formerNames: [{ name: "Apple Computer, Inc.", from: "1994-01-01", to: "2007-01-09" }],
  filings: {
    recent: {
      accessionNumber: [
        "0000320193-26-000010",
        "0000320193-26-000009",
        "0000320193-26-000008",
        "0000320193-26-000007",
      ],
      filingDate: ["2026-08-01", "2026-07-31", "2026-07-30", "2026-07-29"],
      reportDate: ["2026-07-31", "2026-06-30", "2026-06-30", "2026-07-29"],
      acceptanceDateTime: [
        "2026-08-01T16:00:00.000Z",
        "2026-07-31T16:00:00.000Z",
        "2026-07-30T16:00:00.000Z",
        "2026-07-29T16:00:00.000Z",
      ],
      form: ["4", "10-Q", "10-Q/A", "8-K"],
      items: ["", "", "", "2.02"],
      isXBRL: [0, 1, 1, 1],
      isInlineXBRL: [0, 1, 1, 1],
      primaryDocument: ["ownership.xml", "aapl-20260630.htm", "aapl-20260630a.htm", "aapl-20260729.htm"],
      primaryDocDescription: ["FORM 4", "10-Q", "10-Q/A", "8-K"],
    },
  },
};

const companyFacts = {
  cik: 320193,
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue",
        description: "Revenue from contracts with customers.",
        units: {
          USD: [
            {
              start: "2026-04-01",
              end: "2026-06-30",
              val: 100,
              accn: "0000320193-26-000009",
              fy: 2026,
              fp: "Q3",
              form: "10-Q",
              filed: "2026-07-31",
              frame: "CY2026Q2",
            },
            {
              start: "2026-04-01",
              end: "2026-06-30",
              val: 101,
              accn: "0000320193-26-000008",
              fy: 2026,
              fp: "Q3",
              form: "10-Q/A",
              filed: "2026-08-02",
              frame: "CY2026Q2",
            },
            {
              start: "2026-01-01",
              end: "2026-03-31",
              val: 90,
              accn: "0000320193-26-000004",
              fy: 2026,
              fp: "Q2",
              form: "10-Q",
              filed: "2026-05-01",
              frame: "CY2026Q1",
            },
            {
              start: "2025-10-01",
              end: "2026-09-30",
              val: 390,
              accn: "0000320193-26-000020",
              fy: 2026,
              fp: "FY",
              form: "10-K",
              filed: "2026-11-01",
              frame: "CY2026",
            },
          ],
        },
      },
      Assets: {
        label: "Assets",
        description: "Total assets.",
        units: {
          USD: [
            {
              end: "2026-06-30",
              val: 350,
              accn: "0000320193-26-000009",
              fy: 2026,
              fp: "Q3",
              form: "10-Q",
              filed: "2026-07-31",
              frame: "CY2026Q2I",
            },
          ],
        },
      },
    },
  },
};

function provider(): { value: SecDataProvider; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    value: {
      resolveCompany: async (symbol) => {
        calls.push(`resolve:${symbol}`);
        return symbol.replace(".", "-") === "AAPL"
          ? { cik: 320193, ticker: "AAPL", title: "Apple Inc." }
          : undefined;
      },
      getSubmissions: async (cik) => {
        calls.push(`submissions:${cik}`);
        return submissions;
      },
      getCompanyFacts: async (cik) => {
        calls.push(`facts:${cik}`);
        return companyFacts;
      },
    },
  };
}

function tools(fake: SecDataProvider): Map<string, ReturnType<typeof createSecTools>[number]> {
  return new Map(createSecTools({ provider: fake }).map((tool) => [tool.name, tool]));
}

test("SEC tools are registered in the market-research pool", () => {
  const registry = new McpToolRegistry();
  registerAllTools(registry);

  for (const name of SEC_TOOL_NAMES) {
    assert.ok(registry.get(name), `${name} should be registered`);
    assert.ok(MARKET_RESEARCH_TOOLS.includes(name));
  }
});

test("company profile returns official identity and recent material filings", async () => {
  const fake = provider();
  const tool = tools(fake.value).get("get_sec_company_profile")!;
  const result = await tool.execute({ symbol: " aapl ", recent_filings: 2 }, CTX);
  const data = result.generation_context!.data as Record<string, unknown>;

  assert.equal(result.error, undefined);
  assert.deepEqual(fake.calls, ["resolve:AAPL", "submissions:320193"]);
  assert.equal(data["cik"], "0000320193");
  assert.equal(data["name"], "Apple Inc.");
  const filings = data["latest_material_filings"] as Array<Record<string, unknown>>;
  assert.deepEqual(filings.map((filing) => filing["form"]), ["10-Q", "10-Q/A"]);
  assert.equal(
    filings[0]!["primary_document_url"],
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000009/aapl-20260630.htm",
  );
});

test("filings lookup validates and applies form, amendment, and date filters", async () => {
  const fake = provider();
  const tool = tools(fake.value).get("get_sec_filings")!;
  const result = await tool.execute({
    symbol: "AAPL",
    forms: ["10-Q"],
    include_amendments: false,
    from_date: "2026-07-30",
    to_date: "2026-08-01",
  }, CTX);
  const data = result.generation_context!.data as Record<string, unknown>;
  const filings = data["filings"] as Array<Record<string, unknown>>;

  assert.deepEqual(filings.map((filing) => filing["form"]), ["10-Q"]);
  assert.equal(data["matched_count"], 1);

  const invalid = await tool.execute({ symbol: "AAPL", forms: [], from_date: "2026-08-01" }, CTX);
  assert.equal(invalid.error?.code, "invalid_forms");
});

test("company facts select exact concepts, keep provenance, and prefer the latest amendment", async () => {
  const fake = provider();
  const tool = tools(fake.value).get("get_sec_company_facts")!;
  const result = await tool.execute({
    symbol: "AAPL",
    metrics: ["revenue", "assets", "net_income"],
    period_type: "quarterly",
    periods: 2,
  }, CTX);
  const data = result.generation_context!.data as Record<string, unknown>;
  const metrics = data["metrics"] as Record<string, Record<string, unknown>>;
  const revenueFacts = metrics["revenue"]!["facts"] as Array<Record<string, unknown>>;

  assert.equal(result.error, undefined);
  assert.equal(metrics["revenue"]!["concept"], "RevenueFromContractWithCustomerExcludingAssessedTax");
  assert.equal(revenueFacts.length, 2);
  assert.equal(revenueFacts[0]!["value"], 101);
  assert.equal(revenueFacts[0]!["form"], "10-Q/A");
  assert.equal(revenueFacts[0]!["accession_number"], "0000320193-26-000008");
  assert.equal(metrics["assets"]!["unit"], "USD");
  assert.deepEqual(data["unavailable_metrics"], ["net_income"]);
});

test("SEC tools reject missing or unknown symbols without fabricating a filer", async () => {
  const fake = provider();
  const profile = tools(fake.value).get("get_sec_company_profile")!;

  const missing = await profile.execute({}, CTX);
  assert.equal(missing.error?.code, "invalid_symbol");

  const unknown = await profile.execute({ symbol: "NOPE" }, CTX);
  assert.equal(unknown.error?.code, "sec_company_not_found");
  assert.deepEqual(fake.calls, ["resolve:NOPE"]);
});

test("SEC tool schemas never expose the framework-injected task field", () => {
  const fake = provider();
  for (const tool of createSecTools({ provider: fake.value })) {
    assert.equal(tool.inputSchema.properties?.["task"], undefined);
    assert.ok(tool.inputSchema.properties?.["symbol"]);
  }
});
