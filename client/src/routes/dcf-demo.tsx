import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TopicWorkspace } from "@/components/workspace/TopicWorkspace";
import type { ContentWithUser } from "@/components/chat/types";
import type { TopicSummary } from "@/types/core";
import type {
    Assumption, CurrentWorkbookView, ModelContextView, Period, SourceStatementRowView, Unit, WorkbookCellView, WorkbookRowView,
} from "@/types/financialModel";

// Local, fixed data for visual review only. The values mirror the AAPL
// end-to-end run; this route does not call an API or mutate a financial model.
const usd: Unit = { kind: "currency", code: "USD" };
const percent: Unit = { kind: "percent" };
const ratio: Unit = { kind: "ratio" };
const years = Array.from({ length: 10 }, (_, index): Period => ({
    id: `FY${2021 + index}`,
    label: `FY${2021 + index}`,
    start: `${2020 + index}-09-01`,
    end: `${2021 + index}-09-30`,
    cls: index < 5 ? "actual" : "forecast",
}));

const sources = (value: number | null, forecast: boolean): WorkbookCellView => ({
    value,
    status: value === null ? "not_applicable" : "ok",
    source: value === null ? { kind: "none" } : forecast ? { kind: "formula", definitionIndex: 0 } : { kind: "fact", factId: "sec-10k-mock" },
    diagnostics: [],
    dependencies: [],
});

const forecastPeriodIds = years.slice(5).map((period) => period.id);

/** The demo is a fixed revision, but it still travels through the production
 * workbook grid. Keep its formula provenance real enough to exercise the
 * same cell-level dependency highlighting as an API-backed model. */
type DemoFormula = {
    source: string;
    dependenciesAt: (periodIndex: number) => Array<{ lineItemId: string; periodId: string }>;
};

const samePeriod = (periodIndex: number, ...lineItemIds: string[]) =>
    lineItemIds.map((lineItemId) => ({ lineItemId, periodId: years[periodIndex]!.id }));

function demoFormula(lineItemId: string): DemoFormula | undefined {
    switch (lineItemId) {
        case "revenue.total":
            return { source: "revenue.product + revenue.service", dependenciesAt: (index) => samePeriod(index, "revenue.product", "revenue.service") };
        case "revenue.product":
            return { source: "LAG(revenue.product, 1) * (1 + growth.revenue.product)", dependenciesAt: (index) => [...samePeriod(index - 1, "revenue.product"), ...samePeriod(index, "growth.revenue.product")] };
        case "revenue.service":
            return { source: "LAG(revenue.service, 1) * (1 + growth.revenue.service)", dependenciesAt: (index) => [...samePeriod(index - 1, "revenue.service"), ...samePeriod(index, "growth.revenue.service")] };
        case "revenue.product.gross_profit":
            return { source: "revenue.product * metric.custom.product_gross_margin", dependenciesAt: (index) => samePeriod(index, "revenue.product", "metric.custom.product_gross_margin") };
        case "revenue.service.gross_profit":
            return { source: "revenue.service * metric.custom.service_gross_margin", dependenciesAt: (index) => samePeriod(index, "revenue.service", "metric.custom.service_gross_margin") };
        case "gross_profit":
            return { source: "revenue.product.gross_profit + revenue.service.gross_profit", dependenciesAt: (index) => samePeriod(index, "revenue.product.gross_profit", "revenue.service.gross_profit") };
        case "operating_expenses":
            return { source: "revenue.total * metric.custom.opex_to_revenue", dependenciesAt: (index) => samePeriod(index, "revenue.total", "metric.custom.opex_to_revenue") };
        case "operating_income":
            return { source: "gross_profit - operating_expenses", dependenciesAt: (index) => samePeriod(index, "gross_profit", "operating_expenses") };
        case "depreciation_amortization":
            return { source: "revenue.total * ratio.da_to_revenue", dependenciesAt: (index) => samePeriod(index, "revenue.total", "ratio.da_to_revenue") };
        case "ebitda":
            return { source: "operating_income + depreciation_amortization", dependenciesAt: (index) => samePeriod(index, "operating_income", "depreciation_amortization") };
        case "nopat":
            return { source: "operating_income * (1 - tax_rate)", dependenciesAt: (index) => samePeriod(index, "operating_income", "tax_rate") };
        case "operating_working_capital":
            return { source: "revenue.total * ratio.operating_nwc_to_revenue", dependenciesAt: (index) => samePeriod(index, "revenue.total", "ratio.operating_nwc_to_revenue") };
        case "capital_expenditures":
            return { source: "revenue.total * ratio.capex_to_revenue", dependenciesAt: (index) => samePeriod(index, "revenue.total", "ratio.capex_to_revenue") };
        case "change_nwc":
            return { source: "operating_working_capital - LAG(operating_working_capital, 1)", dependenciesAt: (index) => [...samePeriod(index, "operating_working_capital"), ...samePeriod(index - 1, "operating_working_capital")] };
        case "fcff":
            return { source: "nopat + depreciation_amortization - capital_expenditures - change_nwc", dependenciesAt: (index) => samePeriod(index, "nopat", "depreciation_amortization", "capital_expenditures", "change_nwc") };
        case "metric.gross_margin":
            return { source: "gross_profit / revenue.total", dependenciesAt: (index) => samePeriod(index, "gross_profit", "revenue.total") };
        case "metric.ebitda_margin":
            return { source: "ebitda / revenue.total", dependenciesAt: (index) => samePeriod(index, "ebitda", "revenue.total") };
        case "margin.operating":
            return { source: "operating_income / revenue.total", dependenciesAt: (index) => samePeriod(index, "operating_income", "revenue.total") };
        default:
            return undefined;
    }
}

function assumption(
    assumptionId: string,
    lineItemId: string,
    values: number[],
    unit: Unit,
    rationale: string,
): Assumption {
    return {
        assumptionId, lineItemId, periods: forecastPeriodIds, payload: { kind: "values", values, unit },
        sourceType: "analyst_inference", sourceRefs: [`history:${lineItemId}:FY2021-FY2025`],
        asOfDate: "2026-08-12", rationale,
    };
}

function row(
    lineItemId: string,
    label: string,
    section: WorkbookRowView["section"],
    unit: Unit,
    values: Array<number | null>,
    order: number,
    parentId?: string,
    assumptions: Assumption[] = [],
): WorkbookRowView {
    const formula = demoFormula(lineItemId);
    return {
        lineItemId, label, section, unit, order, parentId, role: lineItemId,
        sources: { historical: "actual", forecast: "formula" },
        formulas: formula ? [{ appliesTo: "forecast", periodIds: years.slice(5).map((period) => period.id), source: formula.source }] : [],
        assumptions,
        cells: Object.fromEntries(years.map((period, index) => {
            const matchingAssumption = assumptions.find((item) => item.periods.includes(period.id));
            const calculated = period.cls === "forecast" && formula !== undefined;
            const cell = {
                ...sources(values[index] ?? null, calculated),
                dependencies: calculated ? formula.dependenciesAt(index) : [],
            };
            return [period.id, matchingAssumption
                ? { ...cell, source: { kind: "assumption" as const, assumptionId: matchingAssumption.assumptionId }, dependencies: [] }
                : cell];
        })),
    };
}

function sourceRow(sourceLineItemId: string, label: string, unit: Unit, values: Array<number | null>): SourceStatementRowView {
    return {
        sourceLineItemId,
        label,
        unit,
        cells: Object.fromEntries(years.slice(0, 5).map((period, index) => [period.id, sources(values[index] ?? null, false)])),
    };
}

type DemoUnifiedRow = readonly [statement: "i" | "b" | "c", rowId: string, label: string, values: Array<number | null>];

// Complete unified face statements from the same AAPL revision that powers the
// DCF mock. Currency values are stored in USD millions to keep this fixture
// readable; shares and per-share values retain their native units.
const demoUnifiedRows: DemoUnifiedRow[] = [["i","cost_of_sales","Cost of sales",[212981,223546,214137,210352,220960]],["i","gross_margin","Gross margin",[152836,170782,169148,180683,195201]],["i","research_and_development","Research and development",[21914,26251,29915,31370,34550]],["i","selling_general_administrative","Selling, general and administrative",[21973,25094,24932,26097,27601]],["i","total_operating_expenses","Total operating expenses",[43887,51345,54847,57467,62151]],["i","operating_income","Operating income",[108949,119437,114301,123216,133050]],["i","other_income_expense","Other income/(expense), net",[258,-334,-565,269,-321]],["i","income_before_taxes","Income before provision for income taxes",[109207,119103,113736,123485,132729]],["i","income_tax_expense","Provision for income taxes",[14527,19300,16741,29749,20719]],["i","net_income","Net income",[94680,99803,96995,93736,112010]],["i","eps_basic","Earnings per share, basic",[5.67,6.15,6.16,6.11,7.49]],["i","eps_diluted","Earnings per share, diluted",[5.61,6.11,6.13,6.08,7.46]],["i","shares_basic","Weighted-average shares, basic",[16701272000,16215963000,15744231000,15343783000,14948500000]],["i","shares_diluted","Weighted-average shares, diluted",[16864919000,16325819000,15812547000,15408095000,15004697000]],["b","cash_and_equivalents","Cash and cash equivalents",[34940,23646,29965,29943,35934]],["b","marketable_securities_current","Marketable securities (current)",[27699,24658,31590,35228,18763]],["b","accounts_receivable_net","Accounts receivable, net",[26278,28184,29508,33410,39777]],["b","vendor_nontrade_receivables","Vendor non-trade receivables",[25228,32748,31477,32833,33180]],["b","inventories","Inventories",[6580,4946,6331,7286,5718]],["b","other_current_assets","Other current assets",[14111,21223,14695,14287,14585]],["b","total_current_assets","Total current assets",[134836,135405,143566,152987,147957]],["b","marketable_securities_noncurrent","Marketable securities (non-current)",[127877,120805,100544,91479,77723]],["b","ppe_net","Property, plant and equipment, net",[39440,42117,43715,45680,49834]],["b","other_noncurrent_assets","Other non-current assets",[48849,54428,64758,74834,83727]],["b","total_noncurrent_assets","Total non-current assets",[216166,217350,209017,211993,211284]],["b","total_assets","Total assets",[351002,352755,352583,364980,359241]],["b","accounts_payable","Accounts payable",[54763,64115,62611,68960,69860]],["b","other_current_liabilities","Other current liabilities",[47493,60845,58829,78304,66387]],["b","deferred_revenue_current","Deferred revenue",[7612,7912,8061,8249,9055]],["b","commercial_paper","Commercial paper",[6000,9982,5985,9967,7979]],["b","term_debt_current","Term debt (current)",[9613,11128,9822,10912,12350]],["b","total_current_liabilities","Total current liabilities",[125481,153982,145308,176392,165631]],["b","term_debt_noncurrent","Term debt (non-current)",[109106,98959,95281,85750,78328]],["b","other_noncurrent_liabilities","Other non-current liabilities",[53325,49142,49848,45888,41549]],["b","total_noncurrent_liabilities","Total non-current liabilities",[162431,148101,145129,131638,119877]],["b","total_liabilities","Total liabilities",[287912,302083,290437,308030,285508]],["b","common_stock_shares_outstanding","Common stock, shares outstanding",[null,15943425000,15550061000,15116786000,14773260000]],["b","common_stock_shares_issued","Common stock, shares issued",[null,15943425000,15550061000,15116786000,14773260000]],["b","common_stock_apic","Common stock and additional paid-in capital",[57365,64849,73812,83276,93568]],["b","retained_earnings","Retained earnings/(Accumulated deficit)",[5562,-3068,-214,-19154,-14264]],["b","aoci","Accumulated other comprehensive income/(loss)",[163,-11109,-11452,-7172,-5571]],["b","total_equity","Total shareholders' equity",[63090,50672,62146,56950,73733]],["b","total_liabilities_and_equity","Total liabilities and shareholders' equity",[351002,352755,352583,364980,359241]],["c","cash_beginning_balance","Cash, cash equivalents and restricted cash, beginning balances",[null,35929,24977,30737,29943]],["c","net_income_cf","Net income",[94680,99803,96995,93736,112010]],["c","depreciation_amortization","Depreciation and amortization",[11284,11104,11519,11445,11698]],["c","share_based_compensation_cf","Share-based compensation expense",[7906,9038,10833,11688,12863]],["c","other_noncash_adjustments","Other non-cash adjustments",[4921,-1006,2227,2266,89]],["c","change_accounts_receivable","Change in accounts receivable, net",[10125,1823,1688,3788,6682]],["c","change_vendor_nontrade_receivables","Change in vendor non-trade receivables",[3903,7520,-1271,1356,347]],["c","change_inventories","Change in inventories",[2642,-1484,1618,1046,-1400]],["c","change_other_operating_assets","Change in other current and non-current assets",[8042,6499,5684,11731,9197]],["c","change_accounts_payable","Change in accounts payable",[12326,9448,-1889,6020,902]],["c","change_other_operating_liabilities","Change in other current and non-current liabilities",[7475,6110,3031,15552,-11076]],["c","cash_from_operations","Cash generated by operating activities",[104038,122151,110543,118254,111482]],["c","purchases_marketable_securities","Purchases of marketable securities",[109558,76923,29513,48656,24407]],["c","proceeds_maturities_marketable_securities","Proceeds from maturities of marketable securities",[59023,29917,39686,51211,40907]],["c","proceeds_sales_marketable_securities","Proceeds from sales of marketable securities",[47460,37446,5828,11135,12890]],["c","payments_ppe","Payments for acquisition of property, plant and equipment",[11085,10708,10959,9447,12715]],["c","other_investing","Other investing activities",[385,2086,1337,1308,1480]],["c","cash_from_investing","Cash generated by/(used in) investing activities",[-14545,-22354,3705,2935,15195]],["c","payments_tax_withholding_equity_awards","Payments for taxes related to net share settlement of equity awards",[6556,6223,5431,5441,5960]],["c","payments_dividends","Payments for dividends and dividend equivalents",[14467,14841,15025,15234,15421]],["c","repurchases_common_stock","Repurchases of common stock",[85971,89402,77550,94949,90711]],["c","proceeds_issuance_term_debt","Proceeds from issuance of term debt, net",[20393,5465,5228,0,4481]],["c","repayments_term_debt","Repayments of term debt",[8750,9543,11151,9958,10932]],["c","proceeds_repayments_commercial_paper","Proceeds from/(Repayments of) commercial paper, net",[1022,3955,-3978,3960,-2032]],["c","other_financing","Other financing activities",[976,-160,-581,-361,-111]],["c","cash_from_financing","Cash used in financing activities",[-93353,-110749,-108488,-121983,-120686]],["c","cash_increase_decrease","Increase/(Decrease) in cash, cash equivalents and restricted cash",[-3860,-10952,5760,-794,5991]],["c","cash_ending_balance","Cash, cash equivalents and restricted cash, ending balances",[35929,24977,30737,29943,35934]],["i","net_sales","Net sales",[365817,394328,383285,391035,416161]]];

function unifiedDemoRows(statement: DemoUnifiedRow[0]): SourceStatementRowView[] {
    return demoUnifiedRows.filter(([kind]) => kind === statement).map(([_, rowId, label, values]) => {
        const unit: Unit = rowId.startsWith("eps_") ? { kind: "per_share", code: "USD" }
            : rowId.includes("shares_") ? { kind: "shares" }
            : usd;
        const nativeValues = unit.kind === "currency" ? values.map((value) => value === null ? null : value * 1_000_000) : values;
        return sourceRow(`unified.${rowId}`, label, unit, nativeValues);
    });
}

const revenue = [365817, 394328, 383285, 391035, 416161, 441540, 468371, 498308, 529811, 562848].map((value) => value * 1_000_000);
const operatingIncome = [108949, 119437, 114301, 123216, 133050, 143104, 155289, 168630, 182784, 197731].map((value) => value * 1_000_000);
const ebitda = [120233, 130541, 125820, 134661, 144748, 155909, 168872, 183081, 198149, 214054].map((value) => value * 1_000_000);
const nopat = [94456, 100083, 97477, 93532, 112281, 120207, 130443, 141649, 153539, 166094].map((value) => value * 1_000_000);
const fcff = [null, 108579, 99756, 115737, 95609, 125036, 134252, 145880, 157995, 170773].map((value) => value === null ? null : value * 1_000_000);
const productRevenue = [297392, 316199, 298085, 294866, 307003, 319283, 332054, 346997, 362612, 378929].map((value) => value * 1_000_000);
const serviceRevenue = [68425, 78129, 85200, 96169, 109158, 122257, 136317, 151311, 167199, 183919].map((value) => value * 1_000_000);
const productGrossMargin = [0.353493, 0.362835, 0.365007, 0.371806, 0.367707, 0.365, 0.366, 0.367, 0.368, 0.369];
const serviceGrossMargin = [0.697260, 0.717454, 0.708275, 0.738804, 0.754081, 0.75, 0.751, 0.752, 0.753, 0.754];
const productGrossProfit = productRevenue.map((value, index) => value * productGrossMargin[index]!);
const serviceGrossProfit = serviceRevenue.map((value, index) => value * serviceGrossMargin[index]!);
const grossProfit = productGrossProfit.map((value, index) => value + serviceGrossProfit[index]!);
const operatingExpenses = [43887, 51345, 54847, 57467, 62151, 65127, 68616, 72504, 76558, 80769].map((value) => value * 1_000_000);
const opexToRevenue = operatingExpenses.map((value, index) => value / revenue[index]!);
const depreciation = [11284, 11104, 11519, 11445, 11698, 12805, 13583, 14451, 15365, 16323].map((value) => value * 1_000_000);
const taxableIncome = [109207, 119103, 113736, 123485, 132729, null, null, null, null, null].map((value) => value === null ? null : value * 1_000_000);
const taxExpense = [14527, 19300, 16741, 29749, 20719, null, null, null, null, null].map((value) => value === null ? null : value * 1_000_000);
const nwc = [-37671, -45771, -47490, -67697, -52042, -56517, -59951, -63783, -67816, -72045].map((value) => value * 1_000_000);
const capex = [11085, 10708, 10959, 9447, 12715, 12451, 13208, 14052, 14941, 15872].map((value) => value * 1_000_000);
const changeNwc = [null, -8100, -1719, -20207, 15655, -4475, -3434, -3832, -4032, -4229].map((value) => value === null ? null : value * 1_000_000);
const productGrowthAssumption = assumption("growth.revenue.product.fcst", "growth.revenue.product", [0.04, 0.04, 0.035, 0.035, 0.03], percent, "Mature hardware upgrade cycles support modest growth that tapers with market maturity.");
const serviceGrowthAssumption = assumption("growth.revenue.service.fcst", "growth.revenue.service", [0.12, 0.11, 0.1, 0.09, 0.08], percent, "Services retains faster growth but decelerates as its installed-base monetisation matures.");
const productGrossMarginAssumption = assumption("product_gross_margin.forecast", "metric.custom.product_gross_margin", [0.365, 0.366, 0.367, 0.368, 0.369], percent, "Product margin normalises below FY2025, then recovers modestly through mix and supply-chain efficiency.");
const serviceGrossMarginAssumption = assumption("service_gross_margin.forecast", "metric.custom.service_gross_margin", [0.75, 0.751, 0.752, 0.753, 0.754], percent, "Services stays structurally high-margin, with only modest expansion after content, infrastructure and regulatory costs.");
const opexToRevenueAssumption = assumption("opex_to_revenue.forecast", "metric.custom.opex_to_revenue", [0.1475, 0.1465, 0.1455, 0.1445, 0.1435], percent, "Shared R&D and SG&A scale gradually, while AI and infrastructure investment keeps the decline measured.");
const taxRateAssumption = assumption("tax_rate.fcst", "tax_rate", [0.16, 0.16, 0.16, 0.16, 0.16], percent, "Held near the normalized FY2025 effective tax rate.");
const daAssumption = assumption("ratio.da_to_revenue.fcst", "ratio.da_to_revenue", [0.029, 0.029, 0.029, 0.029, 0.029], ratio, "Held at the five-year historical average.");
const capexAssumption = assumption("ratio.capex_to_revenue.fcst", "ratio.capex_to_revenue", [0.0282, 0.0282, 0.0282, 0.0282, 0.0282], ratio, "Asset-light model supports a stable capital-intensity ratio.");
const nwcAssumption = assumption("ratio.operating_nwc_to_revenue.fcst", "ratio.operating_nwc_to_revenue", [-0.128, -0.128, -0.128, -0.128, -0.128], ratio, "Supplier financing and deferred revenue keep operating NWC negative.");
const terminalGrowthAssumption = assumption("terminal_growth_v1", "terminal_growth", [0.035], percent, "Final-year cash flow decelerates toward a sustainable long-run nominal growth rate.");
const exitMultipleAssumption = assumption("exit_multiple_v1", "exit_multiple", [20], ratio, "Terminal multiple reflects a mature, quality hardware-and-services compounder.");

const workbook: CurrentWorkbookView = {
    modelId: "mock-aapl-dcf-rev12",
    revision: 12,
    lifecycleStage: "valued",
    mode: "statement_mapping",
    periods: years,
    categoryGroups: [],
    reconciliationResults: [],
    diagnostics: [],
    sourceStatementReview: {
        selectedPeriodIds: years.slice(0, 5).map((period) => period.id),
        sheets: {
            income_statement: unifiedDemoRows("i"),
            balance_sheet: unifiedDemoRows("b"),
            cash_flow_statement: unifiedDemoRows("c"),
        },
        reconciliations: [],
    },
    sections: {
        history: [
            row("gross_profit", "Gross profit", "history", usd, grossProfit, 1),
            row("operating_expenses", "Operating expenses", "history", usd, operatingExpenses, 2),
            row("pretax_income", "Pretax income", "history", usd, taxableIncome, 3),
            row("income_tax_expense", "Income tax expense", "history", usd, taxExpense, 4),
            row("net_income", "Net income", "history", usd, [94680, 99803, 96995, 93736, 112010, null, null, null, null, null].map((value) => value === null ? null : value * 1_000_000), 5),
        ],
        metrics: [
            row("growth.revenue.total", "Revenue growth", "metrics", percent, [null, 0.078, -0.028, 0.020, 0.064, 0.061, 0.061, 0.064, 0.063, 0.062], 1),
            row("metric.gross_margin", "Gross margin", "metrics", percent, grossProfit.map((value, index) => value / revenue[index]!), 2),
            row("metric.ebitda_margin", "EBITDA margin", "metrics", percent, ebitda.map((value, index) => value / revenue[index]!), 3),
            row("margin.operating", "Operating margin", "metrics", percent, operatingIncome.map((value, index) => value / revenue[index]!), 4),
            row("metric.net_margin", "Net margin", "metrics", percent, [0.259, 0.253, 0.253, 0.240, 0.269, null, null, null, null, null], 5),
            row("metric.custom.product_gross_margin", "Product gross margin", "metrics", percent, productGrossMargin, 6, undefined, [productGrossMarginAssumption]),
            row("metric.custom.service_gross_margin", "Service gross margin", "metrics", percent, serviceGrossMargin, 7, undefined, [serviceGrossMarginAssumption]),
            row("metric.custom.opex_to_revenue", "Operating expense / revenue", "metrics", percent, opexToRevenue, 8, undefined, [opexToRevenueAssumption]),
        ],
        revenue: [
            row("revenue.total", "Revenue", "revenue", usd, revenue, 1),
            row("revenue.product", "Products revenue", "revenue", usd, productRevenue, 2, "revenue.total"),
            row("revenue.service", "Services revenue", "revenue", usd, serviceRevenue, 3, "revenue.total"),
            row("growth.revenue.product", "Product Revenue Growth", "revenue", percent, [null, null, null, null, null, 0.04, 0.04, 0.035, 0.035, 0.03], 4, undefined, [productGrowthAssumption]),
            row("growth.revenue.service", "Service Revenue Growth", "revenue", percent, [null, null, null, null, null, 0.12, 0.11, 0.1, 0.09, 0.08], 5, undefined, [serviceGrowthAssumption]),
            row("revenue.product.gross_profit", "Product gross profit", "revenue", usd, productGrossProfit, 6, "revenue.product"),
            row("revenue.service.gross_profit", "Service gross profit", "revenue", usd, serviceGrossProfit, 7, "revenue.service"),
        ],
        operations: [
            row("operating_income", "Operating income", "operations", usd, operatingIncome, 1),
            row("depreciation_amortization", "Depreciation and amortization", "operations", usd, depreciation, 2),
            row("ebitda", "EBITDA", "operations", usd, ebitda, 3),
            row("nopat", "NOPAT", "operations", usd, nopat, 4),
            row("operating_working_capital", "Operating working capital", "operations", usd, nwc, 5),
            row("capital_expenditures", "Capital expenditures", "operations", usd, capex, 6),
            row("change_nwc", "Change in NWC", "operations", usd, changeNwc, 7),
            row("tax_rate", "Tax Rate", "operations", percent, [null, null, null, null, null, 0.16, 0.16, 0.16, 0.16, 0.16], 8, undefined, [taxRateAssumption]),
            row("ratio.da_to_revenue", "D&A / Revenue", "operations", ratio, [null, null, null, null, null, 0.029, 0.029, 0.029, 0.029, 0.029], 9, undefined, [daAssumption]),
            row("ratio.capex_to_revenue", "Capex / Revenue", "operations", ratio, [null, null, null, null, null, 0.0282, 0.0282, 0.0282, 0.0282, 0.0282], 10, undefined, [capexAssumption]),
            row("ratio.operating_nwc_to_revenue", "Operating NWC / Revenue", "operations", ratio, [null, null, null, null, null, -0.128, -0.128, -0.128, -0.128, -0.128], 11, undefined, [nwcAssumption]),
        ],
        dcf: [
            row("fcff", "Free cash flow to firm", "dcf", usd, fcff, 1),
            row("wacc", "WACC", "dcf", percent, [null, null, null, null, null, 0.1029162, 0.1029162, 0.1029162, 0.1029162, 0.1029162], 2),
            row("terminal_growth", "Terminal growth", "dcf", percent, [null, null, null, null, null, null, null, null, null, 0.035], 3, undefined, [terminalGrowthAssumption]),
            row("exit_multiple", "Exit multiple", "dcf", ratio, [null, null, null, null, null, null, null, null, null, 20], 4, undefined, [exitMultipleAssumption]),
            row("cash_available_for_bridge", "Cash available for bridge", "dcf", usd, [62639, 48304, 61555, 65171, 54697, null, null, null, null, null].map((value) => value === null ? null : value * 1_000_000), 5),
            row("non_operating_investments", "Non-operating investments", "dcf", usd, [76769, 70661, 100544, 118798, 77723, null, null, null, null, null].map((value) => value === null ? null : value * 1_000_000), 6),
            row("debt", "Debt", "dcf", usd, [124719, 120069, 111088, 106629, 98657, null, null, null, null, null].map((value) => value === null ? null : value * 1_000_000), 7),
            row("diluted_shares", "Diluted shares", "dcf", { kind: "shares" }, [16864919000, 16426786000, 15943425000, 15550061000, 15004697000, null, null, null, null, null], 8),
        ],
    },
    waccSheet: {
        asOfDate: "2026-08-12",
        rows: [
            { rowId: "risk_free_rate", label: "Risk-free rate", unit: percent, source: "agent", value: 0.0524, missingInputs: [], provenance: { sourceType: "market_data", sourceRefs: ["30Y UST"], asOfDate: "2026-08-12", rationale: "Mocked from the AAPL E2E output." } },
            { rowId: "beta", label: "Beta", unit: { kind: "ratio" }, source: "agent", value: 1.2, missingInputs: [] },
            { rowId: "equity_risk_premium", label: "Equity risk premium", unit: percent, source: "agent", value: 0.043, missingInputs: [] },
            { rowId: "cost_of_debt", label: "Pre-tax cost of debt", unit: percent, source: "agent", value: 0.055, missingInputs: [] },
            { rowId: "wacc", label: "WACC", unit: percent, source: "computed", value: 0.1029162, missingInputs: [], formulaSource: "cost_of_equity × equity_weight + after_tax_cost_of_debt × debt_weight" },
        ],
    },
    valuation: {
        explicitPeriods: years.slice(5).map((period, index) => ({ periodId: period.id, fcff: fcff[index + 5]!, wacc: 0.1029162, discountFactor: [1.0502, 1.1583, 1.2775, 1.4090, 1.5540][index]!, presentValue: [119059, 115906, 114193, 112136, 109895][index]! * 1_000_000 })),
        perpetuityGrowth: { method: "perpetuity_growth", explicitPeriods: [], terminalValue: 2602475014950, terminalPresentValue: 1674731723790, terminalValuePercentOfEnterpriseValue: 0.745677, enterpriseValue: 2245921034180, bridge: [{ lineItemId: "cash_available_for_bridge", role: "cash_available_for_bridge", sign: 1, status: "numeric", value: 54697000000, appliedAdjustment: 54697000000, refs: [] }, { lineItemId: "non_operating_investments", role: "non_operating_investments", sign: 1, status: "numeric", value: 77723000000, appliedAdjustment: 77723000000, refs: [] }, { lineItemId: "debt", role: "debt", sign: -1, status: "numeric", value: 98657000000, appliedAdjustment: -98657000000, refs: [] }], equityValue: 2279684034180, dilutedShares: 15004697000, impliedValuePerShare: 151.9314 },
        exitMultiple: { method: "exit_multiple", explicitPeriods: [], terminalValue: 4281073009600, terminalPresentValue: 2754934721700, terminalValuePercentOfEnterpriseValue: 0.828272, enterpriseValue: 3326124032090, bridge: [{ lineItemId: "cash_available_for_bridge", role: "cash_available_for_bridge", sign: 1, status: "numeric", value: 54697000000, appliedAdjustment: 54697000000, refs: [] }, { lineItemId: "non_operating_investments", role: "non_operating_investments", sign: 1, status: "numeric", value: 77723000000, appliedAdjustment: 77723000000, refs: [] }, { lineItemId: "debt", role: "debt", sign: -1, status: "numeric", value: 98657000000, appliedAdjustment: -98657000000, refs: [] }], equityValue: 3359887032090, dilutedShares: 15004697000, impliedValuePerShare: 223.9224 },
        waccByGrowth: { rowVariable: "wacc_delta", columnVariable: "terminal_growth_delta", rowDeltas: [-0.01, -0.005, 0, 0.005, 0.01], columnDeltas: [-0.005, -0.0025, 0, 0.0025, 0.005], cells: [[166.10, 171.59, 177.55, 184.04, 191.15], [154.12, 158.73, 163.72, 169.12, 174.98], [143.78, 147.71, 151.93, 156.48, 161.38], [134.77, 138.15, 141.76, 145.63, 149.79], [126.84, 129.78, 132.90, 136.23, 139.79]].map((values, rowIndex) => values.map((impliedValuePerShare, columnIndex) => ({ rowDelta: [-0.01, -0.005, 0, 0.005, 0.01][rowIndex]!, columnDelta: [-0.005, -0.0025, 0, 0.0025, 0.005][columnIndex]!, impliedValuePerShare }))) },
        waccByMultiple: { rowVariable: "wacc_delta", columnVariable: "exit_multiple_delta", rowDeltas: [-0.01, -0.005, 0, 0.005, 0.01], columnDeltas: [-2, -1, 0, 1, 2], cells: [[213.34, 222.91, 232.47, 242.03, 251.60], [209.40, 218.77, 228.14, 237.51, 246.88], [205.56, 214.74, 223.92, 233.10, 242.28], [201.81, 210.81, 219.80, 228.80, 237.79], [198.15, 206.97, 215.78, 224.60, 233.41]].map((values, rowIndex) => values.map((impliedValuePerShare, columnIndex) => ({ rowDelta: [-0.01, -0.005, 0, 0.005, 0.01][rowIndex]!, columnDelta: [-2, -1, 0, 1, 2][columnIndex]!, impliedValuePerShare }))) },
    },
};

const context: ModelContextView = {
    model: { modelId: workbook.modelId, ownerAgentId: "mock", originSessionId: "mock", symbol: "AAPL", metadata: { demo: true }, currentRevision: 12, lifecycleStage: "valued", createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z" },
    revisionHistory: [
        { revision: 12, parentRevision: 11, lifecycleStage: "valued", createdAt: "2026-08-12T00:00:00Z", changes: [{ kind: "formula_set" }, { kind: "assumption_set" }], changedSections: ["revenue", "metrics", "operations", "history"], warningCount: 0, blockerCount: 0 },
        { revision: 11, parentRevision: 10, lifecycleStage: "valued", createdAt: "2026-08-12T00:00:00Z", changes: [{ kind: "valuation_config_set" }], changedSections: ["dcf"], warningCount: 0, blockerCount: 0 },
    ],
    currentWorkbook: workbook,
};

const DEMO_AGENT_ID = "demo-financial-agent";
const DEMO_TOPIC_ID = "demo-aapl-topic";
const demoTime = Date.UTC(2026, 7, 12, 7, 27, 0);
const activeTopic: TopicSummary = {
    id: DEMO_TOPIC_ID,
    name: "Apple valuation",
    leadSymbol: "AAPL",
    subjectSymbols: ["AAPL"],
    createdAt: demoTime - 86_400_000,
    lastMessage: { text: "Build a complete DCF model for AAPL from its SEC filings.", createdAt: demoTime },
    messageCount: 2,
    summary: "A completed, filing-grounded AAPL DCF model.",
    category: "single_name",
    categoryLocked: false,
};

const demoTopics: TopicSummary[] = [
    activeTopic,
    {
        id: "demo-msft-topic", name: "Microsoft cloud research", leadSymbol: "MSFT", subjectSymbols: ["MSFT"],
        createdAt: demoTime - 172_800_000, lastMessage: { text: "Compare Azure growth with peers.", createdAt: demoTime - 172_800_000 },
        messageCount: 6, summary: "Cloud and infrastructure research.", category: "single_name", categoryLocked: false,
    },
];

const demoMessages: ContentWithUser[] = [
    {
        id: "demo-user-aapl-dcf", user: "user", createdAt: demoTime - 1_007_132,
        text: "Build a complete DCF valuation model for AAPL from its SEC filings, end to end. Nothing has been prepared for you: extract the filing statements yourself, get the history unified and mapped onto the spine, analyze where the profit actually comes from, author the forecast on your own judgment, complete the WACC sheet and the terminal assumptions, and finish only once the model reads as valued.",
    },
    {
        id: "demo-agent-aapl-dcf", user: "assistant", createdAt: demoTime,
        text: `Completed AAPL's end-to-end DCF model: **valued · revision 12**.

I extracted and unified FY2021–FY2025 SEC 10-K statements, then completed historical mapping, revenue decomposition, a five-year forecast, FCFF, WACC, terminal values, and the equity bridge. The forecast now calculates Product and Service gross profit independently, then deducts shared operating expenses to derive Operating Profit.

**Valuation conclusion**

- Perpetuity growth: enterprise value $2.25T; implied value per share **$151.93**
- Exit multiple: enterprise value $3.33T; implied value per share **$223.92**
- WACC: **10.29%**; terminal value represents roughly **74–83%** of enterprise value

The two terminal methods differ materially, making terminal assumptions the primary sensitivity. The model, formulas, assumptions, source review, and revision history are all saved and can be inspected in the model tab.`,
        progressTasks: [
            { taskId: "extract", agent: "financial_modeling", description: "Extract and unify AAPL SEC filings", status: "completed", summary: "FY2021–FY2025 statements unified." },
            { taskId: "mapping", agent: "financial_modeling", description: "Map historical data to the DCF spine", status: "completed", summary: "Historical coverage committed." },
            { taskId: "valuation", agent: "financial_modeling", description: "Author forecast, WACC, and valuation", status: "completed", summary: "Segment-margin forecast reached valued at revision 12." },
        ],
    } as ContentWithUser,
];

export default function DcfDemo() {
    const queryClient = useQueryClient();
    const seeded = useRef(false);
    // Seed before TopicWorkspace mounts: its regular hooks find these values in
    // the same cache they use in production, so no API/LLM request is issued.
    if (!seeded.current) {
        queryClient.setQueryData(["messages", DEMO_AGENT_ID, DEMO_TOPIC_ID], demoMessages);
        queryClient.setQueryData(["financialModels", DEMO_AGENT_ID, DEMO_TOPIC_ID], [context.model]);
        queryClient.setQueryData(["financialModel", context.model.modelId], context);
        queryClient.setQueryData(["topicCharts", DEMO_AGENT_ID, DEMO_TOPIC_ID], []);
        queryClient.setQueryData(["topics", DEMO_AGENT_ID], { topics: demoTopics });
        queryClient.setQueryData(["researches", DEMO_AGENT_ID], { researches: [] });
        seeded.current = true;
    }
    return (
        <TopicWorkspace
            tenantId={DEMO_AGENT_ID}
            members={[activeTopic]}
            activeTopic={activeTopic}
            demo={{ rail: { topics: demoTopics, researches: [] }, initialSheetId: "dcf" }}
        />
    );
}
