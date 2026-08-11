import type { JsonObject, JsonSchema, JsonValue } from "../../src/framework/types.ts";
import type { ModelOperation } from "../../src/financial-model/operations.ts";
import { WACC_SHEET_ROW_IDS } from "../../src/financial-model/waccSheet.ts";

const string = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const number: JsonSchema = { type: "number" };
const strings: JsonSchema = { type: "array", items: string() };
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false });
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
/** Accepted for compatibility and then overwritten: the ledger's review clock is the host's. */
const HOST_STAMPED = string("Ignored. The host stamps the review time.");

export const unitSchema = object({ kind: { type: "string", enum: ["currency", "percent", "ratio", "shares", "per_share", "number"] }, code: string("Required for currency/per_share") }, ["kind"]);
const groupMember = object({ lineItemId: string(), treatment: { type: "string", enum: ["add", "subtract", "exclude"] } }, ["lineItemId", "treatment"]);
const provenance = object({ sourceType: string(), sourceRefs: strings, asOfDate: string(), decimals: number, accession: string(), concept: string(), filingUrl: string() },
  ["sourceType", "sourceRefs", "asOfDate"]);
const fact = object({ factId: string(), status: { type: "string", enum: ["staged"] }, lineItemId: string(), periodId: string(), value: number,
  unit: unitSchema, provenance,
  // Required by the engine's supersede pairing, so replace_fact is unusable without it.
  supersedesFactId: string("The committed fact this one replaces. Required for replace_fact.") },
["factId", "status", "periodId", "value", "unit", "provenance"]);
const decision = (actions: string[]) => object({ decisionId: string(), factId: string(), action: { type: "string", enum: actions }, mappedLineItemId: string(),
  replacementFactId: string(), rationale: string(), reviewedBy: string(), reviewedAt: HOST_STAMPED }, ["decisionId", "factId", "action", "rationale", "reviewedBy"]);
const assumption = object({ assumptionId: string(), lineItemId: string(), periods: strings,
  payload: { type: "object", oneOf: [object({ kind: { type: "string", enum: ["values"] }, values: array(number), unit: unitSchema }, ["kind", "values", "unit"]),
    object({ kind: { type: "string", enum: ["not_applicable"] } }, ["kind"])] },
  sourceType: { type: "string", enum: ["user", "management_guidance", "company_disclosure", "consensus", "macro_research", "industry_research", "analyst_inference"] },
  sourceRefs: strings, asOfDate: string(), rationale: string() },
  ["assumptionId", "lineItemId", "periods", "payload", "sourceType", "sourceRefs", "asOfDate", "rationale"]);
const formula = object({ lineItemId: string(), appliesTo: { type: "string", enum: ["historical", "forecast"] }, source: string(), periodIds: strings },
  ["lineItemId", "appliesTo", "source"]);
const categoryGroup = object({ parentLineItemId: string(), category: string(), periodIds: strings, members: array(groupMember), reviewDecisionId: string() },
  ["parentLineItemId", "category", "periodIds", "members", "reviewDecisionId"]);
const sensitivity = object({ waccDeltas: array(number), terminalGrowthDeltas: array(number), exitMultipleDeltas: array(number) },
  ["waccDeltas", "terminalGrowthDeltas", "exitMultipleDeltas"]);
const valuation = object({ anchorPeriodId: string(), discountConvention: { type: "string", enum: ["year_end", "mid_year"] },
  exitTerminalMetric: { type: "string", enum: ["ebitda", "fcff"] }, sensitivity, sourceType: { type: "string", enum: ["user", "analyst_inference"] },
  sourceRefs: strings, asOfDate: string(), rationale: string() },
  ["anchorPeriodId", "discountConvention", "exitTerminalMetric", "sensitivity", "sourceType", "sourceRefs", "asOfDate", "rationale"]);

const operationVariants: JsonSchema[] = [
  object({ kind: { type: "string", enum: ["replace_fact"] }, replacement: fact, commitDecision: decision(["commit"]), supersedeDecision: decision(["supersede"]) }, ["kind", "replacement", "commitDecision", "supersedeDecision"]),
  object({ kind: { type: "string", enum: ["set_assumption"] }, assumption }, ["kind", "assumption"]),
  object({ kind: { type: "string", enum: ["set_line_item_source"] }, lineItemId: string(), range: { type: "string", enum: ["historical", "forecast"] },
    source: { type: "string", enum: ["actual", "assumption", "formula", "none"] } }, ["kind", "lineItemId", "range", "source"]),
  object({ kind: { type: "string", enum: ["add_line_item"] }, lineItem: object({ id: string(), label: string(),
    parentId: { type: "string", enum: ["revenue", "cost_of_revenue", "operating_expenses", "total_current_assets", "total_current_liabilities", "operating_working_capital", "custom_metrics"] }, unit: unitSchema },
  ["id", "label", "parentId"]) }, ["kind", "lineItem"]),
  object({ kind: { type: "string", enum: ["add_metric"] }, metric: object({ registryId: { type: "string", enum: ["cagr"] },
    targetLineItemId: string(), lookbackPeriods: number }, ["registryId", "targetLineItemId", "lookbackPeriods"]) }, ["kind", "metric"]),
  object({ kind: { type: "string", enum: ["set_formula"] }, formula }, ["kind", "formula"]),
  object({ kind: { type: "string", enum: ["set_category_group"] }, group: categoryGroup }, ["kind", "group"]),
  object({ kind: { type: "string", enum: ["set_valuation_config"] }, config: valuation }, ["kind", "config"]),
  object({ kind: { type: "string", enum: ["set_wacc_input"] }, rowId: { type: "string", enum: [...WACC_SHEET_ROW_IDS] },
    value: number, formula: string(), sourceType: string(), sourceRefs: strings, rationale: string() },
  ["kind", "rowId", "sourceType", "sourceRefs", "rationale"]),
];

export const operationsInputSchema = object({ modelId: string(), expectedRevision: number,
  operations: { type: "array", items: { type: "object", oneOf: operationVariants } } }, ["modelId", "expectedRevision", "operations"]);

/** Per-batch operation cap: structural errors in long JSON output accumulate with length, so an
 *  oversized batch is rejected outright with a hint to split it. */
export const MAX_OPERATIONS_PER_BATCH = 10;

export function parseOperations(input: JsonObject): ModelOperation[] {
  try {
    validate(input, operationsInputSchema, "$", true);
  } catch (error) {
    // A bare "does not match exactly one allowed variant" hides WHICH operation failed and whether
    // its kind even exists — append the offending op's kind so the fix direction is obvious.
    const message = error instanceof Error ? error.message : String(error);
    const match = /\$\.operations\[(\d+)\]/.exec(message);
    const rawOps = Array.isArray(input["operations"]) ? input["operations"] as JsonObject[] : [];
    if (match && rawOps[Number(match[1])]) {
      const kind = rawOps[Number(match[1])]?.["kind"];
      const known = new Set(["replace_fact", "set_assumption", "set_line_item_source", "add_line_item",
        "add_metric", "set_formula", "set_category_group", "set_valuation_config", "set_wacc_input"]);
      const hint = typeof kind === "string"
        ? (known.has(kind) ? ` (operation kind "${kind}" — a field is missing or malformed)`
          : ` (unknown operation kind "${kind}"; allowed kinds: ${[...known].join(", ")})`)
        : " (operation has no \"kind\" field)";
      throw new Error(message + hint);
    }
    throw error;
  }
  const operations = input["operations"] as unknown as JsonObject[];
  if (operations.length > MAX_OPERATIONS_PER_BATCH) {
    throw new Error(`operations batch too large: ${operations.length} operations, maximum is ${MAX_OPERATIONS_PER_BATCH}. `
      + `Split into consecutive batches of at most ${MAX_OPERATIONS_PER_BATCH}; each batch commits its own revision, so splitting never changes the outcome.`);
  }
  // Every other variant's JSON shape matches its ModelOperation shape field-for-field, so the cast
  // below is a straight passthrough. `set_wacc_input` is the one exception: the tool-facing schema
  // is flat (rowId/value/formula/sourceType/sourceRefs/rationale alongside kind) while the typed
  // operation nests those fields under `input` (and the tool never supplies `asOfDate` — the host
  // stamps it from the sheet's own asOfDate in the operation handler). Repack it here.
  return operations.map((operation): ModelOperation => {
    if (operation["kind"] !== "set_wacc_input") return operation as unknown as ModelOperation;
    const { kind: _kind, ...rest } = operation;
    return {
      kind: "set_wacc_input",
      input: rest as unknown as Extract<ModelOperation, { kind: "set_wacc_input" }>["input"],
    };
  });
}

export function validate(value: JsonValue, schema: JsonSchema, path: string, root = false): void {
  if (schema.oneOf) {
    const errors = schema.oneOf.map((candidate) => { try { validate(value, candidate, path); return null; } catch (error) { return error; } });
    if (errors.filter((error) => error === null).length !== 1) throw new Error(`${path} does not match exactly one allowed variant`);
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const record = value as JsonObject; const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in record)) throw new Error(`${path}.${key} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) {
      if (!(key in properties) && !(root && key === "task")) throw new Error(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) if (record[key] !== undefined) validate(record[key]!, child, `${path}.${key}`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    value.forEach((entry, index) => validate(entry, schema.items ?? { type: "any" }, `${path}[${index}]`)); return;
  }
  if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} must be a number`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  if (schema.enum && !schema.enum.includes(value as string)) throw new Error(`${path} must be one of ${schema.enum.join(", ")}`);
}
