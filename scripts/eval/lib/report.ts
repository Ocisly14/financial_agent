export type EvalResult = {
  category: string;
  metrics: Record<string, number>;
  gateViolations: string[];
  lines: string[];
};

export function renderReport(results: EvalResult[]): { text: string; exitCode: number } {
  const body = results.flatMap((r) => r.lines).join("\n");
  const violations = results.flatMap((r) => r.gateViolations);
  const gateLine =
    violations.length === 0
      ? "GATES: all passed ✓"
      : `GATES: FAILED (${violations.length})\n  - ${violations.join("\n  - ")}`;
  return { text: `${body}\n${gateLine}`, exitCode: violations.length === 0 ? 0 : 1 };
}
