// Exports a step8 model to a single .xlsx for hand-checking: the historical three statements as
// statement_unification resolved them, every DCF workbook section with its per-cell values and the
// formula behind each row, the WACC sheet, every assumption with its rationale, and the valuation
// output including both terminal methods and the sensitivity grids.
//
// Usage: node --experimental-strip-types --experimental-sqlite scripts/xbrl/e2e_test/export-model-xlsx.ts [SYMBOL]
// Reads step8-models.db and step2-unified-statements.json. Writes <SYM>-dcf-model.xlsx beside them.
//
// No spreadsheet dependency: an .xlsx is a ZIP of XML parts, and the writer below stores them
// uncompressed, so the whole format need is a CRC32 and two header records.
import { crc32 } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const symbol = (process.argv[2]?.trim() || "AAPL").toUpperCase();
const directory = join("data", "e2e-test", symbol.toLowerCase());

// ---------------------------------------------------------------- xlsx writer

type Cell = string | number | null;
type Sheet = { name: string; rows: Cell[][]; widths?: number[]; freeze?: number };

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

/** A1-style column name: 1 -> A, 27 -> AA. */
function columnName(index: number): string {
  let name = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows.map((cells, rowIndex) => {
    const r = rowIndex + 1;
    const body = cells.map((value, columnIndex) => {
      if (value === null || value === "") return "";
      const ref = `${columnName(columnIndex + 1)}${r}`;
      // Row 1 is the header band; it and the leading label columns get the bold style.
      const style = r === 1 ? ' s="1"' : "";
      return typeof value === "number" && Number.isFinite(value)
        ? `<c r="${ref}"${style}><v>${value}</v></c>`
        : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
    }).join("");
    return `<row r="${r}">${body}</row>`;
  }).join("");
  const cols = sheet.widths
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const pane = sheet.freeze
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" xSplit="${sheet.freeze}" topLeftCell="${columnName(sheet.freeze + 1)}2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `${pane}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

/** Minimal STORED-only ZIP. Uncompressed keeps the writer to a CRC and two records. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const sum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function writeWorkbook(path: string, sheets: Sheet[]): void {
  const files: { name: string; data: Buffer }[] = [];
  const push = (name: string, text: string) => files.push({ name, data: Buffer.from(text, "utf8") });

  push("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `</Types>`);

  push("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);

  push("xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
    + sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
    + `</sheets></workbook>`);

  push("xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);

  push("xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
    + `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>`
    + `<borders count="1"><border/></borders>`
    + `<cellStyleXfs count="1"><xf/></cellStyleXfs>`
    + `<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>`);

  sheets.forEach((sheet, i) => push(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)));
  writeFileSync(path, zip(files));
}

// ---------------------------------------------------------------- model reading

const db = new DatabaseSync(join(directory, "step8-models.db"));
const revisionRow = db.prepare(
  "select model_id, revision, lifecycle_stage, snapshot_json from financial_model_revisions order by revision desc limit 1",
).get() as { model_id: string; revision: number; lifecycle_stage: string; snapshot_json: string };
const snapshot = JSON.parse(revisionRow.snapshot_json);

const unifiedFile = JSON.parse(readFileSync(join(directory, "step2-unified-statements.json"), "utf8"));
const unified = unifiedFile.artifact ?? unifiedFile;

const periods: { id: string; label: string; cls: string }[] = snapshot.periods;
const periodIds = periods.map((p) => p.id);
const cellByKey = new Map<string, { value: number | null }>(
  snapshot.cells.map((entry: { key: string; cell: { value: number | null } }) => [entry.key, entry.cell]),
);
const value = (lineItemId: string, periodId: string): number | null =>
  cellByKey.get(`${lineItemId}@${periodId}`)?.value ?? null;

/** Every formula that drives a row, as the source text the agent wrote, tagged by range. */
function formulasFor(lineItemId: string): string {
  return snapshot.formulas
    .filter((f: { lineItemId: string }) => f.lineItemId === lineItemId)
    .map((f: { appliesTo: string; source: string }) => `[${f.appliesTo}] ${f.source}`)
    .join("  |  ");
}

const assumptionByLineItem = new Map<string, { sourceType: string; rationale: string }>(
  snapshot.assumptions.map((a: { lineItemId: string; sourceType: string; rationale: string }) => [a.lineItemId, a]),
);

const sheets: Sheet[] = [];

// ---------------------------------------------------------------- overview

const valuation = snapshot.valuation;
// Snapshots written before the perpetuity_growth rename still carry the old key.
const perpetuity = valuation?.perpetuityGrowth ?? valuation?.gordonGrowth ?? null;
const exitMultiple = valuation?.exitMultiple ?? null;
const waccRow = snapshot.waccSheet?.rows.find((r: { rowId: string }) => r.rowId === "wacc");
const config = snapshot.valuationConfig;

sheets.push({
  name: "Overview", widths: [34, 60],
  rows: [
    ["Field", "Value"],
    ["Symbol", symbol],
    ["Model id", revisionRow.model_id],
    ["Revision", revisionRow.revision],
    ["Lifecycle stage", revisionRow.lifecycle_stage],
    ["Reporting currency", snapshot.lineItems.find((i: { unit: { code?: string } }) => i.unit?.code)?.unit.code ?? ""],
    ["Actual periods", periods.filter((p) => p.cls === "actual").map((p) => p.id).join(", ")],
    ["Forecast periods", periods.filter((p) => p.cls === "forecast").map((p) => p.id).join(", ")],
    [],
    ["WACC", waccRow?.value ?? null],
    ["Anchor period", config?.anchorPeriodId ?? ""],
    ["Discount convention", config?.discountConvention ?? "(not set)"],
    ["Exit terminal metric", config?.exitTerminalMetric ?? "(not set)"],
    ["Config sourceType", config?.sourceType ?? "(not set)"],
    ["Config rationale", config?.rationale ?? ""],
    [],
    ["Perpetuity growth — per share", perpetuity?.impliedValuePerShare ?? null],
    ["Perpetuity growth — enterprise value", perpetuity?.enterpriseValue ?? null],
    ["Perpetuity growth — terminal value", perpetuity?.terminalValue ?? null],
    ["Perpetuity growth — TV % of EV", perpetuity?.terminalValuePercentOfEnterpriseValue ?? null],
    ["Exit multiple — per share", exitMultiple?.impliedValuePerShare ?? null],
    ["Exit multiple — enterprise value", exitMultiple?.enterpriseValue ?? null],
    ["Exit multiple — terminal value", exitMultiple?.terminalValue ?? null],
    ["Exit multiple — TV % of EV", exitMultiple?.terminalValuePercentOfEnterpriseValue ?? null],
    [],
    ["Note", "Values are engine-computed. The Formula column on each DCF sheet is the model's own"],
    ["", "formula DSL source, not an Excel formula — Excel does not recompute these cells."],
  ],
});

// ---------------------------------------------------------------- the three statements

// The unified artifact lists its periods as plain ids; older artifacts used period objects.
const unifiedPeriods: string[] = ((unified.periods ?? []) as (string | { id: string })[])
  .map((p) => (typeof p === "string" ? p : p.id))
  .filter((id): id is string => typeof id === "string" && id.length > 0);
if (unifiedPeriods.length === 0) unifiedPeriods.push(...periodIds.filter((_, i) => periods[i]!.cls === "actual"));
for (const [statement, title] of [
  ["income_statement", "Income Statement"],
  ["balance_sheet", "Balance Sheet"],
  ["cash_flow_statement", "Cash Flow"],
] as const) {
  const rows = unified.rows.filter((r: { statement: string }) => r.statement === statement);
  sheets.push({
    name: title, freeze: 2, widths: [30, 42, ...unifiedPeriods.map(() => 18), 60],
    rows: [
      ["Row id", "Label", ...unifiedPeriods, "Rationale"],
      ...rows.map((r: { rowId: string; label: string; values: Record<string, number>; rationale?: string }) =>
        [r.rowId, r.label, ...unifiedPeriods.map((p) => r.values?.[p] ?? null), r.rationale ?? ""]),
    ],
  });
}

if ((unified.breakdownRows ?? []).length > 0) {
  sheets.push({
    name: "Segment breakdown", freeze: 3, widths: [26, 26, 40, ...unifiedPeriods.map(() => 18)],
    rows: [
      ["Row id", "Parent row", "Label", ...unifiedPeriods],
      ...unified.breakdownRows.map((r: { rowId: string; parentRowId: string; label: string; values?: Record<string, number> }) =>
        [r.rowId, r.parentRowId, r.label, ...unifiedPeriods.map((p) => r.values?.[p] ?? null)]),
    ],
  });
}

// ---------------------------------------------------------------- the DCF workbook

const SECTION_TITLES: Record<string, string> = {
  history: "DCF · History", revenue: "DCF · Revenue", operations: "DCF · Operations",
  dcf: "DCF · Valuation rows", metrics: "DCF · Metrics",
};
for (const [section, title] of Object.entries(SECTION_TITLES)) {
  const items = snapshot.lineItems
    .filter((i: { section: string }) => i.section === section)
    .sort((a: { order: number }, b: { order: number }) => a.order - b.order);
  if (items.length === 0) continue;
  sheets.push({
    name: title, freeze: 2, widths: [34, 34, ...periodIds.map(() => 18), 14, 14, 58, 46],
    rows: [
      ["Line item id", "Label", ...periodIds, "Hist source", "Fcst source", "Formula (model DSL)", "Assumption rationale"],
      ...items.map((item: { id: string; label: string; historical: string; forecast: string; description?: string }) => [
        item.id, item.label,
        ...periodIds.map((p) => value(item.id, p)),
        item.historical, item.forecast,
        formulasFor(item.id) || item.description || "",
        assumptionByLineItem.get(item.id)?.rationale ?? "",
      ]),
    ],
  });
}

// ---------------------------------------------------------------- assumptions

sheets.push({
  name: "Assumptions", freeze: 1, widths: [30, 34, ...periodIds.map(() => 14), 20, 40, 16, 90],
  rows: [
    ["Line item", "Assumption id", ...periodIds, "Source type", "Source refs", "As of", "Rationale"],
    ...snapshot.assumptions.map((a: {
      assumptionId: string; lineItemId: string; periods: string[];
      payload: { kind: string; values?: number[] }; sourceType: string; sourceRefs: string[];
      asOfDate: string; rationale: string;
    }) => {
      const byPeriod = new Map(a.periods.map((p, i) => [p, a.payload.values?.[i] ?? null]));
      return [a.lineItemId, a.assumptionId, ...periodIds.map((p) => byPeriod.get(p) ?? null),
        a.sourceType, (a.sourceRefs ?? []).join("; "), a.asOfDate, a.rationale];
    }),
  ],
});

// ---------------------------------------------------------------- WACC sheet

sheets.push({
  name: "WACC sheet", freeze: 1, widths: [26, 30, 20, 18, 62, 30, 70],
  rows: [
    ["Row id", "Label", "Value", "Source", "Locked formula", "Missing inputs", "Provenance rationale"],
    ...(snapshot.waccSheet?.rows ?? []).map((r: {
      rowId: string; label: string; value: number | null; source: string;
      formulaSource?: string; missingInputs?: string[]; provenance?: { rationale?: string; sourceRefs?: string[] };
    }) => [r.rowId, r.label, r.value, r.source, r.formulaSource ?? "",
      (r.missingInputs ?? []).join(", "), r.provenance?.rationale ?? ""]),
    [],
    ["As-of date", snapshot.waccSheet?.asOfDate ?? ""],
  ],
});

// ---------------------------------------------------------------- valuation output

if (valuation) {
  const methodBlock = (label: string, method: Record<string, unknown> | null): Cell[][] => {
    if (!method) return [[label, "(not computed)"]];
    const bridge = (method["bridge"] as { lineItemId: string; sign: number; value: number | null; appliedAdjustment: number }[]) ?? [];
    return [
      [label, ""],
      ["  terminal value", method["terminalValue"] as number],
      ["  terminal present value", method["terminalPresentValue"] as number],
      ["  TV % of enterprise value", method["terminalValuePercentOfEnterpriseValue"] as number],
      ["  enterprise value", method["enterpriseValue"] as number],
      ...bridge.map((b) => [`  bridge: ${b.lineItemId} (sign ${b.sign})`, b.appliedAdjustment] as Cell[]),
      ["  equity value", method["equityValue"] as number],
      ["  diluted shares", method["dilutedShares"] as number],
      ["  implied value per share", method["impliedValuePerShare"] as number],
      [],
    ];
  };
  sheets.push({
    name: "Valuation", widths: [46, 24],
    rows: [
      ["Item", "Value"],
      ["Explicit forecast", ""],
      ...snapshot.valuation.explicitPeriods.map((p: { periodId: string; fcff: number; wacc: number; discountFactor: number; presentValue: number }) =>
        [`  ${p.periodId}  fcff / wacc / factor / PV`, `${p.fcff} | ${p.wacc} | ${p.discountFactor} | ${p.presentValue}`] as Cell[]),
      [],
      ...methodBlock("Perpetuity growth method", perpetuity),
      ...methodBlock("Exit multiple method", exitMultiple),
    ],
  });

  for (const [key, title] of [["waccByGrowth", "Sensitivity · WACC × growth"], ["waccByMultiple", "Sensitivity · WACC × multiple"]] as const) {
    const grid = valuation[key];
    if (!grid) continue;
    sheets.push({
      name: title, freeze: 1, widths: [22, ...grid.columnDeltas.map(() => 16)],
      rows: [
        [`${grid.rowVariable} \\ ${grid.columnVariable}`, ...grid.columnDeltas],
        ...grid.cells.map((row: { impliedValuePerShare: number | null }[], i: number) =>
          [grid.rowDeltas[i], ...row.map((c) => c.impliedValuePerShare)] as Cell[]),
      ],
    });
  }
}

const outputPath = join(directory, `${symbol}-dcf-model.xlsx`);
writeWorkbook(outputPath, sheets);
console.log(`${symbol}: wrote ${outputPath}`);
console.log(`  revision ${revisionRow.revision} (${revisionRow.lifecycle_stage}), ${sheets.length} sheets:`);
for (const sheet of sheets) console.log(`    ${sheet.name} — ${sheet.rows.length - 1} rows`);
