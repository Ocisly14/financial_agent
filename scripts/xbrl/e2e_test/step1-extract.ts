// Step 1/3 — Arelle extraction (pure code, no LLM).
// Resolves the issuer's 10-K filings via SEC EDGAR, runs the Arelle companion
// (protocol 3) over them, and persists the raw per-filing presentation extracts.
//
// Usage: node --env-file=.env --experimental-strip-types scripts/xbrl/e2e_test/step1-extract.ts [SYMBOL]
// Needs SEC_USER_AGENT in .env. Writes to data/e2e-test/<symbol>/:
//   step1-source.json      — resolved company, periods, selected filings
//   step1-extraction.json  — full FilingExtraction[] (statements, calc relations, negated concepts)
import { createArelleProcessRunner } from "../../../src/infra/xbrl/arelleAdapter.ts";
import { createPreparedStatementProvider } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { outputDirectory, symbol, writeStep } from "./common.ts";

// Only the interpreter is a local choice; the adapter resolves the companion script itself.
const command = process.env["ARELLE_ADAPTER_COMMAND"]?.trim() || "python3";
const historyYears = Number(process.env["E2E_HISTORY_YEARS"] ?? 5);

console.log(`# Step 1 — Arelle extraction for ${symbol} (${historyYears} fiscal years) → ${outputDirectory}`);

const provider = createPreparedStatementProvider({
  arelle: createArelleProcessRunner({ command, timeoutMs: 600_000 }),
});

const source = await provider.resolve({ symbol, historyYears, forecastYears: 0, filingForms: ["10-K", "10-K/A"] });
console.log(`\nCompany: ${source.company.title} (CIK ${source.company.cik})`);
console.log(`Periods: ${source.periods.map((p) => p.id).join(", ")}`);
console.log("Filings:");
for (const filing of source.filings) console.log(`  - ${filing.accession} ${filing.form} filed ${filing.filedAt}, report date ${filing.reportDate}`);

const extractions = await provider.extract(source);

console.log("\nExtraction result:");
for (const extraction of extractions) {
  const statements = extraction.statements.map((s) => `${s.statement}(${s.nodes.filter((n) => !n.abstract).length} rows)`).join(", ");
  console.log(`  - ${extraction.filing.accession}: ${statements || "NO STATEMENTS"}; calc relations ${extraction.calculationRelations.length}; negated ${extraction.negatedConcepts.length}`);
  for (const diagnostic of extraction.diagnostics) console.log(`      diagnostic: ${diagnostic}`);
}

const sourcePath = writeStep("step1-source.json", source);
const extractionPath = writeStep("step1-extraction.json", { protocolVersion: 3, filings: extractions, diagnostics: [] });
console.log(`\nWrote ${sourcePath}`);
console.log(`Wrote ${extractionPath}`);
console.log("\nNext: step2-unify.ts");
