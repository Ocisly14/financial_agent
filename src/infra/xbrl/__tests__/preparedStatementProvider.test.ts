import assert from "node:assert/strict";
import test from "node:test";
import { createPreparedStatementProvider } from "../preparedStatementProvider.ts";
import type { SecDataProvider } from "../../../../mcp_tools/sec/secClient.ts";

function batch(accession: string, filed: string, report: string) {
  return { accessionNumber: [accession], form: ["10-K"], filingDate: [filed], reportDate: [report], primaryDocument: ["annual.htm"], isXBRL: [1] };
}

function multiBatch(entries: Array<{ accession: string; form: "10-K" | "10-K/A"; filed: string; report: string }>) {
  return {
    accessionNumber: entries.map((entry) => entry.accession),
    form: entries.map((entry) => entry.form),
    filingDate: entries.map((entry) => entry.filed),
    reportDate: entries.map((entry) => entry.report),
    primaryDocument: entries.map(() => "annual.htm"),
    isXBRL: entries.map(() => 1),
  };
}

test("period resolution reads supplemental submissions files for older annual history", async () => {
  const calls: string[] = [];
  const sec: SecDataProvider = {
    resolveCompany: async () => ({ cik: 1, ticker: "TEST", title: "Test" }),
    getSubmissions: async () => ({ filings: { recent: batch("new", "2026-02-01", "2025-12-31"), files: [{ name: "CIK0000000001-submissions-001.json" }] } }),
    getSubmissionFile: async (name) => { calls.push(name); return batch("old", "2024-02-01", "2023-12-31"); },
    getCompanyFacts: async () => ({}),
  };
  const provider = createPreparedStatementProvider({ sec, arelle: async () => ({ protocolVersion: 3, filings: [], diagnostics: [] }) });
  const source = await provider.resolve({ symbol: "TEST", historyYears: 3, forecastYears: 3, filingForms: ["10-K", "10-K/A"] });
  assert.deepEqual(calls, ["CIK0000000001-submissions-001.json"]);
  assert.deepEqual(source.filings.map((filing) => filing.accession), ["new", "old"]);
  assert.deepEqual(source.periods.filter((period) => period.cls === "actual").map((period) => period.id), ["FY2023", "FY2025"]);
});

test("historyYears counts distinct report dates while preserving every selected filing version", async () => {
  const sec: SecDataProvider = {
    resolveCompany: async () => ({ cik: 1, ticker: "TEST", title: "Test" }),
    getSubmissions: async () => ({ filings: { recent: multiBatch([
      { accession: "2025-amended", form: "10-K/A", filed: "2026-03-01", report: "2025-12-31" },
      { accession: "2025-original", form: "10-K", filed: "2026-02-01", report: "2025-12-31" },
      { accession: "2024", form: "10-K", filed: "2025-02-01", report: "2024-12-31" },
      { accession: "2023", form: "10-K", filed: "2024-02-01", report: "2023-12-31" },
    ]) } }),
    getCompanyFacts: async () => ({}),
  };
  const provider = createPreparedStatementProvider({ sec, arelle: async () => ({ protocolVersion: 3, filings: [], diagnostics: [] }) });
  const source = await provider.resolve({ symbol: "TEST", historyYears: 2, forecastYears: 1, filingForms: ["10-K", "10-K/A"] });

  assert.deepEqual(source.periods.filter((period) => period.cls === "actual").map((period) => period.id), ["FY2024", "FY2025"]);
  assert.deepEqual(source.filings.map((filing) => filing.accession), ["2025-amended", "2025-original", "2024"]);
});
