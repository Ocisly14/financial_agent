import { validate } from "./schemas.ts";
import type { JsonObject, JsonSchema, ToolDefinition, JsonValue } from "../../src/framework/types.ts";
import { applyChildMerges } from "../../src/infra/xbrl/decompositionAnalysis.ts";
import type { DecompositionStore } from "../../src/infra/xbrl/decompositionStore.ts";
import { mintTableFacts, type CandidateScheme, type MintedTableFact } from "../../src/infra/xbrl/decompositionTypes.ts";
import type { FilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";

export type LoopTool = ToolDefinition & { execute(input: JsonObject): JsonValue };

const MAX_FACT_ROWS = 20;

export function createFilingDecompositionTools(
  runId: string,
  accession: string,
  tableStore: FilingTableStore,
  onMintedFacts: (facts: readonly MintedTableFact[]) => void,
): Map<string, LoopTool> {
  const string = (): JsonSchema => ({ type: "string" });
  const numbers: JsonSchema = { type: "array", items: { type: "number" } };
  const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
    ({ type: "object", properties, required, additionalProperties: false });
  const tools: LoopTool[] = [
    {
      name: "list_table_rows", category: "non_trading",
      description: "Read the row/column structure of one filing table by sourceTableId, without values.",
      inputSchema: object({ sourceTableId: string() }, ["sourceTableId"]),
      execute(raw) {
        validate(raw, this.inputSchema, "$", true);
        const sourceTableId = raw["sourceTableId"] as string;
        const [table] = tableStore.getTables(runId, [sourceTableId]);
        if (!table) throw new Error(`unknown table: ${sourceTableId}`);
        return {
          heading: table.heading,
          columns: table.columns.map((column) => ({ index: column.index, headerText: column.headerText,
            ...(column.periodId ? { periodId: column.periodId } : {}) })),
          rows: table.rows.map((row) => ({ order: row.order, labelText: row.labelText, indentLevel: row.indentLevel,
            cells: row.cells.map((cell) => ({ columnIndex: cell.columnIndex, hasFact: Boolean(cell.fact),
              axes: (cell.fact?.dimensions ?? []).map((dimension) => `${dimension.axisQName}=${dimension.memberQName}`) })) })),
        } as unknown as JsonValue;
      },
    },
    {
      name: "get_table_facts", category: "non_trading",
      description: `Mint fact ids and values for up to ${MAX_FACT_ROWS} row orders in one table.`,
      inputSchema: object({ sourceTableId: string(), rowOrders: numbers }, ["sourceTableId", "rowOrders"]),
      execute(raw) {
        validate(raw, this.inputSchema, "$", true);
        const sourceTableId = raw["sourceTableId"] as string;
        const rowOrders = [...new Set(raw["rowOrders"] as number[])];
        if (rowOrders.length === 0 || rowOrders.length > MAX_FACT_ROWS) throw new Error(`rowOrders must contain 1-${MAX_FACT_ROWS} entries`);
        const [table] = tableStore.getTables(runId, [sourceTableId]);
        if (!table) throw new Error(`unknown table: ${sourceTableId}`);
        const wanted = new Set(rowOrders);
        const minted = mintTableFacts(table).filter((fact) => wanted.has(fact.rowOrder));
        onMintedFacts(minted);
        return { facts: minted.map((fact) => ({ factId: fact.factId, rowOrder: fact.rowOrder, periodId: fact.periodId,
          value: fact.value, unit: fact.unit, conceptQName: fact.conceptQName, dimensions: fact.dimensions,
          sourceAnchor: fact.sourceAnchor })) } as unknown as JsonValue;
      },
    },
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** Mutable working-set ref shared with the caller: the reduce loop owns the state, the tools mutate it in place. */
export type WorkingSchemesRef = { current: CandidateScheme[] };

export function createDecompositionReduceTools(
  runId: string,
  store: DecompositionStore,
  working: WorkingSchemesRef,
  faceValues?: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, LoopTool> {
  const string = (): JsonSchema => ({ type: "string" });
  const strings: JsonSchema = { type: "array", items: { type: "string" } };
  const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
    ({ type: "object", properties, required, additionalProperties: false });
  const tools: LoopTool[] = [
    {
      name: "inspect_scheme", category: "non_trading",
      description: "Get the full per-child per-period availability summary for one candidate scheme (still no cell values).",
      inputSchema: object({ candidateSchemeId: string() }, ["candidateSchemeId"]),
      execute(raw) {
        validate(raw, this.inputSchema, "$", true);
        const candidateSchemeId = raw["candidateSchemeId"] as string;
        const scheme = working.current.find((candidate) => candidate.candidateSchemeId === candidateSchemeId);
        if (!scheme) throw new Error(`unknown candidateSchemeId: ${candidateSchemeId}`);
        return {
          ...summarizeScheme(scheme),
          children: scheme.children.map((child) => ({
            childId: child.childId, label: child.label, ...(child.memberHint ? { memberHint: child.memberHint } : {}),
            availability: Object.fromEntries(scheme.periodIds.map((periodId) => [periodId, child.cells[periodId] !== undefined])),
          })),
        } as unknown as JsonValue;
      },
    },
    {
      name: "merge_children", category: "non_trading",
      description: "Merge one or more children into a kept child within a candidate scheme; records the override and re-applies merges to the working set.",
      inputSchema: object({ candidateSchemeId: string(), keepChildId: string(), mergeChildIds: strings },
        ["candidateSchemeId", "keepChildId", "mergeChildIds"]),
      execute(raw) {
        validate(raw, this.inputSchema, "$", true);
        const scheme = working.current.find((candidate) => candidate.candidateSchemeId === raw["candidateSchemeId"]);
        if (!scheme) throw new Error(`unknown candidateSchemeId: ${String(raw["candidateSchemeId"])}`);
        const ids = new Set(scheme.children.map((child) => child.childId));
        const keep = String(raw["keepChildId"]); const merge = (raw["mergeChildIds"] as string[]);
        if (!ids.has(keep) || merge.some((id) => !ids.has(id))) throw new Error("unknown childId in merge_children");
        const record = { candidateSchemeId: scheme.candidateSchemeId, keepChildId: keep, mergeChildIds: merge };
        store.saveChildMerge(runId, record);
        working.current = applyChildMerges(working.current, [record], faceValues);
        return { children: working.current.find((candidate) => candidate.candidateSchemeId === scheme.candidateSchemeId)!.children
          .map((child) => ({ childId: child.childId, label: child.label })) } as unknown as JsonValue;
      },
    },
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** Shared JSON projection of a candidate scheme (used by both loop prompt-building and the inspect_scheme tool). */
export function summarizeScheme(scheme: CandidateScheme): JsonObject {
  return {
    candidateSchemeId: scheme.candidateSchemeId, label: scheme.label, axisHint: scheme.axisHint,
    targetSourceLineItemId: scheme.targetSourceLineItemId,
    children: scheme.children.map((child) => ({ childId: child.childId, label: child.label, ...(child.memberHint ? { memberHint: child.memberHint } : {}) })),
    coverage: scheme.coverage, residualRatioByPeriod: scheme.residualRatioByPeriod,
    flags: scheme.flags, openQuestions: scheme.openQuestions,
  } as unknown as JsonObject;
}
