import { describeProviderError, type ModelRouter } from "../../infra/llm/provider.ts";
import type { FilingTableStore } from "../../infra/xbrl/filingTableStore.ts";
import type { SourceReviewArtifact } from "../../infra/xbrl/sourceReviewStore.ts";
import type { DecompositionStore } from "../../infra/xbrl/decompositionStore.ts";
import type { CandidateScheme, ReduceDecision } from "../../infra/xbrl/decompositionTypes.ts";
import { buildCandidateSchemes, validateFilingSchemes } from "../../infra/xbrl/decompositionAnalysis.ts";
import { runFilingDecompositionLoop } from "./filingDecompositionLoop.ts";
import { runDecompositionReduceLoop } from "./decompositionReduceLoop.ts";

export async function runRevenueDecomposition(input: {
  modelRouter: ModelRouter; sourceReview: SourceReviewArtifact; tableStore: FilingTableStore;
  store: DecompositionStore; mapPrompt: string; reducePrompt: string; task: string;
}): Promise<{ candidates: CandidateScheme[]; decision: ReduceDecision | null; diagnostics: string[] }> {
  const runId = input.sourceReview.ingestionRunId;
  const diagnostics: string[] = [];
  const faceRows = input.sourceReview.statementViews.income_statement.candidate.rows
    .map((row) => ({ sourceLineItemId: row.sourceLineItemId, title: row.label, conceptQName: row.conceptQName }));
  const requestedPeriodIds = input.sourceReview.coverage.requestedPeriodIds;
  // Bounded parallelism: a full fan-out over every filing has tripped provider rate limits,
  // losing whole filings to transient non-JSON API errors.
  const settled = await allSettledLimit(input.sourceReview.filings, 3, (filing) =>
    runFilingDecompositionLoop({ modelRouter: input.modelRouter, runId, accession: filing.accession,
      tableStore: input.tableStore, faceRows, requestedPeriodIds,
      onMintedFacts: (facts) => input.store.saveMintedFacts(runId, facts),
      task: input.task, systemPrompt: input.mapPrompt }));
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      // The bare message ("Invalid JSON response") cannot distinguish a 429 from a bad request,
      // so the diagnostic carries the flattened provider error, status and body included.
      diagnostics.push(`filing_decomposition_failed ${input.sourceReview.filings[index]!.accession}: ${JSON.stringify(describeProviderError(outcome.reason))}`);
    } else input.store.saveMapProposal(runId, outcome.value);
  }
  const minted = new Map(input.store.listMintedFacts(runId).map((fact) => [fact.factId, fact]));
  const faceRowMap = new Map(faceRows.map((row) => [row.sourceLineItemId, { conceptQName: row.conceptQName }]));
  const filedAtByAccession = new Map(input.sourceReview.filings.map((filing) => [filing.accession, filing.filedAt]));
  const validated = input.store.listMapProposals(runId).map((proposal) => {
    const result = validateFilingSchemes({ proposal, minted, faceRows: faceRowMap, calculationRelations: [] });
    diagnostics.push(...result.diagnostics);
    return { accession: proposal.accession, filedAt: filedAtByAccession.get(proposal.accession) ?? "", schemes: result.schemes };
  });
  if (diagnostics.some((line) => line.includes("not revenue-family"))) diagnostics.push("calculation_relations_unavailable");
  const faceValues = new Map<string, Map<string, number>>();
  for (const fact of input.sourceReview.facts) {
    if (!fact.lineItemId) continue;
    const byPeriod = faceValues.get(fact.lineItemId) ?? new Map<string, number>();
    byPeriod.set(fact.periodId, fact.value); faceValues.set(fact.lineItemId, byPeriod);
  }
  const candidates = buildCandidateSchemes({ validated, minted, requestedPeriodIds, faceValues,
    merges: input.store.listChildMerges(runId) });
  input.store.saveCandidates(runId, candidates);
  if (candidates.length === 0) {
    const withNoCandidates = [...diagnostics, "no_decomposition_candidates"];
    input.store.saveDiagnostics(runId, withNoCandidates);
    return { candidates: [], decision: null, diagnostics: withNoCandidates };
  }
  const reduced = await runDecompositionReduceLoop({ modelRouter: input.modelRouter, runId, candidates,
    store: input.store, task: input.task, systemPrompt: input.reducePrompt, faceValues });
  input.store.saveCandidates(runId, reduced.candidates);
  input.store.saveDiagnostics(runId, diagnostics);
  return { candidates: reduced.candidates, decision: reduced.decision, diagnostics };
}

async function allSettledLimit<T, R>(values: readonly T[], concurrency: number,
  fn: (value: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await fn(values[index]!) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}
