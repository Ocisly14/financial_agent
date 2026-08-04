import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import {
  createSecClient,
  paddedCik,
  SecApiError,
  type SecCompanyIdentifier,
  type SecDataProvider,
} from "./secClient.ts";

export const SEC_TOOL_NAMES = [
  "get_sec_company_profile",
  "get_sec_filings",
  "get_sec_company_facts",
] as const;

const MATERIAL_FORMS = ["10-K", "10-Q", "8-K", "20-F", "40-F", "6-K"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type FactCandidate = { taxonomy: "us-gaap" | "ifrs-full"; concept: string };
type MetricDefinition = {
  label: string;
  preferredUnits: string[];
  candidates: FactCandidate[];
};

export const SEC_METRICS = {
  revenue: {
    label: "Revenue",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerExcludingAssessedTax" },
      { taxonomy: "us-gaap", concept: "Revenues" },
      { taxonomy: "us-gaap", concept: "SalesRevenueNet" },
      { taxonomy: "ifrs-full", concept: "Revenue" },
    ],
  },
  operating_income: {
    label: "Operating income",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "OperatingIncomeLoss" },
      { taxonomy: "ifrs-full", concept: "ProfitLossFromOperatingActivities" },
    ],
  },
  net_income: {
    label: "Net income",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "NetIncomeLoss" },
      { taxonomy: "ifrs-full", concept: "ProfitLoss" },
    ],
  },
  assets: {
    label: "Total assets",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "Assets" },
      { taxonomy: "ifrs-full", concept: "Assets" },
    ],
  },
  liabilities: {
    label: "Total liabilities",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "Liabilities" },
      { taxonomy: "ifrs-full", concept: "Liabilities" },
    ],
  },
  stockholders_equity: {
    label: "Stockholders' equity",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "StockholdersEquity" },
      { taxonomy: "ifrs-full", concept: "Equity" },
    ],
  },
  cash_and_equivalents: {
    label: "Cash and cash equivalents",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "CashAndCashEquivalentsAtCarryingValue" },
      { taxonomy: "us-gaap", concept: "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents" },
      { taxonomy: "ifrs-full", concept: "CashAndCashEquivalents" },
    ],
  },
  operating_cash_flow: {
    label: "Operating cash flow",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "NetCashProvidedByUsedInOperatingActivities" },
      { taxonomy: "ifrs-full", concept: "CashFlowsFromUsedInOperatingActivities" },
    ],
  },
  capital_expenditures: {
    label: "Capital expenditures",
    preferredUnits: ["USD"],
    candidates: [
      { taxonomy: "us-gaap", concept: "PaymentsToAcquirePropertyPlantAndEquipment" },
      { taxonomy: "ifrs-full", concept: "PurchaseOfPropertyPlantAndEquipment" },
    ],
  },
  diluted_eps: {
    label: "Diluted earnings per share",
    preferredUnits: ["USD/shares", "USD / shares"],
    candidates: [
      { taxonomy: "us-gaap", concept: "EarningsPerShareDiluted" },
      { taxonomy: "ifrs-full", concept: "DilutedEarningsLossPerShare" },
    ],
  },
  diluted_shares: {
    label: "Diluted weighted-average shares",
    preferredUnits: ["shares"],
    candidates: [
      { taxonomy: "us-gaap", concept: "WeightedAverageNumberOfDilutedSharesOutstanding" },
      { taxonomy: "ifrs-full", concept: "DilutedWeightedAverageShares" },
    ],
  },
  long_term_debt_current: {
    label: "Current portion of long-term debt",
    preferredUnits: ["USD"],
    candidates: [{ taxonomy: "us-gaap", concept: "LongTermDebtCurrent" }],
  },
  long_term_debt_noncurrent: {
    label: "Long-term debt, noncurrent",
    preferredUnits: ["USD"],
    candidates: [{ taxonomy: "us-gaap", concept: "LongTermDebtNoncurrent" }],
  },
} as const satisfies Record<string, MetricDefinition>;

type SecMetric = keyof typeof SEC_METRICS;

type Filing = {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  acceptanceDateTime: string;
  form: string;
  items: string;
  isXBRL: number | null;
  isInlineXBRL: number | null;
  primaryDocument: string;
  primaryDocDescription: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requiredSymbol(input: JsonObject): string {
  return typeof input["symbol"] === "string" ? input["symbol"].trim().toUpperCase() : "";
}

function boundedInteger(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cikSource(cik: number, kind: "submissions" | "facts"): string {
  return kind === "submissions"
    ? `https://data.sec.gov/submissions/CIK${paddedCik(cik)}.json`
    : `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik(cik)}.json`;
}

function filingUrls(company: SecCompanyIdentifier, filing: Filing): { index: string; primary?: string } {
  const accessionPath = filing.accessionNumber.replaceAll("-", "");
  const base = `https://www.sec.gov/Archives/edgar/data/${company.cik}/${accessionPath}`;
  const primary = filing.primaryDocument
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map(encodeURIComponent)
    .join("/");
  return {
    index: `${base}/${filing.accessionNumber}-index.html`,
    ...(primary ? { primary: `${base}/${primary}` } : {}),
  };
}

function recentFilings(submissions: Record<string, unknown>): Filing[] {
  const filings = asRecord(submissions["filings"]);
  const recent = asRecord(filings?.["recent"]);
  if (!recent) return [];

  const accessionNumbers = arrayValue(recent["accessionNumber"]);
  const output: Filing[] = [];
  for (let index = 0; index < accessionNumbers.length; index += 1) {
    const accessionNumber = stringValue(accessionNumbers[index]);
    const form = stringValue(arrayValue(recent["form"])[index]);
    const filingDate = stringValue(arrayValue(recent["filingDate"])[index]);
    if (!accessionNumber || !form || !filingDate) continue;
    output.push({
      accessionNumber,
      filingDate,
      reportDate: stringValue(arrayValue(recent["reportDate"])[index]),
      acceptanceDateTime: stringValue(arrayValue(recent["acceptanceDateTime"])[index]),
      form,
      items: stringValue(arrayValue(recent["items"])[index]),
      isXBRL: numberOrNull(arrayValue(recent["isXBRL"])[index]),
      isInlineXBRL: numberOrNull(arrayValue(recent["isInlineXBRL"])[index]),
      primaryDocument: stringValue(arrayValue(recent["primaryDocument"])[index]),
      primaryDocDescription: stringValue(arrayValue(recent["primaryDocDescription"])[index]),
    });
  }
  return output;
}

function filingJson(company: SecCompanyIdentifier, filing: Filing): JsonObject {
  const urls = filingUrls(company, filing);
  return {
    accession_number: filing.accessionNumber,
    form: filing.form,
    filing_date: filing.filingDate,
    report_date: filing.reportDate || null,
    acceptance_datetime: filing.acceptanceDateTime || null,
    items: filing.items || null,
    is_xbrl: filing.isXBRL,
    is_inline_xbrl: filing.isInlineXBRL,
    primary_document: filing.primaryDocument || null,
    primary_document_description: filing.primaryDocDescription || null,
    filing_index_url: urls.index,
    primary_document_url: urls.primary ?? null,
  };
}

function toolError(error: unknown, symbol: string): ToolExecutionResult {
  if (error instanceof SecApiError) {
    return { summary: error.message, error: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    summary: `SEC data request for ${symbol} failed: ${message}`,
    error: { code: "sec_request_failed", message },
  };
}

async function companyFor(provider: SecDataProvider, symbol: string): Promise<SecCompanyIdentifier> {
  const company = await provider.resolveCompany(symbol);
  if (!company) throw new Error(`No SEC company mapping was found for ticker ${symbol}.`);
  return company;
}

function schema(properties: Record<string, JsonSchema>, required: string[] = ["symbol"]): JsonSchema {
  return { type: "object", properties, required };
}

const SYMBOL_PROPERTY: JsonSchema = {
  type: "string",
  description: "US-listed company ticker. The tool resolves it to the SEC CIK; class tickers may use a dot or hyphen.",
};

function createCompanyProfileTool(provider: SecDataProvider): RegisteredTool {
  return {
    name: "get_sec_company_profile",
    description:
      "Resolve a US public-company ticker to its official SEC identity and return filing metadata, SIC classification, fiscal year end, exchanges, and the latest material filings. This is official metadata, not a narrative business description.",
    category: "non_trading",
    inputSchema: schema({
      symbol: SYMBOL_PROPERTY,
      recent_filings: { type: "number", description: "Number of recent material filings to include. Defaults to 5; allowed range 0-20." },
    }),
    execute: async (input) => {
      const symbol = requiredSymbol(input);
      if (!symbol) return { summary: "SEC company profile requires a symbol.", error: { code: "invalid_symbol", message: "symbol is required" } };
      try {
        const company = await companyFor(provider, symbol);
        const submissions = await provider.getSubmissions(company.cik);
        const filingLimit = boundedInteger(input["recent_filings"], 5, 0, 20);
        const filings = recentFilings(submissions)
          .filter((filing) => MATERIAL_FORMS.includes(filing.form.replace(/\/A$/, "")))
          .slice(0, filingLimit)
          .map((filing) => filingJson(company, filing));
        const data: JsonObject = {
          requested_symbol: symbol,
          sec_ticker: company.ticker,
          cik: paddedCik(company.cik),
          name: stringValue(submissions["name"]) || company.title,
          entity_type: stringValue(submissions["entityType"]) || null,
          sic: stringValue(submissions["sic"]) || null,
          sic_description: stringValue(submissions["sicDescription"]) || null,
          fiscal_year_end: stringValue(submissions["fiscalYearEnd"]) || null,
          state_of_incorporation: stringValue(submissions["stateOfIncorporation"]) || null,
          tickers: stringArray(submissions["tickers"]),
          exchanges: stringArray(submissions["exchanges"]),
          website: stringValue(submissions["website"]) || null,
          investor_website: stringValue(submissions["investorWebsite"]) || null,
          category: stringValue(submissions["category"]) || null,
          former_names: arrayValue(submissions["formerNames"]) as JsonValue[],
          latest_material_filings: filings,
          source: "SEC EDGAR Submissions API",
          source_url: cikSource(company.cik, "submissions"),
        };
        return {
          summary: `${company.ticker} resolves to SEC CIK ${paddedCik(company.cik)} (${data["name"]}); returned ${filings.length} material filing(s).`,
          generation_context: { data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No SEC company mapping/.test(message)) {
          return { summary: message, error: { code: "sec_company_not_found", message } };
        }
        return toolError(error, symbol);
      }
    },
  };
}

function createFilingsTool(provider: SecDataProvider): RegisteredTool {
  return {
    name: "get_sec_filings",
    description:
      "List recent SEC filings for one US public company with form, filing/report dates, accession number, XBRL flags, and official EDGAR document links. Filter by forms and absolute dates.",
    category: "non_trading",
    inputSchema: schema({
      symbol: SYMBOL_PROPERTY,
      forms: { type: "array", items: { type: "string" }, description: "SEC form types to include, such as 10-K, 10-Q, 8-K, 20-F, or 6-K. Defaults to material periodic and current-report forms." },
      from_date: { type: "string", description: "Optional inclusive filing date in YYYY-MM-DD format." },
      to_date: { type: "string", description: "Optional inclusive filing date in YYYY-MM-DD format." },
      include_amendments: { type: "boolean", description: "Include /A amendments for requested forms. Defaults to true." },
      limit: { type: "number", description: "Maximum filings to return. Defaults to 10; allowed range 1-50." },
    }),
    execute: async (input) => {
      const symbol = requiredSymbol(input);
      if (!symbol) return { summary: "SEC filings lookup requires a symbol.", error: { code: "invalid_symbol", message: "symbol is required" } };
      const rawForms = input["forms"];
      if (rawForms !== undefined && (!Array.isArray(rawForms) || rawForms.length === 0 || rawForms.some((form) => typeof form !== "string" || !form.trim()))) {
        return { summary: "SEC filings forms must be a non-empty list of form names.", error: { code: "invalid_forms", message: "forms must be a non-empty string array" } };
      }
      const fromDate = typeof input["from_date"] === "string" ? input["from_date"].trim() : "";
      const toDate = typeof input["to_date"] === "string" ? input["to_date"].trim() : "";
      if ((fromDate && !DATE_PATTERN.test(fromDate)) || (toDate && !DATE_PATTERN.test(toDate)) || (fromDate && toDate && fromDate > toDate)) {
        return { summary: "SEC filing date range is invalid.", error: { code: "invalid_date_range", message: "dates must be YYYY-MM-DD and from_date must not exceed to_date" } };
      }

      try {
        const company = await companyFor(provider, symbol);
        const submissions = await provider.getSubmissions(company.cik);
        const forms = (rawForms === undefined ? MATERIAL_FORMS : stringArray(rawForms)).map((form) => form.trim().toUpperCase());
        const includeAmendments = input["include_amendments"] !== false;
        const limit = boundedInteger(input["limit"], 10, 1, 50);
        const matchesForm = (form: string): boolean => forms.some((requested) =>
          form === requested || (includeAmendments && form === `${requested}/A`));
        const matched = recentFilings(submissions).filter((filing) =>
          matchesForm(filing.form)
          && (!fromDate || filing.filingDate >= fromDate)
          && (!toDate || filing.filingDate <= toDate));
        const filings = matched.slice(0, limit).map((filing) => filingJson(company, filing));
        const data: JsonObject = {
          requested_symbol: symbol,
          sec_ticker: company.ticker,
          company_name: stringValue(submissions["name"]) || company.title,
          cik: paddedCik(company.cik),
          filters: {
            forms,
            from_date: fromDate || null,
            to_date: toDate || null,
            include_amendments: includeAmendments,
          },
          matched_count: matched.length,
          returned_count: filings.length,
          filings,
          history_scope: "Recent submissions included in the company's SEC Submissions API response; older files may require the supplemental submissions files.",
          source: "SEC EDGAR Submissions API",
          source_url: cikSource(company.cik, "submissions"),
        };
        return {
          summary: `SEC returned ${filings.length} of ${matched.length} matching filing(s) for ${company.ticker}.`,
          generation_context: { data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No SEC company mapping/.test(message)) {
          return { summary: message, error: { code: "sec_company_not_found", message } };
        }
        return toolError(error, symbol);
      }
    },
  };
}

function acceptedForm(form: string, periodType: string): boolean {
  const base = form.replace(/\/A$/, "");
  if (periodType === "annual") return ["10-K", "20-F", "40-F"].includes(base);
  if (periodType === "quarterly") return ["10-Q", "6-K"].includes(base);
  return ["10-K", "10-Q", "20-F", "40-F", "6-K"].includes(base);
}

function factRecords(
  company: SecCompanyIdentifier,
  payload: Record<string, unknown>,
  definition: MetricDefinition,
  periodType: string,
  periods: number,
): { taxonomy: string; concept: string; label: string; description: string; unit: string; facts: JsonObject[] } | undefined {
  const taxonomies = asRecord(payload["facts"]);
  if (!taxonomies) return undefined;

  for (const candidate of definition.candidates) {
    const taxonomy = asRecord(taxonomies[candidate.taxonomy]);
    const concept = asRecord(taxonomy?.[candidate.concept]);
    const units = asRecord(concept?.["units"]);
    if (!concept || !units) continue;
    const unit = definition.preferredUnits.find((preferred) => Array.isArray(units[preferred]))
      ?? Object.keys(units).find((key) => Array.isArray(units[key]));
    if (!unit) continue;

    const deduped = new Map<string, Record<string, unknown>>();
    for (const raw of arrayValue(units[unit])) {
      const fact = asRecord(raw);
      if (!fact) continue;
      const form = stringValue(fact["form"]);
      const end = stringValue(fact["end"]);
      const filed = stringValue(fact["filed"]);
      const accession = stringValue(fact["accn"]);
      if (!acceptedForm(form, periodType) || !end || !filed || !accession || typeof fact["val"] !== "number") continue;
      const key = `${stringValue(fact["start"])}|${end}|${stringValue(fact["fp"])}|${unit}`;
      const previous = deduped.get(key);
      if (!previous || stringValue(previous["filed"]) < filed) deduped.set(key, fact);
    }

    const selected = [...deduped.values()]
      .sort((left, right) =>
        stringValue(right["end"]).localeCompare(stringValue(left["end"]))
        || stringValue(right["filed"]).localeCompare(stringValue(left["filed"])))
      .slice(0, periods)
      .map((fact): JsonObject => {
        const accession = stringValue(fact["accn"]);
        const filing: Filing = {
          accessionNumber: accession,
          filingDate: stringValue(fact["filed"]),
          reportDate: stringValue(fact["end"]),
          acceptanceDateTime: "",
          form: stringValue(fact["form"]),
          items: "",
          isXBRL: 1,
          isInlineXBRL: null,
          primaryDocument: "",
          primaryDocDescription: "",
        };
        return {
          value: fact["val"] as number,
          unit,
          start: stringValue(fact["start"]) || null,
          end: stringValue(fact["end"]),
          filed: stringValue(fact["filed"]),
          form: stringValue(fact["form"]),
          fiscal_year: numberOrNull(fact["fy"]),
          fiscal_period: stringValue(fact["fp"]) || null,
          frame: stringValue(fact["frame"]) || null,
          accession_number: accession,
          filing_index_url: filingUrls(company, filing).index,
        };
      });
    if (selected.length === 0) continue;
    return {
      taxonomy: candidate.taxonomy,
      concept: candidate.concept,
      label: stringValue(concept["label"]) || definition.label,
      description: stringValue(concept["description"]),
      unit,
      facts: selected,
    };
  }
  return undefined;
}

function createCompanyFactsTool(provider: SecDataProvider): RegisteredTool {
  const metricNames = Object.keys(SEC_METRICS) as SecMetric[];
  return {
    name: "get_sec_company_facts",
    description:
      "Return exact standardized US-GAAP or IFRS XBRL facts reported by one SEC filer for selected financial metrics. Values retain form, fiscal period, filing date, accession number, taxonomy concept, unit, and source link; company-specific extension and segment facts are not inferred.",
    category: "non_trading",
    inputSchema: schema({
      symbol: SYMBOL_PROPERTY,
      metrics: { type: "array", items: { type: "string", enum: metricNames }, description: "Metrics to return. Defaults to the core income statement, balance sheet, cash flow, per-share, and share-count metrics." },
      period_type: { type: "string", enum: ["annual", "quarterly", "all"], description: "Filter by annual filings, quarterly filings, or both. Defaults to all." },
      periods: { type: "number", description: "Maximum distinct reported periods per metric. Defaults to 4; allowed range 1-12." },
    }),
    execute: async (input) => {
      const symbol = requiredSymbol(input);
      if (!symbol) return { summary: "SEC company facts lookup requires a symbol.", error: { code: "invalid_symbol", message: "symbol is required" } };
      const rawMetrics = input["metrics"];
      const metrics = rawMetrics === undefined ? metricNames : stringArray(rawMetrics) as SecMetric[];
      if (metrics.length === 0 || metrics.some((metric) => !Object.hasOwn(SEC_METRICS, metric))) {
        return { summary: "SEC company facts metrics are invalid.", error: { code: "invalid_metrics", message: `metrics must be selected from: ${metricNames.join(", ")}` } };
      }
      const periodType = input["period_type"] === "annual" || input["period_type"] === "quarterly" ? input["period_type"] : "all";
      const periods = boundedInteger(input["periods"], 4, 1, 12);

      try {
        const company = await companyFor(provider, symbol);
        const payload = await provider.getCompanyFacts(company.cik);
        const returned: JsonObject = {};
        const unavailable: string[] = [];
        for (const metric of metrics) {
          const result = factRecords(company, payload, SEC_METRICS[metric], periodType, periods);
          if (!result) {
            unavailable.push(metric);
            continue;
          }
          returned[metric] = {
            label: result.label,
            description: result.description || null,
            taxonomy: result.taxonomy,
            concept: result.concept,
            unit: result.unit,
            facts: result.facts,
          };
        }
        const entityName = stringValue(payload["entityName"]) || company.title;
        const data: JsonObject = {
          requested_symbol: symbol,
          sec_ticker: company.ticker,
          company_name: entityName,
          cik: paddedCik(company.cik),
          period_type: periodType,
          periods_per_metric: periods,
          metrics: returned,
          unavailable_metrics: unavailable,
          interpretation_note: "Facts are exact as-filed XBRL values. Do not combine periods, units, GAAP/IFRS concepts, or calculate derived metrics without a deterministic calculation step.",
          coverage_note: "The SEC Company Facts API includes standardized taxonomy facts for the whole filer; company-specific extension and segment facts may be absent.",
          source: "SEC EDGAR Company Facts API",
          source_url: cikSource(company.cik, "facts"),
        };
        return {
          summary: `SEC returned ${Object.keys(returned).length} metric(s) for ${company.ticker}; ${unavailable.length} requested metric(s) unavailable.`,
          generation_context: { data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No SEC company mapping/.test(message)) {
          return { summary: message, error: { code: "sec_company_not_found", message } };
        }
        return toolError(error, symbol);
      }
    },
  };
}

export function createSecTools(options: { provider?: SecDataProvider } = {}): RegisteredTool[] {
  const provider = options.provider ?? createSecClient();
  return [
    createCompanyProfileTool(provider),
    createFilingsTool(provider),
    createCompanyFactsTool(provider),
  ];
}
