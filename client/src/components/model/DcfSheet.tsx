import { buildDcfRows, formatCellValue } from "@/lib/workbook";
import type { CurrentWorkbookView, ExplicitPeriodValue, SensitivityMatrix, TerminalMethodResult, Unit } from "@/types/financialModel";
import { WorkbookGrid } from "./WorkbookGrid";

/** Fallback for a model too young to have a currency-typed row yet — keeps
 *  the old unitless rendering rather than inventing a currency code. */
const UNITLESS: Unit = { kind: "number" };

/** `TerminalMethodResult` carries no unit of its own. The whole model is built
 *  in one reporting currency, so any currency-typed row already committed to
 *  the operations/DCF build is authoritative for it — no need to thread a
 *  currency through the valuation payload itself. */
function currencyCodeFor(workbook: CurrentWorkbookView): string | undefined {
    for (const row of [
        ...workbook.sections.history, ...workbook.sections.revenue,
        ...workbook.sections.operations, ...workbook.sections.dcf,
    ]) {
        if (row.unit.kind === "currency") return row.unit.code;
    }
    return undefined;
}

/** The two figure classes on this sheet need different units: the four
 *  aggregate figures are currency amounts (0 decimals is correct at these
 *  magnitudes), `impliedValuePerShare` is a per-share figure that needs its
 *  2 decimals regardless of whether a currency code was found — that
 *  precision is about the quantity, not the currency. */
function valuationUnitsFor(currencyCode: string | undefined): { currency: Unit; perShare: Unit } {
    return {
        currency: currencyCode ? { kind: "currency", code: currencyCode } : UNITLESS,
        perShare: { kind: "per_share", code: currencyCode ?? "" },
    };
}

/**
 * The DCF tab is the model's audit trail from revenue through equity value.
 * Its rows remain the real workbook rows (and therefore retain formulas and
 * cell provenance); `buildDcfRows` only gives those cross-section rows the
 * order a valuation reader expects.
 */
export function DcfSheet({
    workbook,
    isCellChanged,
    scrollToLineItemId,
}: {
    workbook: CurrentWorkbookView;
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
    scrollToLineItemId?: string;
}) {
    const currencyCode = currencyCodeFor(workbook);
    const { rows, groupLabels } = buildDcfRows(workbook);
    const anchorPeriod = [...workbook.periods].reverse().find((period) => period.cls === "actual" || period.cls === "ttm")?.label;
    return (
        <div className="flex h-full flex-col overflow-auto">
            {/* `shrink-0` so the build rows keep their natural height. As a bare
                flex item the grid collapses to a sliver — the valuation block
                below takes its content height and the grid absorbs the whole
                shortfall, leaving two visible rows of a twenty-row model. */}
            <div className="shrink-0">
                <WorkbookGrid
                    rows={rows}
                    periods={workbook.periods}
                    isCellChanged={isCellChanged}
                    scrollToLineItemId={scrollToLineItemId}
                    groupLabels={groupLabels}
                />
            </div>
            {workbook.valuation && (
                <div className="border-t p-3">
                    <div className="mb-2 text-xs font-medium">Valuation</div>
                    <DiscountSchedule
                        periods={workbook.valuation.explicitPeriods}
                        terminalValue={workbook.valuation.perpetuityGrowth.terminalValue}
                        currencyCode={currencyCode}
                    />
                    <div className="grid gap-4 sm:grid-cols-2">
                        <TerminalCard title="Perpetuity Growth" result={workbook.valuation.perpetuityGrowth} currencyCode={currencyCode} />
                        <TerminalCard title="Exit Multiple" result={workbook.valuation.exitMultiple} currencyCode={currencyCode} />
                    </div>
                    <EquityBridge
                        result={workbook.valuation.perpetuityGrowth}
                        anchorPeriod={anchorPeriod}
                        currencyCode={currencyCode}
                    />
                    <Sensitivity title="WACC × Perpetuity Growth" matrix={workbook.valuation.waccByGrowth} currencyCode={currencyCode} />
                    <Sensitivity title="WACC × Exit Multiple" matrix={workbook.valuation.waccByMultiple} currencyCode={currencyCode} />
                </div>
            )}
        </div>
    );
}

function valueCell(value: number, unit: Unit) {
    return formatCellValue({ value, status: "ok", source: { kind: "none" }, diagnostics: [], dependencies: [] }, unit);
}

function DiscountSchedule({
    periods,
    terminalValue,
    currencyCode,
}: {
    periods: ExplicitPeriodValue[];
    terminalValue: number;
    currencyCode: string | undefined;
}) {
    if (periods.length === 0) return null;
    const { currency } = valuationUnitsFor(currencyCode);
    return (
        <div className="mb-4 overflow-x-auto">
            <div className="mb-1 text-xs font-medium">DCF Schedule</div>
            <table className="min-w-full text-xs">
                <thead>
                    <tr className="border-b text-muted-foreground">
                        <th className="px-2 py-1 text-left font-normal">Year</th>
                        <th className="px-2 py-1 text-right font-normal">Free Cash Flow</th>
                        <th className="px-2 py-1 text-right font-normal">WACC</th>
                        <th className="px-2 py-1 text-right font-normal">Discount Factor</th>
                        <th className="px-2 py-1 text-right font-normal">Terminal Value</th>
                        <th className="px-2 py-1 text-right font-normal">DCF</th>
                    </tr>
                </thead>
                <tbody>
                    {periods.map((period) => (
                        <tr key={period.periodId} className="border-b last:border-0">
                            <th scope="row" className="px-2 py-1 text-left font-normal">{period.periodId}</th>
                            <td className="px-2 py-1 text-right tabular-nums">{valueCell(period.fcff, currency)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{valueCell(period.wacc, { kind: "percent" })}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{valueCell(period.discountFactor, { kind: "ratio" })}</td>
                            <td className="px-2 py-1 text-right tabular-nums">
                                {period === periods[periods.length - 1] ? valueCell(terminalValue, currency) : ""}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums">{valueCell(period.presentValue, currency)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const BRIDGE_LABELS: Record<string, string> = {
    cash_available_for_bridge: "Cash",
    non_operating_investments: "Non-operating Investments",
    debt: "Debt",
    lease_liabilities: "Lease Liabilities",
    preferred_equity: "Preferred Equity",
    non_controlling_interests: "Non-controlling Interests",
};

function EquityBridge({
    result,
    anchorPeriod,
    currencyCode,
}: {
    result: TerminalMethodResult;
    anchorPeriod: string | undefined;
    currencyCode: string | undefined;
}) {
    const units = valuationUnitsFor(currencyCode);
    const titleSuffix = anchorPeriod ? ` (${anchorPeriod})` : "";
    return (
        <div className="mt-4 overflow-x-auto">
            <div className="mb-1 text-xs font-medium">Equity Bridge{titleSuffix}</div>
            <table className="min-w-[320px] text-xs">
                <tbody>
                    <BridgeLine label="Enterprise Value" value={result.enterpriseValue} unit={units.currency} />
                    {result.bridge.map((adjustment) => (
                        <BridgeLine
                            key={adjustment.lineItemId}
                            label={BRIDGE_LABELS[adjustment.lineItemId] ?? adjustment.lineItemId}
                            value={adjustment.appliedAdjustment}
                            unit={units.currency}
                            muted={adjustment.status === "not_applicable"}
                        />
                    ))}
                    <BridgeLine label="Equity" value={result.equityValue} unit={units.currency} strong />
                    <BridgeLine label="Shares Outstanding" value={result.dilutedShares} unit={{ kind: "shares" }} />
                    <BridgeLine label="Fair Value / Share" value={result.impliedValuePerShare} unit={units.perShare} strong />
                </tbody>
            </table>
        </div>
    );
}

function BridgeLine({
    label,
    value,
    unit,
    strong = false,
    muted = false,
}: {
    label: string;
    value: number;
    unit: Unit;
    strong?: boolean;
    muted?: boolean;
}) {
    return (
        <tr className={strong ? "border-t" : undefined}>
            <th scope="row" className={`px-2 py-1 text-left font-normal ${muted ? "text-muted-foreground" : ""}`}>{label}</th>
            <td className={`px-2 py-1 text-right tabular-nums ${strong ? "font-medium" : ""} ${muted ? "text-muted-foreground" : ""}`}>
                {valueCell(value, unit)}
            </td>
        </tr>
    );
}

function TerminalCard({
    title,
    result,
    currencyCode,
}: {
    title: string;
    result: TerminalMethodResult;
    currencyCode: string | undefined;
}) {
    const units = valuationUnitsFor(currencyCode);
    const line = (label: string, value: number, unit: Unit) => (
        <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{label}</span>
            <span className="tabular-nums">
                {formatCellValue({ value, status: "ok", source: { kind: "none" }, diagnostics: [], dependencies: [] }, unit)}
            </span>
        </div>
    );
    return (
        <div className="rounded-md border p-3 text-xs">
            <div className="mb-2 font-medium">
                {title}
                {/* Quiet currency disclosure — a reader can tell USD from anything
                    else without the sheet turning into a dashboard. */}
                {currencyCode && <span className="ml-1 font-normal text-muted-foreground">({currencyCode})</span>}
            </div>
            <div className="space-y-1">
                {line("Terminal value", result.terminalValue, units.currency)}
                {line("PV of terminal value", result.terminalPresentValue, units.currency)}
                {line("Enterprise value", result.enterpriseValue, units.currency)}
                {line("Equity value", result.equityValue, units.currency)}
                {line("Implied value / share", result.impliedValuePerShare, units.perShare)}
            </div>
        </div>
    );
}

function Sensitivity({
    title,
    matrix,
    currencyCode,
}: {
    title: string;
    matrix: SensitivityMatrix;
    currencyCode: string | undefined;
}) {
    const { perShare } = valuationUnitsFor(currencyCode);
    return (
        <div className="mt-4">
            <div className="mb-1 text-xs font-medium">{title}</div>
            <table className="text-xs">
                <thead>
                    <tr>
                        <th className="px-2 py-1 text-left font-normal text-muted-foreground">
                            {matrix.rowVariable} \ {matrix.columnVariable}
                        </th>
                        {matrix.columnDeltas.map((column) => (
                            <th key={column} className="px-2 py-1 text-right font-normal tabular-nums">
                                {column.toFixed(2)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {matrix.rowDeltas.map((rowValue, rowIndex) => (
                        <tr key={rowValue}>
                            <th scope="row" className="px-2 py-1 text-left font-normal tabular-nums">{rowValue.toFixed(4)}</th>
                            {matrix.columnDeltas.map((_, columnIndex) => {
                                // `cells` holds SensitivityCell OBJECTS, not bare numbers.
                                const value = matrix.cells[rowIndex]?.[columnIndex]?.impliedValuePerShare ?? null;
                                return (
                                    <td key={columnIndex} className="px-2 py-1 text-right tabular-nums">
                                        {formatCellValue(
                                            { value, status: value === null ? "missing_input" : "ok", source: { kind: "none" }, diagnostics: [], dependencies: [] },
                                            perShare,
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
