import type { JsonObject, JsonSchema, JsonValue } from "../../src/framework/types.ts";
import { suggestCandidates, suggestionClause } from "../../src/framework/suggest.ts";

export { suggestCandidates, suggestionClause };
import type { ModelOperation } from "../../src/financial-model/operations.ts";
import { WACC_SHEET_ROW_IDS } from "../../src/financial-model/waccSheet.ts";

const string = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const number: JsonSchema = { type: "number" };
const strings: JsonSchema = { type: "array", items: string() };
const stringsWith = (description: string): JsonSchema => ({ type: "array", items: string(), description });
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false });
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
/** Accepted for compatibility and then overwritten: the ledger's review clock is the host's. */
const HOST_STAMPED = string("Ignored. The host stamps the review time.");

/**
 * Currency-bearing units must always name their currency. Keeping this as a
 * discriminated union makes the runtime contract match `Unit` exactly instead
 * of accepting `{ kind: "currency" }` and letting an undefined code leak into
 * later unit arithmetic.
 */
export const unitSchema: JsonSchema = { type: "object", oneOf: [
  object({ kind: { type: "string", enum: ["currency"] }, code: string("ISO currency code, e.g. USD") }, ["kind", "code"]),
  object({ kind: { type: "string", enum: ["per_share"] }, code: string("ISO currency code, e.g. USD") }, ["kind", "code"]),
  object({ kind: { type: "string", enum: ["percent", "ratio", "shares", "number"] } }, ["kind"]),
] };
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
const assumption = object({ assumptionId: string("Your id for this assumption; writing the same id again replaces it."),
  lineItemId: string("The row this assumption fills. Its range must already be assumption-sourced or "
    + "still empty — a range carrying facts or a formula is refused, so re-source it in the same batch."),
  periods: stringsWith("Period ids this assumption covers. Non-empty, no duplicates."),
  payload: { type: "object",
    description: "`values` carries either ONE value applied to every period in `periods`, or exactly "
      + "one per period — any other length is refused, and so is a unit incompatible with the row's own "
      + "(`growth.*`, `margin.*` and `tax_rate` rows are percent; `ratio.*` rows are ratio, and a percent "
      + "payload on a ratio row rejects the whole batch). `not_applicable` states the row has no value here.",
    oneOf: [object({ kind: { type: "string", enum: ["values"] }, values: array(number), unit: unitSchema }, ["kind", "values", "unit"]),
      object({ kind: { type: "string", enum: ["not_applicable"] } }, ["kind"])] },
  sourceType: { type: "string", enum: ["user", "management_guidance", "company_disclosure", "consensus", "macro_research", "industry_research", "analyst_inference"] },
  sourceRefs: strings, asOfDate: string(), rationale: string() },
  ["assumptionId", "lineItemId", "periods", "payload", "sourceType", "sourceRefs", "asOfDate", "rationale"]);
// Every rule the engine enforces on a formula is stated here, because here is the only place an
// agent reads before writing one. They used to live only in validateFormula and in a playbook, and
// an AMZN run spent 7 of its 30 steps rediscovering them one rejected batch at a time.
const formula = object({
  lineItemId: string("The row this formula fills. That row's `appliesTo` range must already be "
    + "formula-sourced or still empty — a range carrying facts or an assumption is refused, so "
    + "re-source it in the same batch that rewrites it."),
  appliesTo: { type: "string", enum: ["historical", "forecast"],
    description: "Which range this formula covers. Every id in `periodIds` must belong to it — a "
      + "forecast period listed under `historical` is refused." },
  source: string("The expression, e.g. `revenue.total * margin.operating`. Units are inferred and "
    + "enforced. `+` and `-` accept only same-unit or rate±rate operands (the literals 0 and 1 are "
    + "the exceptions), so `0.08 + 0.04 * POW(0.8, YEAR_INDEX())` is REFUSED: POW always returns a "
    + "ratio and 0.08 is a bare number. `*` and `/` are permissive (number × ratio → ratio). "
    + "YEAR_INDEX() is a number and forecast-only, so a linear fade `a + (t - a) * YEAR_INDEX() / N` "
    + "is legal; to decay toward a non-zero target, reference a rate-typed row for the target rather "
    + "than writing it as a literal. LAG, YOY, CAGR, SUM and AVERAGE take a row id, never an expression."),
  periodIds: stringsWith("Explicit period ids this formula covers, e.g. [\"FY2026\", \"FY2027\"]. "
    + "Required and non-empty — the engine never infers them from `appliesTo`."),
}, ["lineItemId", "appliesTo", "source", "periodIds"]);
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
  object({ kind: { type: "string", enum: ["add_line_item"] }, lineItem: object({
    id: string("A lowercase slug. Under `revenue` and `custom_metrics` the namespace prefix is added "
      + "for you — \"margin_aws\" becomes metric.custom.margin_aws — and a fully qualified id is "
      + "accepted unchanged. Elsewhere it is the id verbatim."), label: string(),
    // Parent eligibility is semantic, not a fixed enum: a committed revenue stream may safely own
    // its disclosed economics (for example Product Revenue → Product Gross Profit). The engine
    // validates the supplied id against the skeleton, so do not make the tool schema narrower.
    parentId: string("A permitted DCF parent, including an existing revenue stream or custom_metrics"), unit: unitSchema },
  ["id", "label", "parentId"]) }, ["kind", "lineItem"]),
  object({ kind: { type: "string", enum: ["set_formula"] }, formula }, ["kind", "formula"]),
  object({ kind: { type: "string", enum: ["set_category_group"] }, group: categoryGroup }, ["kind", "group"]),
  object({ kind: { type: "string", enum: ["set_valuation_config"] }, config: valuation }, ["kind", "config"]),
  object({ kind: { type: "string", enum: ["set_wacc_input"] }, rowId: { type: "string", enum: [...WACC_SHEET_ROW_IDS] },
    value: number, formula: string(), sourceType: string(), sourceRefs: strings, rationale: string() },
  ["kind", "rowId", "sourceType", "sourceRefs", "rationale"]),
];

export const operationsInputSchema = object({ modelId: string(), expectedRevision: number,
  // Six of seven rejected batches in one AMZN run were this single mistake — the payload's fields
  // written directly on the operation. Naming the shape here costs one line and saved none of them,
  // because it was not said anywhere the agent read.
  operations: { type: "array",
    description: "Each operation is `{ kind, <payload> }`, where the payload is ONE nested object "
      + "named for the kind: set_formula → `formula`, set_assumption → `assumption`, "
      + "set_valuation_config → `config`, set_category_group → `group`, replace_fact → `replacement`, "
      + "set_line_item_source and set_wacc_input carry their fields directly. Payload fields are never "
      + "flattened onto the operation itself — `{kind:\"set_formula\", lineItemId:…}` is refused; it is "
      + "`{kind:\"set_formula\", formula:{lineItemId:…}}`. Operations apply in order within the batch.",
    items: { type: "object", oneOf: operationVariants } } }, ["modelId", "expectedRevision", "operations"]);

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
    // A top-level shape error ends the walk before any operation is read, so this one line is all the
    // agent gets — and "must be an array" alone does not say what it actually sent. A batch rejected
    // here costs the whole generation, so spend a few words naming the mistake.
    if (/^\$\.operations must be an array$/.test(message)) {
      const sent = input["operations"];
      const arrived = typeof sent === "string"
        ? "received a string — send real JSON, not JSON serialized into text"
        : sent && typeof sent === "object"
          ? "received a single object — wrap it in an array, even for one operation"
          : `received ${sent === null ? "null" : typeof sent}`;
      throw new Error(`${message} (${arrived}).`);
    }
    const match = /\$\.operations\[(\d+)\]/.exec(message);
    const rawOps = Array.isArray(input["operations"]) ? input["operations"] as JsonObject[] : [];
    if (match && rawOps[Number(match[1])]) {
      const kind = rawOps[Number(match[1])]?.["kind"];
      const known = new Set(["replace_fact", "set_assumption", "set_line_item_source", "add_line_item",
        "set_formula", "set_category_group", "set_valuation_config", "set_wacc_input"]);
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

/** Faults past this are dropped from the message. The list exists so ONE retry can fix everything;
 *  beyond a couple of dozen the batch is malformed in kind, and the rest is just context budget. */
const MAX_REPORTED_FAULTS = 20;

/**
 * A rejected batch costs the agent the whole batch — on a real issuer, minutes of generation and
 * tens of thousands of output tokens. Reporting the first fault only turned one bad batch into one
 * retry per fault, so every fault is collected and raised together.
 *
 * The single-fault message is deliberately unchanged: it is what the agents have been prompted
 * against, and what `parseOperations` matches on to append its kind hint.
 */
export function validate(value: JsonValue, schema: JsonSchema, path: string, root = false): void {
  const faults: string[] = [];
  collect(value, schema, path, root, faults);
  if (faults.length === 0) return;
  if (faults.length === 1) throw new Error(faults[0]!);
  const shown = faults.slice(0, MAX_REPORTED_FAULTS);
  const more = faults.length - shown.length;
  throw new Error(`${faults.length} validation errors — fix all of them before resending:\n`
    + shown.map((fault) => `- ${fault}`).join("\n")
    + (more > 0 ? `\n- ... and ${more} more` : ""));
}

/** Walks `value` against `schema`, appending every fault to `faults` instead of stopping at the
 *  first. Recursion continues past a fault wherever the value's shape still allows it. */
function collect(value: JsonValue, schema: JsonSchema, path: string, root: boolean, faults: string[]): void {
  if (schema.oneOf) {
    // Most tool unions are explicitly discriminated by `kind` (operations and assumption
    // payloads). Once the caller declares that discriminator, validate its matching contract
    // directly so an invalid nested field reaches the agent as a useful path-level error rather
    // than the opaque "does not match exactly one allowed variant".
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const kind = (value as JsonObject)["kind"];
      const allowedKinds = [...new Set(schema.oneOf.flatMap((candidate) => {
        const values = candidate.properties?.["kind"]?.enum;
        return Array.isArray(values) ? values.filter((entry): entry is string => typeof entry === "string") : [];
      }))];
      // All current tool unions use `kind`. Diagnose a missing or unknown
      // discriminator before attempting every branch, whose aggregate failure
      // otherwise hides the field the caller must change.
      if (allowedKinds.length > 0 && kind === undefined) {
        faults.push(`${path}.kind is required; allowed values: ${allowedKinds.join(", ")}`); return;
      }
      if (allowedKinds.length > 0 && typeof kind !== "string") {
        faults.push(`${path}.kind must be a string; allowed values: ${allowedKinds.join(", ")}`); return;
      }
      if (typeof kind === "string") {
        const matching = schema.oneOf.filter((candidate) =>
          candidate.properties?.["kind"]?.enum?.includes(kind));
        // The discriminator picked the contract, so its own faults are the real ones — collect them
        // all rather than collapsing the branch into "does not match a variant".
        if (matching.length === 1) return collect(value, matching[0]!, path, root, faults);
        if (allowedKinds.length > 0 && matching.length === 0) {
          faults.push(`${path}.kind must be one of ${allowedKinds.join(", ")}; received ${JSON.stringify(kind)}`); return;
        }
      }
    }
    // Undiscriminated union: a branch's faults say nothing on their own, since failing the other
    // branches is the normal case. Only the count of clean branches is meaningful.
    const clean = schema.oneOf.filter((candidate) => {
      const branch: string[] = [];
      collect(value, candidate, path, false, branch);
      return branch.length === 0;
    }).length;
    if (clean !== 1) faults.push(`${path} does not match exactly one allowed variant`);
    return;
  }
  if (schema.type === "object") {
    // A value of the wrong shape ends this branch: there is nothing to descend into, and guessing
    // at its fields would bury the one fault that matters under noise.
    if (!value || typeof value !== "object" || Array.isArray(value)) { faults.push(`${path} must be an object`); return; }
    const record = value as JsonObject; const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in record)) faults.push(`${path}.${key} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) {
      if (!(key in properties) && !(root && key === "task")) faults.push(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (record[key] !== undefined) collect(record[key]!, child, `${path}.${key}`, false, faults);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) { faults.push(`${path} must be an array`); return; }
    value.forEach((entry, index) => collect(entry, schema.items ?? { type: "any" }, `${path}[${index}]`, false, faults));
    return;
  }
  if (schema.type === "string" && typeof value !== "string") { faults.push(`${path} must be a string`); return; }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) { faults.push(`${path} must be a number`); return; }
  if (schema.type === "boolean" && typeof value !== "boolean") { faults.push(`${path} must be a boolean`); return; }
  if (schema.enum && !schema.enum.includes(value as string)) {
    const allowed = schema.enum.filter((entry): entry is string => typeof entry === "string");
    faults.push(`${path} must be one of ${schema.enum.join(", ")}; received ${JSON.stringify(value)}.`
      + (typeof value === "string"
        ? suggestionClause(value, [{ kind: "allowed value", how: "this field", names: allowed }])
        : ""));
  }
}
