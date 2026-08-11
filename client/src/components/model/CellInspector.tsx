import { X } from "lucide-react";
import { formatCellValue } from "@/lib/workbook";
import type { WorkbookCellView, WorkbookRowView } from "@/types/financialModel";

/** Where a number came from. This is the whole reason a read-only grid is
 *  useful rather than decorative: a DCF cell is only trustworthy if you can
 *  get back to the filing fact or the formula behind it. */
export function CellInspector({
    row,
    periodId,
    anchor,
    onClose,
}: {
    row: WorkbookRowView;
    periodId: string;
    /** Where to place the popover, in the scrolling grid container's own
     *  content coordinate space (its scrollLeft/scrollTop origin) — see
     *  `anchorFor` in WorkbookGrid, which computes this once at click time
     *  and already clamps it to stay on screen and flips it off the cell's
     *  far edge when the near edge would run off the visible viewport. */
    anchor: { top: number; left: number };
    onClose: () => void;
}) {
    const cell: WorkbookCellView | undefined = row.cells[periodId];
    if (!cell) return null;

    // Hoisted to a local so the narrowing on `.kind` survives into the closure
    // passed to `.find` below — TS does not carry a narrowed *nested* property
    // path (`cell.source.kind`) into a nested function, only a narrowed local.
    const source = cell.source;
    const assumption = source.kind === "assumption"
        ? row.assumptions.find((item) => item.assumptionId === source.assumptionId)
        : undefined;
    const formula = source.kind === "formula" ? row.formulas[source.definitionIndex] : undefined;

    return (
        <div
            className="absolute z-20 w-80 max-h-[70vh] overflow-y-auto rounded-md border bg-popover p-3 text-xs shadow-lg"
            style={{ top: anchor.top, left: anchor.left }}
        >
            <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                    <div className="font-medium">{row.label}</div>
                    <div className="text-muted-foreground">{periodId}</div>
                </div>
                <button type="button" onClick={onClose} aria-label="Close">
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
            </div>

            <dl className="space-y-1.5">
                <Field label="值" value={formatCellValue(cell, row.unit)} />
                <Field label="状态" value={cell.status} />
                <Field label="来源" value={source.kind} />
                {source.kind === "fact" && <Field label="Fact" value={source.factId} />}
                {formula && <Field label="公式" value={formula.source} mono />}
                {assumption && (
                    <>
                        {/* Provenance is flat on Assumption, not a nested object —
                            and the values are an array parallel to `periods`,
                            so the cell's own number has to be looked up by index. */}
                        <Field label="依据" value={assumption.rationale} />
                        <Field label="截至" value={assumption.asOfDate} />
                        <Field label="引用" value={assumption.sourceRefs.join(", ")} />
                    </>
                )}
                {cell.diagnostics.map((diagnostic, index) => (
                    <Field key={index} label="诊断" value={`${diagnostic.code}: ${diagnostic.refs.join(", ")}`} />
                ))}
            </dl>
        </div>
    );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="flex gap-2">
            <dt className="w-12 shrink-0 text-muted-foreground">{label}</dt>
            <dd className={mono ? "break-all font-mono" : "break-words"}>{value}</dd>
        </div>
    );
}
