import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Period } from "../../src/financial-model/types.ts";
import { createArelleProcessRunner } from "../../src/infra/xbrl/arelleAdapter.ts";
import { mergeCuratedTables } from "../../src/infra/xbrl/mergeCuratedTables.ts";
import { buildPresentedStatements } from "../../src/infra/xbrl/presentedStatement.ts";
import { selectFaceStatements } from "../../src/infra/xbrl/selectFaceStatements.ts";
import { SqliteFilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import type { FilingIdentity } from "../../src/infra/xbrl/types.ts";
import { verifyPresentedStatement } from "../../src/infra/xbrl/verifyPresentedStatement.ts";

// Manual, network-gated comparison of the two face-statement extraction paths:
//   old: HTML tables -> selectFaceStatements -> mergeCuratedTables
//   new: presentation linkbase -> buildPresentedStatements
// Both run over the same Arelle extraction, so any difference is downstream of it.
//
//   node --env-file=.env --experimental-strip-types --experimental-sqlite \
//     scripts/xbrl/compare-statement-extraction.ts

const companion = fileURLToPath(new URL("./arelle_companion.py", import.meta.url));
const command = process.env["ARELLE_ADAPTER_COMMAND"]?.trim() || "python3";
const args = process.env["ARELLE_ADAPTER_ARGS"] ? (JSON.parse(process.env["ARELLE_ADAPTER_ARGS"]!) as string[]) : [companion];
const symbol = (process.env["SMOKE_SYMBOL"]?.trim() || "TSLA").toUpperCase();
const filingsJson = process.env["COMPARE_FILINGS"];
if (!filingsJson) throw new Error("COMPARE_FILINGS must be a JSON array of {accession, form, filedAt, reportDate, primaryDocumentUrl}");
const filings = JSON.parse(filingsJson) as FilingIdentity[];
const years = [2021, 2022, 2023, 2024, 2025];
const requestedPeriods: Period[] = years.map((year) => ({
  id: `FY${year}`, label: `FY${year}`, start: `${year}-01-01`, end: `${year}-12-31`, cls: "actual",
}));

const runner = createArelleProcessRunner({ command, args, timeoutMs: 600_000 });
const extraction = await runner({ protocolVersion: 3, filings, periods: requestedPeriods });

const outputDirectory = resolve(join("data", "smoke", "xbrl"));
await mkdir(outputDirectory, { recursive: true });
const store = SqliteFilingTableStore.open(join(outputDirectory, `${symbol.toLowerCase()}-comparison.sqlite`));

try {
  // --- old path ---
  const tables = extraction.filings.flatMap((filing) => filing.tables);
  const calculationRelations = Object.fromEntries(extraction.filings.map((filing) => [filing.filing.accession, filing.calculationRelations]));
  const reportDates = [...new Set(tables.map((table) => table.reportDate))].sort();
  const selection = selectFaceStatements({
    runId: "compare", store, tables, requestedPeriods, reportDates, calculationRelations,
  });
  const merged = mergeCuratedTables({
    requestedPeriods, filings: extraction.filings.map((filing) => filing.filing),
    tables, curations: selection.curations,
  });
  const oldCells = new Map<string, number>();
  for (const fact of merged.facts) {
    const row = merged.statementViews.income_statement.candidate.rows
      .concat(merged.statementViews.balance_sheet.candidate.rows, merged.statementViews.cash_flow_statement.candidate.rows)
      .find((entry) => entry.sourceLineItemId === fact.lineItemId);
    if (!row?.conceptQName) continue;
    oldCells.set(`${row.statement}|${fact.periodId}|${row.conceptQName}`, fact.value);
  }

  // --- new path ---
  const presented = buildPresentedStatements({ filings: extraction.filings, requestedPeriods });
  const newCells = new Map<string, number>();
  for (const statement of presented) {
    for (const node of statement.nodes) {
      for (const [periodId, fact] of node.valueByPeriod) {
        // Precedence matches the old path: the most recently filed statement wins a contested cell.
        newCells.set(`${statement.statement}|${periodId}|${node.conceptQName}`, fact.value);
      }
    }
  }

  const keys = [...new Set([...oldCells.keys(), ...newCells.keys()])].sort();
  const agree: string[] = [];
  const onlyNew: string[] = [];
  const onlyOld: string[] = [];
  const differ: string[] = [];
  for (const key of keys) {
    const oldValue = oldCells.get(key);
    const newValue = newCells.get(key);
    if (oldValue === undefined) onlyNew.push(`| ${key.split("|").join(" | ")} | ${newValue} |`);
    else if (newValue === undefined) onlyOld.push(`| ${key.split("|").join(" | ")} | ${oldValue} |`);
    else if (Math.abs(oldValue - newValue) <= Math.max(Math.abs(oldValue) * 1e-6, 1)) agree.push(key);
    else differ.push(`| ${key.split("|").join(" | ")} | ${oldValue} | ${newValue} | ${oldValue - newValue} |`);
  }

  const lines = [
    `# ${symbol} statement extraction comparison`, "",
    `Filings: ${filings.length}. Cells: old ${oldCells.size}, new ${newCells.size}.`, "",
    `- agree: ${agree.length}`, `- only on the new path: ${onlyNew.length}`,
    `- only on the existing path: ${onlyOld.length}`, `- disagree: ${differ.length}`, "",
    "## Disagree", "", "| statement | period | concept | old | new | difference |", "|---|---|---|---|---|---|",
    ...differ, "",
    "## Only on the new path", "", "| statement | period | concept | value |", "|---|---|---|---|", ...onlyNew, "",
    "## Only on the existing path", "", "| statement | period | concept | value |", "|---|---|---|---|", ...onlyOld, "",
    "## Verification", "",
  ];
  for (const statement of presented) {
    const relations = extraction.filings.find((filing) => filing.filing.accession === statement.accession)?.calculationRelations ?? [];
    const verification = verifyPresentedStatement(statement, relations);
    lines.push(`### ${statement.accession} ${statement.statement}`, "",
      `- reported periods: ${verification.reportedPeriodIds.join(", ") || "none"}`,
      `- totals unavailable: ${verification.totalsUnavailable}`,
      `- roll-up breaks: ${verification.rollupBreaks.length}`,
      `- balance breaks: ${verification.balanceBreaks.length}`, "");
    for (const entry of verification.rollupBreaks) {
      lines.push(`  - \`${entry.parentConcept}\` @ ${entry.periodId}: reported ${entry.reported}, computed ${entry.computed}, difference ${entry.difference}${entry.missingChildren.length > 0 ? `, missing ${entry.missingChildren.join(", ")}` : ""}`);
    }
    for (const entry of verification.balanceBreaks) {
      lines.push(`  - balance @ ${entry.periodId}: assets ${entry.assets}, L+E ${entry.liabilitiesAndEquity}, difference ${entry.difference}`);
    }
    lines.push("");
  }

  const path = join(outputDirectory, `${symbol.toLowerCase()}-statement-comparison-${new Date().toISOString().slice(0, 10)}.md`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${path}\nagree ${agree.length} | onlyNew ${onlyNew.length} | onlyOld ${onlyOld.length} | differ ${differ.length}\n`);
} finally {
  store.close();
}
