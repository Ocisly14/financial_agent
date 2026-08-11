import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Period } from "../../src/financial-model/types.ts";
import { buildPresentedStatements, type PresentedStatement } from "../../src/infra/xbrl/presentedStatement.ts";
import type { FilingExtraction } from "../../src/infra/xbrl/types.ts";
import { verifyPresentedStatement, type StatementVerification } from "../../src/infra/xbrl/verifyPresentedStatement.ts";

// Render extracted face statements as a self-contained spreadsheet-style page.
//
//   node --experimental-strip-types --experimental-sqlite \
//     scripts/xbrl/render-statements.ts <companion-response.json> [out.html]
//
// The input is any protocol-3 Arelle companion response — the committed fixture, or a fresh
// capture. The output has no external assets, so it opens straight from the filesystem.

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg) throw new Error("usage: render-statements.ts <companion-response.json> [out.html]");
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg ?? inputPath.replace(/\.json$/, "") + ".html");

const response = JSON.parse(await readFile(inputPath, "utf8")) as { filings: FilingExtraction[] };
const years = new Set<string>();
for (const filing of response.filings) {
  for (const statement of filing.statements) {
    for (const node of statement.nodes) for (const fact of node.facts) years.add(fact.periodId);
  }
}
const requestedPeriods: Period[] = [...years].sort().map((id) => ({
  id, label: id, start: `${id.slice(2)}-01-01`, end: `${id.slice(2)}-12-31`, cls: "actual",
}));

const statements = buildPresentedStatements({ filings: response.filings, requestedPeriods });
const relationsByAccession = new Map(response.filings.map((filing) => [filing.filing.accession, filing.calculationRelations]));

type Sheet = {
  key: string;
  accession: string;
  form: string;
  reportDate: string;
  statement: string;
  roleLabel: string;
  periodIds: string[];
  rows: Array<{
    depth: number;
    label: string;
    concept: string;
    abstract: boolean;
    isTotal: boolean;
    cells: Array<{ value: number | null; unit: string; ambiguous: boolean; broken: string | null }>;
  }>;
  verification: StatementVerification;
};

/**
 * A presentation role carries scaffolding a reader never sees on the printed statement: the
 * `Statement [Table]` / `Statement [Line Items]` wrappers, and a whole axis/domain/member branch
 * that declares dimensions rather than reporting lines. Dropping the dimension branch and
 * unwrapping the containers is what turns the tree back into the statement.
 */
const DIMENSION_NODE = /(Axis|Domain|Member)$/;
const CONTAINER_NODE = /(Table|LineItems|StatementLineItems)$/;

function visibility(statement: PresentedStatement): { visible: Set<number>; depth: Map<number, number> } {
  const byId = new Map(statement.nodes.map((node) => [node.nodeId, node]));
  const dropped = new Set<number>();
  const unwrapped = new Set<number>();
  for (const node of statement.nodes) {
    const parentDropped = node.parentNodeId !== null && dropped.has(node.parentNodeId);
    if (parentDropped || DIMENSION_NODE.test(node.conceptQName)) {
      dropped.add(node.nodeId);
      continue;
    }
    // Roots arrive labelled with their own concept name, which is scaffolding too.
    if ((CONTAINER_NODE.test(node.conceptQName) || node.label === node.conceptQName)
      && node.valueByPeriod.size === 0) unwrapped.add(node.nodeId);
  }
  const visible = new Set(statement.nodes
    .filter((node) => !dropped.has(node.nodeId) && !unwrapped.has(node.nodeId))
    .map((node) => node.nodeId));
  const depth = new Map<number, number>();
  for (const node of statement.nodes) {
    let level = 0;
    let cursor = node.parentNodeId;
    while (cursor !== null && level < 12) {
      if (visible.has(cursor)) level += 1;
      cursor = byId.get(cursor)?.parentNodeId ?? null;
    }
    depth.set(node.nodeId, level);
  }
  return { visible, depth };
}

const sheets: Sheet[] = statements.map((statement) => {
  const relations = relationsByAccession.get(statement.accession) ?? [];
  const verification = verifyPresentedStatement(statement, relations);
  const totals = new Set(relations.filter((relation) => relation.roleUri === statement.roleUri).map((relation) => relation.parentConcept));
  const breakAt = new Map<string, string>();
  for (const entry of verification.rollupBreaks) {
    breakAt.set(`${entry.parentConcept}|${entry.periodId}`,
      `reported ${entry.reported.toLocaleString()}, computed ${entry.computed.toLocaleString()}, difference ${entry.difference.toLocaleString()}`
      + (entry.missingChildren.length > 0 ? `\nmissing: ${entry.missingChildren.join(", ")}` : ""));
  }
  const filing = response.filings.find((entry) => entry.filing.accession === statement.accession)!.filing;
  const { visible, depth } = visibility(statement);
  return {
    key: `${statement.accession}:${statement.statement}`,
    accession: statement.accession,
    form: filing.form,
    reportDate: filing.reportDate,
    statement: statement.statement,
    roleLabel: statement.roleLabel,
    periodIds: statement.periodIds,
    verification,
    rows: statement.nodes.filter((node) => visible.has(node.nodeId)).map((node) => ({
      depth: depth.get(node.nodeId) ?? 0,
      label: node.label,
      concept: node.conceptQName,
      abstract: node.abstract,
      isTotal: totals.has(node.conceptQName),
      cells: statement.periodIds.map((periodId) => {
        const fact = node.valueByPeriod.get(periodId);
        return {
          value: fact?.value ?? null,
          unit: fact ? `${fact.unit.kind}${fact.unit.code ? ` ${fact.unit.code}` : ""}` : "",
          ambiguous: node.ambiguousPeriodIds.includes(periodId),
          broken: breakAt.get(`${node.conceptQName}|${periodId}`) ?? null,
        };
      }),
    })),
  };
});

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extracted statements — ${escapeHtml(response.filings[0]?.filing.accession ?? "")}</title>
<style>
:root{--bg:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--head:#fafafa;--accent:#2563eb;
  --warn:#fef3c7;--warnline:#f59e0b;--neg:#b91c1c;--totalline:#a1a1aa}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--fg:#e4e4e7;--muted:#8b8b93;--line:#27272a;
  --head:#141417;--accent:#60a5fa;--warn:#3f2d0b;--warnline:#b45309;--neg:#f87171;--totalline:#52525b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:13px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 14px}
h1{font-size:14px;font-weight:600;margin:0 0 8px}
.controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
select,button{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);
  border-radius:6px;padding:4px 8px;cursor:pointer}
button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
.meta{color:var(--muted);font-size:12px;margin-left:auto;text-align:right}
.wrap{overflow:auto;max-height:calc(100vh - 96px)}
table{border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums;min-width:100%}
th,td{padding:3px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
thead th{position:sticky;top:0;background:var(--head);z-index:3;text-align:right;font-weight:600;
  border-bottom:1px solid var(--totalline)}
thead th:first-child{text-align:left;left:0;z-index:4}
tbody th{position:sticky;left:0;background:var(--bg);text-align:left;font-weight:400;z-index:2;
  max-width:460px;overflow:hidden;text-overflow:ellipsis}
td{text-align:right}
tr.abstract th{font-weight:600;color:var(--muted);padding-top:10px}
tr.total th,tr.total td{font-weight:600;border-top:1px solid var(--totalline)}
td.neg{color:var(--neg)}
td.broken{background:var(--warn);box-shadow:inset 0 0 0 1px var(--warnline)}
td.ambiguous{background:var(--warn)}
.concept{color:var(--muted);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.hide-concepts .concept{display:none}
.verif{padding:10px 14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.verif b{color:var(--fg)}
.verif ul{margin:6px 0 0;padding-left:18px}
.ok{color:#16a34a}
</style></head><body>
<header>
  <h1>Extracted face statements <span class="concept" id="src"></span></h1>
  <div class="controls">
    <select id="sheet"></select>
    <button id="scale" aria-pressed="true">millions</button>
    <button id="concepts" aria-pressed="true">concepts</button>
    <span class="meta" id="meta"></span>
  </div>
</header>
<div class="wrap"><table><thead id="head"></thead><tbody id="body"></tbody></table></div>
<div class="verif" id="verif"></div>
<script>
const SHEETS = ${JSON.stringify(sheets)};
const SOURCE = ${JSON.stringify(inputPath)};
let scale = 1e6, showConcepts = true, current = 0;
document.getElementById("src").textContent = SOURCE;

function fmt(value, unit) {
  if (value === null) return "";
  if (unit.startsWith("per_share")) return value.toFixed(2);
  const divided = unit.startsWith("pure") || unit.startsWith("percent") ? value : value / scale;
  const shown = Math.abs(divided) < 0.005 && divided !== 0
    ? divided.toPrecision(2)
    : divided.toLocaleString(undefined, { maximumFractionDigits: scale === 1 ? 0 : 1 });
  return divided < 0 ? "(" + shown.replace("-", "") + ")" : shown;
}

function render() {
  const sheet = SHEETS[current];
  document.getElementById("head").innerHTML =
    "<tr><th>" + sheet.roleLabel.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</th>" +
    sheet.periodIds.map((id) => "<th>" + id + "</th>").join("") + "</tr>";
  document.getElementById("body").innerHTML = sheet.rows.map((row) => {
    const cls = [row.abstract ? "abstract" : "", row.isTotal ? "total" : ""].filter(Boolean).join(" ");
    const pad = 10 + row.depth * 14;
    const label = row.label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const head = '<th style="padding-left:' + pad + 'px">' + label +
      '<div class="concept">' + row.concept + "</div></th>";
    const cells = row.cells.map((cell) => {
      const classes = [cell.value !== null && cell.value < 0 ? "neg" : "",
        cell.broken ? "broken" : "", cell.ambiguous ? "ambiguous" : ""].filter(Boolean).join(" ");
      const title = cell.broken ? ' title="' + cell.broken.replace(/"/g, "&quot;") + '"'
        : cell.ambiguous ? ' title="ambiguous: more than one candidate fact"' : "";
      return "<td" + (classes ? ' class="' + classes + '"' : "") + title + ">" + fmt(cell.value, cell.unit) + "</td>";
    }).join("");
    return "<tr" + (cls ? ' class="' + cls + '"' : "") + ">" + head + cells + "</tr>";
  }).join("");

  const v = sheet.verification;
  document.getElementById("meta").textContent =
    sheet.form + " · " + sheet.reportDate + " · " + sheet.accession;
  const breaks = v.rollupBreaks.concat(v.balanceBreaks.map((entry) => ({
    parentConcept: "Assets = Liabilities and equity", periodId: entry.periodId,
    reported: entry.assets, computed: entry.liabilitiesAndEquity, difference: entry.difference, missingChildren: [],
  })));
  document.getElementById("verif").innerHTML =
    "<b>Verification</b> — reported periods: " + (v.reportedPeriodIds.join(", ") || "none") +
    " · totals unavailable: " + v.totalsUnavailable +
    " · roll-up breaks: " + v.rollupBreaks.length + " · balance breaks: " + v.balanceBreaks.length +
    (breaks.length === 0 ? ' <span class="ok">&#10003; everything ties</span>' : "") +
    (breaks.length === 0 ? "" : "<ul>" + breaks.map((entry) =>
      "<li><code>" + entry.parentConcept + "</code> @ " + entry.periodId +
      ": reported " + entry.reported.toLocaleString() + ", computed " + entry.computed.toLocaleString() +
      ", difference " + entry.difference.toLocaleString() +
      (entry.missingChildren.length ? " — missing " + entry.missingChildren.join(", ") : "") + "</li>").join("") + "</ul>");
}

const picker = document.getElementById("sheet");
picker.innerHTML = SHEETS.map((sheet, index) =>
  '<option value="' + index + '">' + sheet.statement.replace(/_/g, " ") + " — " + sheet.form + " " + sheet.reportDate + "</option>").join("");
picker.onchange = (event) => { current = Number(event.target.value); render(); };
document.getElementById("scale").onclick = (event) => {
  scale = scale === 1e6 ? 1 : 1e6;
  event.target.textContent = scale === 1e6 ? "millions" : "units";
  render();
};
document.getElementById("concepts").onclick = (event) => {
  showConcepts = !showConcepts;
  event.target.setAttribute("aria-pressed", String(showConcepts));
  document.body.classList.toggle("hide-concepts", !showConcepts);
  render();
};
render();
</script></body></html>`;

await writeFile(outputPath, html, "utf8");
process.stdout.write(`${outputPath}\n${sheets.length} sheet(s): ${sheets.map((sheet) => `${sheet.statement}/${sheet.reportDate}`).join(", ")}\n`);

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
