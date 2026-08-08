import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import type { ModelOperation } from "../../src/financial-model/operations.ts";
import { FinancialModelService } from "../../src/financial-model/service.ts";
import type { StatementKind, Unit } from "../../src/financial-model/types.ts";
import { memberSlug } from "../../src/infra/xbrl/spineFromUnified.ts";
import type { BreakdownRow, UnifiedStatementsArtifact } from "../../src/infra/xbrl/unifiedStatements.ts";
import type { RegisteredTool, ToolExecutionContext } from "../toolRegistry.ts";
import { failure, getDefaultFinancialModelToolDeps, toolError, type FinancialModelToolDeps } from "./financialModelTools.ts";
import { validate } from "./schemas.ts";

export const WORKBENCH_TOOLS = ["list_unified_statements", "get_unified_rows", "calculate_model_rows"] as const;

export const UNIFIED_ROWS_PAGE = 40;

const LIST_INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["modelId"], properties: {
  modelId: { type: "string" },
  statement: { type: "string", description: "Narrow to one statement's rows: income_statement, balance_sheet, or cash_flow_statement." },
} };

const CALCULATE_INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["modelId", "expectedRevision", "rows"], properties: {
  modelId: { type: "string" }, expectedRevision: { type: "number" },
  rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "formula"], properties: {
    id: { type: "string", description: "Lowercase slug, e.g. \"gm\" — becomes metric.custom.<id>." },
    formula: { type: "string", description: "DSL expression; bare slugs from this same batch expand to their metric.custom.* id." },
    label: { type: "string" }, description: { type: "string" }, unit: { type: "object" },
  } } },
} };

const GET_INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["modelId"], properties: {
  modelId: { type: "string" },
  rowIds: { type: "array", items: { type: "string" }, description: "Exact rowIds to fetch, bypassing every other filter." },
  statement: { type: "string" },
  parentRowId: { type: "string", description: "Restrict to breakdown rows under this unified rowId." },
  axisQName: { type: "string" },
  memberFilter: { type: "string", description: "Case-insensitive substring match against label or memberQName." },
  memberQNames: { type: "array", items: { type: "string" }, description: "Exact memberQName allowlist; a breakdown row matches if its memberQName is in this set." },
  parentMemberQName: { type: "string", description: "Exact match against a breakdown row's own parentMemberQName." },
  cursor: { type: "number", description: `Zero-based offset into the filtered result set. Page size is ${UNIFIED_ROWS_PAGE}.` },
} };

/** Common shape both a unified row and a breakdown row can be filtered and rendered through.
 * `effectiveStatement` is filter-only: for a breakdown row it is the *parent* unified row's
 * statement (breakdown rows carry no statement of their own), so `statement` composes with
 * breakdown-level filters instead of excluding every breakdown row outright. `statement` stays
 * the projection field — only unified rows set it — so the output shape is unaffected. */
type Candidate = { rowId: string; label: string; statement?: StatementKind; effectiveStatement?: StatementKind;
  parentRowId?: string; axisQName?: string; memberQName?: string; parentMemberQName?: string;
  values: Record<string, number | null> };

function toUnifiedCandidate(row: UnifiedStatementsArtifact["rows"][number]): Candidate {
  return { rowId: row.rowId, label: row.label, statement: row.statement, effectiveStatement: row.statement, values: row.values };
}
function toBreakdownCandidate(row: BreakdownRow, statementOf: ReadonlyMap<string, StatementKind>): Candidate {
  const parentStatement = statementOf.get(row.parentRowId);
  return { rowId: row.rowId, label: row.label, parentRowId: row.parentRowId, axisQName: row.axisQName,
    memberQName: row.memberQName, ...(row.parentMemberQName === undefined ? {} : { parentMemberQName: row.parentMemberQName }),
    ...(parentStatement === undefined ? {} : { effectiveStatement: parentStatement }),
    values: row.values };
}

type RowFilters = { statement?: string; parentRowId?: string; axisQName?: string; memberFilter?: string;
  parentMemberQName?: string; memberQNames?: readonly string[] };

/** AND-combines every filter present. A filter naming a field the candidate lacks (e.g. `axisQName`
 * against a unified row) simply excludes that candidate — this one function is what gives unified
 * rows "statement/parentRowId apply" and breakdown rows "every filter applies" behavior, without
 * needing separate code paths. `parentRowId` matches both the breakdown rows under it *and* the
 * unified parent row itself (its own `rowId`), so "give me X and its splits" returns a total to
 * check the splits against. */
function matchesFilters(candidate: Candidate, filters: RowFilters): boolean {
  if (filters.statement !== undefined && candidate.effectiveStatement !== filters.statement) return false;
  if (filters.parentRowId !== undefined && candidate.parentRowId !== filters.parentRowId && candidate.rowId !== filters.parentRowId) return false;
  if (filters.axisQName !== undefined && candidate.axisQName !== filters.axisQName) return false;
  if (filters.parentMemberQName !== undefined && candidate.parentMemberQName !== filters.parentMemberQName) return false;
  if (filters.memberQNames !== undefined
      && (candidate.memberQName === undefined || !filters.memberQNames.includes(candidate.memberQName))) return false;
  if (filters.memberFilter !== undefined) {
    const needle = filters.memberFilter.toLowerCase();
    const label = candidate.label.toLowerCase();
    const member = candidate.memberQName?.toLowerCase() ?? "";
    if (!label.includes(needle) && !member.includes(needle)) return false;
  }
  return true;
}

function candidateToRow(candidate: Candidate): JsonObject {
  return { rowId: candidate.rowId, label: candidate.label,
    ...(candidate.statement === undefined ? {} : { statement: candidate.statement }),
    ...(candidate.axisQName === undefined ? {} : { axisQName: candidate.axisQName }),
    ...(candidate.parentMemberQName === undefined ? {} : { parentMemberQName: candidate.parentMemberQName }),
    values: candidate.values as unknown as JsonValue };
}

/** Heuristic: a breakdown member "is in the workbook" when a line item id ends with its slug under a
 * `revenue.` prefix — either directly (`revenue.<slug>`) or nested under a chosen parent stream
 * (`revenue.<parent>.<slug>`), mirroring how `resolveDetailLineItemIds` names promoted rows. It is a
 * heuristic, not an exact inverse of that function: a slug collision with an unrelated custom row
 * would false-positive, and that is an acceptable false positive for a read-only catalog hint. */
function memberInWorkbook(rowId: string, lineItemIds: ReadonlySet<string>): boolean {
  const slug = memberSlug(rowId);
  const direct = `revenue.${slug}`;
  const suffix = `.${slug}`;
  for (const id of lineItemIds) {
    if (id === direct) return true;
    if (id.startsWith("revenue.") && id.endsWith(suffix)) return true;
  }
  return false;
}

type LoadResult = { unified: UnifiedStatementsArtifact; lineItemIds: ReadonlySet<string> };

function loadUnified(deps: FinancialModelToolDeps, modelId: string, agentId: string): LoadResult | ToolExecutionResult {
  const meta = deps.modelStore.getMeta(modelId);
  if (!meta || meta.ownerAgentId !== agentId) return failure("financial_model_not_found", `model not found: ${modelId}`);
  const review = deps.sourceReviewStore.get(modelId);
  const unified = review?.unifiedStatements;
  if (!unified) return failure("unified_statements_unavailable", "no unified statements for this model yet; run the statement_unification subagent first");
  const stored = deps.modelStore.getRevision(modelId);
  const lineItemIds = new Set((stored?.snapshot.lineItems ?? []).map((item) => item.id));
  return { unified, lineItemIds };
}
function isLoadResult(value: LoadResult | ToolExecutionResult): value is LoadResult { return "unified" in value; }

export function createWorkbenchTools(injected?: FinancialModelToolDeps): RegisteredTool[] {
  const deps = injected ?? getDefaultFinancialModelToolDeps();
  return [createListUnifiedStatementsTool(deps), createGetUnifiedRowsTool(deps), createCalculateModelRowsTool(deps)];
}

function createListUnifiedStatementsTool(deps: FinancialModelToolDeps): RegisteredTool {
  return {
    name: "list_unified_statements",
    description: "Catalog of a model's unified statement rows and breakdown axes, without values — orient before pulling specific rows with get_unified_rows.",
    category: "non_trading",
    inputSchema: LIST_INPUT_SCHEMA,
    async execute(input, context) {
      try { validate(input, LIST_INPUT_SCHEMA, "$", true); }
      catch (error) { return failure("invalid_tool_input", message(error)); }
      return listUnifiedStatements(deps, input, context);
    },
  };
}

function createGetUnifiedRowsTool(deps: FinancialModelToolDeps): RegisteredTool {
  return {
    name: "get_unified_rows",
    description: "Fetch unified statement rows and/or breakdown rows with values, filtered and paginated.",
    category: "non_trading",
    inputSchema: GET_INPUT_SCHEMA,
    async execute(input, context) {
      try { validate(input, GET_INPUT_SCHEMA, "$", true); }
      catch (error) { return failure("invalid_tool_input", message(error)); }
      return getUnifiedRows(deps, input, context);
    },
  };
}

function createCalculateModelRowsTool(deps: FinancialModelToolDeps): RegisteredTool {
  return {
    name: "calculate_model_rows",
    description: "Add one or more custom metric rows and set their formulas in a single atomic revision, resolving cross-references within the batch by bare slug.",
    category: "non_trading",
    inputSchema: CALCULATE_INPUT_SCHEMA,
    async execute(input, context) {
      try { validate(input, CALCULATE_INPUT_SCHEMA, "$", true); }
      catch (error) { return failure("invalid_tool_input", message(error)); }
      return calculateModelRows(deps, input, context);
    },
  };
}

const ROW_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const TOKEN_PATTERN = /[A-Za-z_][A-Za-z0-9_.]*/g;

type CalculateRowInput = { id: string; formula: string; label?: string; description?: string; unit?: Unit };

/** Rewrites bare batch-local slugs into their `metric.custom.*` id inside a formula's source, so a
 * caller can write `a * 2` instead of `metric.custom.a * 2`. Tokenizes on the same identifier shape
 * the DSL parser uses, so `a` never matches inside `abc`, and a token that already starts
 * `metric.custom.` is left untouched (it can never equal a bare slug — slugs never contain dots). */
export function expandSlugs(formula: string, slugs: ReadonlySet<string>): string {
  return formula.replace(TOKEN_PATTERN, (token) => (slugs.has(token) ? `metric.custom.${token}` : token));
}

function calculateModelRows(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): ToolExecutionResult {
  const modelId = String(input["modelId"]);
  const meta = deps.modelStore.getMeta(modelId);
  if (!meta || meta.ownerAgentId !== context.agentId) return failure("financial_model_not_found", `model not found: ${modelId}`);
  const stored = deps.modelStore.getRevision(modelId);
  if (!stored) return failure("financial_model_not_found", `model not found: ${modelId}`);
  const expectedRevision = input["expectedRevision"] as number;
  const rows = input["rows"] as unknown as CalculateRowInput[];

  const existingLineItemIds = new Set(stored.snapshot.lineItems.map((item) => item.id));
  const slugs = new Set<string>();
  for (const row of rows) {
    if (!ROW_ID_PATTERN.test(row.id)) return failure("invalid_tool_input", `row id must match ^[a-z][a-z0-9_]*$: ${row.id}`);
    if (slugs.has(row.id)) return failure("invalid_tool_input", `duplicate row id in batch: ${row.id}`);
    if (existingLineItemIds.has(row.id)) return failure("invalid_tool_input",
      `row id shadows an existing line item; pick another slug: ${row.id}`);
    slugs.add(row.id);
  }

  const periodIds = stored.snapshot.periods.filter((p) => p.cls === "actual").map((p) => p.id);
  const addOps: ModelOperation[] = rows.map((row) => ({
    kind: "add_line_item", lineItem: { id: `metric.custom.${row.id}`, label: row.label ?? row.id.replace(/_/g, " "),
      parentId: "custom_metrics", unit: row.unit ?? { kind: "ratio" }, ...(row.description ? { description: row.description } : {}) },
  }));
  const formulaOps: ModelOperation[] = rows.map((row) => ({
    kind: "set_formula", formula: { lineItemId: `metric.custom.${row.id}`, appliesTo: "historical",
      source: expandSlugs(row.formula, slugs), periodIds },
  }));

  const service = new FinancialModelService(deps.modelStore, context.sessionId);
  try {
    const result = service.applyOperations(modelId, expectedRevision, [...addOps, ...formulaOps]);
    const metricsRows = result.currentWorkbook.sections.metrics;
    const data = rows.map((row) => {
      const fullId = `metric.custom.${row.id}`;
      const workbookRow = metricsRows.find((r) => r.lineItemId === fullId);
      const values: Record<string, number | null> = {};
      if (workbookRow) for (const [periodId, cell] of Object.entries(workbookRow.cells)) values[periodId] = cell.value;
      return { lineItemId: fullId, label: row.label ?? row.id.replace(/_/g, " "),
        ...(row.description ? { description: row.description } : {}), formula: row.formula, values };
    });
    return { summary: `Calculated ${rows.length} custom metric row(s) for model ${modelId}; now at revision ${result.revision}.`,
      generation_context: { data: { model_id: modelId, revision: result.revision, rows: data as unknown as JsonValue } } };
  } catch (error) {
    return toolError(error);
  }
}

function listUnifiedStatements(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): ToolExecutionResult {
  const modelId = String(input["modelId"]);
  const loaded = loadUnified(deps, modelId, context.agentId);
  if (!isLoadResult(loaded)) return loaded;
  const { unified, lineItemIds } = loaded;
  const statementFilter = typeof input["statement"] === "string" ? input["statement"] as StatementKind : undefined;

  const filteredRows = unified.rows.filter((row) => statementFilter === undefined || row.statement === statementFilter);
  const rows = filteredRows.map((row) => ({ rowId: row.rowId, label: row.label, statement: row.statement,
    periodsCovered: Object.values(row.values).filter((v) => v !== null).length }));

  const statementOf = new Map(unified.rows.map((row) => [row.rowId, row.statement]));
  const breakdownRows = unified.breakdownRows ?? [];
  const groups = new Map<string, BreakdownRow[]>();
  for (const row of breakdownRows) {
    if (statementFilter !== undefined && statementOf.get(row.parentRowId) !== statementFilter) continue;
    const key = `${row.axisQName}|${row.parentRowId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const breakdownAxes = [...groups.entries()].map(([, members]) => {
    const [first] = members;
    return { axisQName: first!.axisQName, parentRowId: first!.parentRowId, memberCount: members.length,
      hasMemberTree: members.some((m) => m.parentMemberQName !== undefined),
      inWorkbook: members.some((m) => memberInWorkbook(m.rowId, lineItemIds)) };
  });

  return { summary: `Model ${modelId} has ${rows.length} unified statement row(s) and ${breakdownAxes.length} breakdown axis/axes.`,
    generation_context: { data: { periods: unified.periods as unknown as JsonValue, rows: rows as unknown as JsonValue, breakdownAxes: breakdownAxes as unknown as JsonValue } } };
}

function getUnifiedRows(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): ToolExecutionResult {
  const modelId = String(input["modelId"]);
  const loaded = loadUnified(deps, modelId, context.agentId);
  if (!isLoadResult(loaded)) return loaded;
  const { unified } = loaded;

  const statementOf = new Map(unified.rows.map((row) => [row.rowId, row.statement]));
  const all: Candidate[] = [...unified.rows.map(toUnifiedCandidate),
    ...(unified.breakdownRows ?? []).map((row) => toBreakdownCandidate(row, statementOf))];

  const rowIdsInput = Array.isArray(input["rowIds"]) ? input["rowIds"].filter((v): v is string => typeof v === "string") : undefined;
  let filtered: Candidate[];
  if (rowIdsInput !== undefined && rowIdsInput.length > 0) {
    const wanted = new Set(rowIdsInput);
    filtered = all.filter((c) => wanted.has(c.rowId));
  } else {
    const memberQNamesInput = Array.isArray(input["memberQNames"])
      ? input["memberQNames"].filter((v): v is string => typeof v === "string") : undefined;
    const filters: RowFilters = {
      ...(typeof input["statement"] === "string" ? { statement: input["statement"] } : {}),
      ...(typeof input["parentRowId"] === "string" ? { parentRowId: input["parentRowId"] } : {}),
      ...(typeof input["axisQName"] === "string" ? { axisQName: input["axisQName"] } : {}),
      ...(typeof input["memberFilter"] === "string" ? { memberFilter: input["memberFilter"] } : {}),
      ...(typeof input["parentMemberQName"] === "string" ? { parentMemberQName: input["parentMemberQName"] } : {}),
      ...(memberQNamesInput !== undefined ? { memberQNames: memberQNamesInput } : {}),
    };
    filtered = all.filter((c) => matchesFilters(c, filters));
  }

  const cursorInput = input["cursor"];
  if (cursorInput !== undefined && (typeof cursorInput !== "number" || !Number.isInteger(cursorInput) || cursorInput < 0)) {
    return failure("invalid_tool_input", "cursor must be a non-negative integer");
  }
  const cursor = typeof cursorInput === "number" ? cursorInput : 0;
  const page = filtered.slice(cursor, cursor + UNIFIED_ROWS_PAGE);
  const nextCursor = cursor + UNIFIED_ROWS_PAGE < filtered.length ? cursor + UNIFIED_ROWS_PAGE : undefined;

  const rows = page.map(candidateToRow);
  return { summary: `Fetched ${rows.length} of ${filtered.length} matching row(s) for model ${modelId}${nextCursor === undefined ? "" : ` (more available at cursor ${nextCursor})`}.`,
    generation_context: { data: { rows: rows as unknown as JsonValue, ...(nextCursor === undefined ? {} : { nextCursor }) } } };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
