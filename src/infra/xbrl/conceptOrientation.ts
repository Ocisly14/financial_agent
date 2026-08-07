import type { PresentationExtract } from "./types.ts";

export type SignOrientation = {
  /** accession -> concepts whose raw values must be negated to match the reference orientation. */
  flips: ReadonlyMap<string, ReadonlySet<string>>;
  /** Concepts with no usable orientation in at least one filing carrying them (absent from calc tree, or conflicting weights within one filing). */
  unoriented: ReadonlySet<string>;
};

/**
 * Deterministic sign orientation (spec §3): a concept's sign per filing is the sign of its
 * calculation-linkbase weight wherever it appears as a child; the newest filing with an
 * unambiguous sign defines the reference. `negatedConcepts` is display-only and never consulted.
 */
export function buildSignOrientation(filings: readonly PresentationExtract[]): SignOrientation {
  const sorted = [...filings].sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt));
  // Per filing: concept -> unambiguous weight sign, or null when one filing carries conflicting signs.
  const signsByFiling = sorted.map((extraction) => {
    const signs = new Map<string, 1 | -1 | null>();
    for (const relation of extraction.calculationRelations) for (const child of relation.children) {
      if (child.weight === 0) continue;
      const sign: 1 | -1 = child.weight < 0 ? -1 : 1;
      const prev = signs.get(child.concept);
      if (prev === undefined) signs.set(child.concept, sign);
      else if (prev !== null && prev !== sign) signs.set(child.concept, null);
    }
    return signs;
  });

  // Newest filing giving an unambiguous sign defines the reference orientation.
  const reference = new Map<string, 1 | -1>();
  for (const signs of signsByFiling) for (const [concept, sign] of signs) {
    if (sign !== null && !reference.has(concept)) reference.set(concept, sign);
  }

  const flips = new Map<string, Set<string>>();
  const unoriented = new Set<string>();
  sorted.forEach((extraction, filingIndex) => {
    const signs = signsByFiling[filingIndex]!;
    const flipped = new Set<string>();
    for (const [concept, sign] of signs) {
      if (sign === null) continue;
      const ref = reference.get(concept);
      if (ref !== undefined && sign !== ref) flipped.add(concept);
    }
    flips.set(extraction.filing.accession, flipped);
    for (const stmt of extraction.statements) for (const node of stmt.nodes) {
      if (node.facts.length === 0) continue;
      const sign = signs.get(node.conceptQName);
      if (sign === undefined || sign === null) unoriented.add(node.conceptQName);
    }
  });
  return { flips, unoriented };
}
