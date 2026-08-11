import { formatCellValue } from "@/lib/workbook";
import type { CurrentWorkbookView, SensitivityMatrix, TerminalMethodResult, Unit } from "@/types/financialModel";
import { WorkbookGrid } from "./WorkbookGrid";

/** Fallback for a model too young to have a currency-typed row yet — keeps
 *  the old unitless rendering rather than inventing a currency code. */
const UNITLESS: Unit = { kind: "number" };

/** `TerminalMethodResult` carries no unit of its own. The whole model is built
 *  in one reporting currency, so any currency-typed row already committed to
 *  the operations/DCF build is authoritative for it — no need to thread a
 *  currency through the valuation payload itself. */
function currencyCodeFor(workbook: CurrentWorkbookView): string | undefined {
    for (const row of [...workbook.sections.dcf, ...workbook.sections.operations]) {
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

/** Operations and DCF stack on one sheet with the valuation block below —
 *  this is the reference workbook's own DCF tab: the EBIT→NOPAT→FCFF build is
 *  the top half, the discounting is the bottom. */
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
    return (
        <div className="flex h-full flex-col overflow-auto">
            {/* `shrink-0` so the build rows keep their natural height. As a bare
                flex item the grid collapses to a sliver — the valuation block
                below takes its content height and the grid absorbs the whole
                shortfall, leaving two visible rows of a twenty-row model. */}
            <div className="shrink-0">
                <WorkbookGrid
                    rows={[...workbook.sections.operations, ...workbook.sections.dcf]}
                    periods={workbook.periods}
                    isCellChanged={isCellChanged}
                    scrollToLineItemId={scrollToLineItemId}
                />
            </div>
            {workbook.valuation && (
                <div className="border-t p-3">
                    <div className="mb-2 text-xs font-medium">估值结论</div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <TerminalCard title="永续增长法" result={workbook.valuation.perpetuityGrowth} currencyCode={currencyCode} />
                        <TerminalCard title="退出倍数法" result={workbook.valuation.exitMultiple} currencyCode={currencyCode} />
                    </div>
                    <Sensitivity title="WACC × 永续增长" matrix={workbook.valuation.waccByGrowth} currencyCode={currencyCode} />
                    <Sensitivity title="WACC × 退出倍数" matrix={workbook.valuation.waccByMultiple} currencyCode={currencyCode} />
                </div>
            )}
        </div>
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
                {formatCellValue({ value, status: "ok", source: { kind: "none" }, diagnostics: [] }, unit)}
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
                {line("终值", result.terminalValue, units.currency)}
                {line("终值现值", result.terminalPresentValue, units.currency)}
                {line("企业价值", result.enterpriseValue, units.currency)}
                {line("股权价值", result.equityValue, units.currency)}
                {line("每股价值", result.impliedValuePerShare, units.perShare)}
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
                                            { value, status: value === null ? "missing_input" : "ok", source: { kind: "none" }, diagnostics: [] },
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
