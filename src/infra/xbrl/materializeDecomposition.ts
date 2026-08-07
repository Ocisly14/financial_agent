import type { SourceReviewArtifact } from "./sourceReviewStore.ts";
import type { CandidateScheme, DecompositionSummary, FinalDecompositionDecision } from "./decompositionTypes.ts";
import { shortHash } from "./decompositionAnalysis.ts";

const DEFAULT_RESIDUAL_THRESHOLD = 0.005;

export function materializeDecomposition(input: {
  artifact: SourceReviewArtifact;
  candidates: readonly CandidateScheme[];
  decision: FinalDecompositionDecision;
  residualThreshold?: number;
}): SourceReviewArtifact {
  const threshold = input.residualThreshold ?? DEFAULT_RESIDUAL_THRESHOLD;
  const artifact = structuredClone(input.artifact) as SourceReviewArtifact;
  const byId = new Map(input.candidates.map((candidate) => [candidate.candidateSchemeId, candidate]));
  const view = artifact.statementViews.income_statement;
  // Re-applying must replace, not accumulate: drop artifacts materialized by an earlier apply so the
  // decomposition is a pure function of the current decision (idempotent apply_revenue_decomposition).
  view.candidate.rows = view.candidate.rows.filter((row) =>
    !(row.sourceLineItemId.startsWith("source.income_statement.revenue.") && row.parentSourceLineItemId));
  artifact.facts = artifact.facts.filter((fact) =>
    fact.provenance.sourceType !== "filing_xbrl_decomposition" && fact.provenance.sourceType !== "derived_residual");
  const faceRows = new Map(view.candidate.rows.map((row) => [row.sourceLineItemId, row]));
  const faceFacts = new Map(artifact.facts.filter((fact) => fact.lineItemId)
    .map((fact) => [`${fact.lineItemId}|${fact.periodId}`, fact]));
  const summary: DecompositionSummary = { schemes: [] };
  for (const schemeId of input.decision.acceptedSchemeIds) {
    const scheme = byId.get(schemeId);
    if (!scheme) throw new Error(`unknown candidateSchemeId: ${schemeId}`);
    const target = faceRows.get(scheme.targetSourceLineItemId);
    if (!target) throw new Error(`decomposition target row missing: ${scheme.targetSourceLineItemId}`);
    const summaryChildren: DecompositionSummary["schemes"][number]["children"] = [];
    let order = view.candidate.rows.length;
    const childRow = (label: string, hashInput: string) => {
      // Row ids land inside statement-mapping formulas, whose identifier charset excludes "-" (reads as minus).
      const sourceLineItemId = `source.income_statement.revenue.${scheme.candidateSchemeId.replaceAll("-", "_")}.${shortHash(hashInput)}`;
      order += 1;
      view.candidate.rows.push({ ...structuredClone(target), sourceLineItemId, label, order,
        depth: target.depth + 1, parentSourceLineItemId: target.sourceLineItemId, presentationAccessions: [] });
      return sourceLineItemId;
    };
    for (const child of scheme.children) {
      const rowId = childRow(child.label, `${scheme.candidateSchemeId}|${child.label}|${scheme.axisHint}|${child.memberHint ?? ""}`);
      summaryChildren.push({ childRowId: rowId, label: child.label });
      for (const [periodId, cell] of Object.entries(child.cells)) {
        artifact.facts.push({ factId: cell.factId, status: "staged", lineItemId: rowId, periodId, value: cell.value,
          unit: structuredClone(target.unit), provenance: { sourceType: "filing_xbrl_decomposition",
            sourceRefs: [cell.sourceAnchor], asOfDate: cell.filedAt, accession: cell.accession } });
      }
    }
    // Residual children per period (spec §6): identity face = Σ children holds exactly.
    const residualByPeriod = scheme.periodIds.flatMap((periodId) => {
      const face = faceFacts.get(`${scheme.targetSourceLineItemId}|${periodId}`);
      if (!face || face.value === 0) return [];
      const sum = scheme.children.reduce((total, child) => total + (child.cells[periodId]?.value ?? 0), 0);
      const residual = face.value - sum;
      return Math.abs(residual) / Math.abs(face.value) > threshold ? [{ periodId, residual, anchors:
        scheme.children.flatMap((child) => child.cells[periodId] ? [child.cells[periodId]!.sourceAnchor] : []) }] : [];
    });
    if (residualByPeriod.length > 0) {
      const rowId = childRow("Other / unallocated", `${scheme.candidateSchemeId}|__residual__|${scheme.axisHint}|`);
      summaryChildren.push({ childRowId: rowId, label: "Other / unallocated", residual: true });
      for (const { periodId, residual, anchors } of residualByPeriod) {
        artifact.facts.push({ factId: `xbrl-${shortHash(`residual|${rowId}|${periodId}`)}`, status: "staged", lineItemId: rowId,
          periodId, value: residual, unit: structuredClone(target.unit),
          provenance: { sourceType: "derived_residual", sourceRefs: anchors, asOfDate: new Date().toISOString().slice(0, 10) } });
      }
    }
    summary.schemes.push({ candidateSchemeId: scheme.candidateSchemeId, label: scheme.label, axisHint: scheme.axisHint,
      targetSourceLineItemId: scheme.targetSourceLineItemId, driver: input.decision.driverSchemeId === scheme.candidateSchemeId,
      children: summaryChildren });
  }
  artifact.decomposition = summary;
  return artifact;
}
