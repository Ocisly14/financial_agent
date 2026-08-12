// Replaces AAPL's consolidated operating-margin forecast with a Products / Services gross-profit
// bridge in the persisted end-to-end model. Run with:
// node --experimental-strip-types --experimental-sqlite scripts/xbrl/e2e_test/rebuild-aapl-segment-margins.ts
// Optional: E2E_MODEL_DB_PATH, E2E_RESUME_MODEL_ID.
import path from "node:path";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { SqliteModelStore } from "../../../src/financial-model/store.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import type { FinancialModelSnapshot, ModelOperation } from "../../../src/financial-model/operations.ts";

const databasePath = path.resolve(process.env["E2E_MODEL_DB_PATH"]
  ?? "data/e2e-test/dcf-agent/aapl/financial-models.sqlite");
const modelId = process.env["E2E_RESUME_MODEL_ID"] ?? "fm_f4808513-257c-468c-94d7-640b2bd6d3e0";
const historical = ["FY2021", "FY2022", "FY2023", "FY2024", "FY2025"];
const forecast = ["FY2026", "FY2027", "FY2028", "FY2029", "FY2030"];
const asOfDate = "2025-09-27";

const sec2022 = "https://www.sec.gov/Archives/edgar/data/320193/000032019322000108/aapl-20220924.htm";
const sec2023 = "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm";
const sec2025 = "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm";
const store = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(databasePath, financialModelSnapshotCodec);
const service = new FinancialModelService(store, "aapl-segment-margin-rebuild");
const current = store.getRevision(modelId);
if (!current) throw new Error(`model not found: ${modelId} in ${databasePath}`);

const addRows: ModelOperation[] = [
  { kind: "add_line_item", lineItem: { id: "metric.custom.product_gross_margin", label: "Product Gross Margin", parentId: "custom_metrics", unit: { kind: "percent" }, description: "Products gross profit divided by Products revenue; Apple discloses both inputs." } },
  { kind: "add_line_item", lineItem: { id: "metric.custom.service_gross_margin", label: "Service Gross Margin", parentId: "custom_metrics", unit: { kind: "percent" }, description: "Services gross profit divided by Services revenue; Apple discloses both inputs." } },
  { kind: "add_line_item", lineItem: { id: "metric.custom.opex_to_revenue", label: "Operating Expense / Revenue", parentId: "custom_metrics", unit: { kind: "percent" }, description: "Shared R&D and SG&A expense as a percentage of total revenue." } },
  // The public tool schema now admits a revenue-stream parent; the engine still decides whether it is safe.
  { kind: "add_line_item", lineItem: { id: "gross_profit", label: "Product Gross Profit", parentId: "revenue.product", unit: { kind: "currency", code: "USD" } } } as unknown as ModelOperation,
  { kind: "add_line_item", lineItem: { id: "gross_profit", label: "Service Gross Profit", parentId: "revenue.service", unit: { kind: "currency", code: "USD" } } } as unknown as ModelOperation,
];

let result = service.applyOperations(modelId, current.revision, addRows);

const assumption = (assumptionId: string, lineItemId: string, periods: string[], values: number[], sourceType: "company_disclosure" | "analyst_inference", sourceRefs: string[], rationale: string): ModelOperation => ({
  kind: "set_assumption",
  assumption: { assumptionId, lineItemId, periods, payload: { kind: "values", values, unit: { kind: "percent" } }, sourceType, sourceRefs, asOfDate, rationale },
});

// Apple reports the segment gross-profit dollars.  The exact ratios below reproduce those amounts,
// rather than relying on the rounded percentage printed in the 10-K table.
result = service.applyOperations(modelId, result.revision, [
  assumption("product_gross_margin.actual", "metric.custom.product_gross_margin", historical,
    [105126 / 297392, 114728 / 316199, 108803 / 298085, 109633 / 294866, 112887 / 307003],
    "company_disclosure", [sec2022, sec2023, sec2025],
    "Products gross margin is calculated from Apple's disclosed Products gross profit and Products net sales for each fiscal year."),
  assumption("service_gross_margin.actual", "metric.custom.service_gross_margin", historical,
    [47710 / 68425, 56054 / 78129, 60345 / 85200, 71050 / 96169, 82314 / 109158],
    "company_disclosure", [sec2022, sec2023, sec2025],
    "Services gross margin is calculated from Apple's disclosed Services gross profit and Services net sales for each fiscal year."),
  { kind: "set_formula", formula: { lineItemId: "metric.custom.opex_to_revenue", appliesTo: "historical", source: "operating_expenses / revenue.total", periodIds: historical } },
  assumption("product_gross_margin.forecast", "metric.custom.product_gross_margin", forecast,
    [0.365, 0.366, 0.367, 0.368, 0.369], "analyst_inference", [sec2025],
    "Products gross margin starts below FY2025 because tariff, component-cost and mix pressure can offset scale, then recovers gradually with product mix and supply-chain efficiency; it does not assume an unearned step-up above Apple's historical range."),
  assumption("service_gross_margin.forecast", "metric.custom.service_gross_margin", forecast,
    [0.750, 0.751, 0.752, 0.753, 0.754], "analyst_inference", [sec2025],
    "Services retains a materially higher gross margin because of its software, advertising, cloud and subscription mix, but expands only modestly as content, infrastructure and regulatory costs temper the FY2025 mix benefit."),
  assumption("opex_to_revenue.forecast", "metric.custom.opex_to_revenue", forecast,
    [0.1475, 0.1465, 0.1455, 0.1445, 0.1435], "analyst_inference", [sec2025],
    "Shared R&D and SG&A gain modest scale against revenue, but remain elevated for AI, silicon, services infrastructure and go-to-market investment; this avoids allocating corporate costs artificially to Products or Services."),
]);

result = service.applyOperations(modelId, result.revision, [
  { kind: "set_formula", formula: { lineItemId: "revenue.product.gross_profit", appliesTo: "historical", source: "revenue.product * metric.custom.product_gross_margin", periodIds: historical } },
  { kind: "set_formula", formula: { lineItemId: "revenue.product.gross_profit", appliesTo: "forecast", source: "revenue.product * metric.custom.product_gross_margin", periodIds: forecast } },
  { kind: "set_formula", formula: { lineItemId: "revenue.service.gross_profit", appliesTo: "historical", source: "revenue.service * metric.custom.service_gross_margin", periodIds: historical } },
  { kind: "set_formula", formula: { lineItemId: "revenue.service.gross_profit", appliesTo: "forecast", source: "revenue.service * metric.custom.service_gross_margin", periodIds: forecast } },
  { kind: "set_formula", formula: { lineItemId: "gross_profit", appliesTo: "forecast", source: "revenue.product.gross_profit + revenue.service.gross_profit", periodIds: forecast } },
  { kind: "set_formula", formula: { lineItemId: "operating_expenses", appliesTo: "forecast", source: "revenue.total * metric.custom.opex_to_revenue", periodIds: forecast } },
  { kind: "set_formula", formula: { lineItemId: "operating_income", appliesTo: "forecast", source: "gross_profit - operating_expenses", periodIds: forecast } },
  { kind: "set_line_item_source", lineItemId: "margin.operating", range: "forecast", source: "formula" },
  { kind: "set_formula", formula: { lineItemId: "margin.operating", appliesTo: "forecast", source: "operating_income / revenue.total", periodIds: forecast } },
]);

const snapshot = result.currentWorkbook;
const rows = Object.values(snapshot.sections).flat();
const row = (id: string) => rows.find((candidate) => candidate.lineItemId === id)
  ?? (() => { throw new Error(`missing output row: ${id}`); })();
const value = (id: string, periodId: string) => row(id).cells[periodId]?.value;
for (const periodId of [...historical, ...forecast]) {
  console.log(`${periodId}: product GM ${(value("metric.custom.product_gross_margin", periodId)! * 100).toFixed(2)}% | service GM ${(value("metric.custom.service_gross_margin", periodId)! * 100).toFixed(2)}% | operating margin ${(value("margin.operating", periodId)! * 100).toFixed(2)}%`);
}
console.log(`Updated ${modelId} to revision ${result.revision}; lifecycle ${result.status}.`);
