import type { Period } from "../../financial-model/types.ts";
import { createSecClient, type SecDataProvider } from "../../../mcp_tools/sec/secClient.ts";
import { createArelleProcessRunner, type ArelleRunner } from "./arelleAdapter.ts";
import type { FilingDocument } from "../filing-insights/types.ts";
import type { FilingExtraction, FilingIdentity } from "./types.ts";

export type FinancialModelSourceRequest = {
  symbol: string;
  historyYears: number;
  forecastYears: number;
  filingForms: Array<"10-K" | "10-K/A">;
  reportingCurrency?: string;
};

export type ResolvedFinancialModelSource = {
  company: { cik: number; ticker: string; title: string };
  reportingCurrency: string;
  fiscalYearEnd: string;
  periods: Period[];
  filings: FilingIdentity[];
};

export interface PreparedStatementProvider {
  resolve(request: FinancialModelSourceRequest): Promise<ResolvedFinancialModelSource>;
  /** Raw per-filing extraction. Curation and merging happen downstream, not here. */
  extract(source: ResolvedFinancialModelSource): Promise<FilingExtraction[]>;
  filingDocuments(source: ResolvedFinancialModelSource): Promise<FilingDocument[]>;
}

export function createPreparedStatementProvider(options: {
  sec?: SecDataProvider;
  arelle?: ArelleRunner;
  fetch?: typeof fetch;
} = {}): PreparedStatementProvider {
  const sec = options.sec ?? createSecClient();
  const arelle = options.arelle ?? createArelleProcessRunner();
  const fetchImpl = options.fetch ?? fetch;
  return {
    async resolve(request) {
      const company = await sec.resolveCompany(request.symbol);
      if (!company) throw new Error(`SEC company not found for symbol ${request.symbol}`);
      const submissions = await sec.getSubmissions(company.cik);
      const forms = new Set(request.filingForms);
      let annual = annualFilings(
        ((submissions["filings"] as Record<string, unknown> | undefined)?.["recent"] ?? {}) as Record<string, unknown>,
        company.cik,
        forms,
      );
      // SEC supplemental submission files are chronological history shards.
      // Avoid fetching them when the recent payload already covers the request;
      // otherwise read only until enough distinct fiscal report dates exist.
      if (sec.getSubmissionFile && distinctReportDates(annual) < request.historyYears) {
        for (const name of submissionFileNames(submissions)) {
          const payload = await sec.getSubmissionFile(name);
          annual.push(...annualFilings(payload, company.cik, forms));
          if (distinctReportDates(annual) >= request.historyYears) break;
        }
      }
      annual = deduplicateFilings(annual)
        .sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.accession.localeCompare(a.accession));
      if (annual.length === 0) throw new Error(`No filing-level XBRL annual filings found for ${request.symbol}`);
      const reportDates = [...new Set(annual.map((filing) => filing.reportDate).filter(Boolean))]
        .sort((a, b) => b.localeCompare(a)).slice(0, request.historyYears).sort();
      const selectedReportDates = new Set(reportDates);
      // historyYears counts fiscal periods, not filing documents. Keep every
      // original/amended filing for a selected report date so the extractor can
      // preserve presentation versions and apply filedAt precedence.
      const selectedFilings = annual.filter((filing) => selectedReportDates.has(filing.reportDate));
      // A fiscal year starts the day after the previous one ended. Deriving it as "one calendar year
      // back" instead breaks every 52/53-week filer: Apple's FY2023 really ran 371 days, and the
      // synthetic start both understates it and leaves gaps and overlaps between consecutive years.
      // Only the earliest period has no predecessor to anchor on.
      const actual = reportDates.map((end, index): Period => {
        const priorEnd = reportDates[index - 1];
        return { id: `FY${end.slice(0, 4)}`, label: `FY${end.slice(0, 4)}`,
          start: priorEnd === undefined ? yearBeforePlusDay(end) : nextDay(priorEnd), end, cls: "actual" };
      });
      const latestEnd = actual.at(-1)?.end ?? annual[0]!.reportDate;
      const forecast = Array.from({ length: request.forecastYears }, (_, index): Period => {
        const end = addYears(latestEnd, index + 1);
        return { id: `FY${end.slice(0, 4)}`, label: `FY${end.slice(0, 4)}`, start: yearBeforePlusDay(end), end, cls: "forecast" };
      });
      return { company, reportingCurrency: request.reportingCurrency ?? "USD", fiscalYearEnd: latestEnd.slice(5),
        periods: [...actual, ...forecast], filings: selectedFilings };
    },
    async extract(source) {
      const output = await arelle({ protocolVersion: 3, filings: source.filings, periods: source.periods });
      return output.filings;
    },
    async filingDocuments(source) {
      const userAgent = process.env["SEC_USER_AGENT"] ?? "";
      if (!userAgent.includes("@")) throw new Error("SEC_USER_AGENT is required for filing document analysis");
      return await Promise.all(source.filings.map(async (filing) => {
        const response = await fetchImpl(filing.primaryDocumentUrl, { headers: { "User-Agent": userAgent, Accept: "text/html" } });
        if (!response.ok) throw new Error(`filing document HTTP ${response.status}`);
        return { filing, text: await response.text() };
      }));
    },
  };
}

function deduplicateFilings(filings: FilingIdentity[]): FilingIdentity[] {
  const byAccession = new Map<string, FilingIdentity>();
  for (const filing of filings) if (!byAccession.has(filing.accession)) byAccession.set(filing.accession, filing);
  return [...byAccession.values()];
}

function distinctReportDates(filings: readonly FilingIdentity[]): number {
  return new Set(filings.map((filing) => filing.reportDate).filter(Boolean)).size;
}

function annualFilings(recent: Record<string, unknown>, cik: number, forms: Set<string>): FilingIdentity[] {
  const accessions = Array.isArray(recent["accessionNumber"]) ? recent["accessionNumber"] as unknown[] : [];
  const array = (key: string) => Array.isArray(recent[key]) ? recent[key] as unknown[] : [];
  const results: FilingIdentity[] = [];
  for (let index = 0; index < accessions.length; index += 1) {
    const accession = String(accessions[index] ?? ""); const form = String(array("form")[index] ?? "");
    const filedAt = String(array("filingDate")[index] ?? ""); const reportDate = String(array("reportDate")[index] ?? "");
    const primary = String(array("primaryDocument")[index] ?? ""); const isXbrl = Number(array("isXBRL")[index] ?? 0);
    if (!accession || !forms.has(form) || !filedAt || !reportDate || !primary || isXbrl !== 1) continue;
    const cleanAccession = accession.replaceAll("-", "");
    results.push({ accession, form: form as FilingIdentity["form"], filedAt, reportDate,
      primaryDocumentUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${cleanAccession}/${encodeURIComponent(primary)}` });
  }
  return results.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.accession.localeCompare(a.accession));
}

function submissionFileNames(submissions: Record<string, unknown>): string[] {
  const files = (submissions["filings"] as Record<string, unknown> | undefined)?.["files"];
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
    ? [(entry as { name: string }).name] : []);
}

function addYears(date: string, years: number): string {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCFullYear(value.getUTCFullYear() + years); return value.toISOString().slice(0, 10);
}
function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10);
}
function yearBeforePlusDay(end: string): string {
  const value = new Date(`${end}T00:00:00Z`); value.setUTCFullYear(value.getUTCFullYear() - 1); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10);
}
