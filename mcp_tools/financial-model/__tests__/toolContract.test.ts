import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_READ_SECTIONS } from "../../../src/financial-model/views.ts";
import { operationsInputSchema } from "../schemas.ts";
import type { JsonSchema } from "../../../src/framework/types.ts";

/**
 * What a tool's schema says and what the engine then enforces have to be the same statement. Where
 * they drift the agent pays for it a step at a time: it reads the schema, sends what the schema
 * allows, and gets back an error it had no way to predict. Both cases below cost real steps in an
 * AAPL run — four on section names the schema never listed, one on a field it called optional.
 */

type ObjectSchema = JsonSchema & {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema & { oneOf?: ObjectSchema[] };
  required?: string[];
};

test("set_formula's schema requires periodIds, which the engine refuses a formula without", () => {
  const variants = (operationsInputSchema as ObjectSchema).properties?.["operations"] as ObjectSchema | undefined;
  const setFormula = variants?.items?.oneOf?.find((variant) =>
    (variant.properties?.["kind"] as { enum?: string[] } | undefined)?.enum?.[0] === "set_formula");
  assert.ok(setFormula, "set_formula is not in the operations union");

  const formula = setFormula.properties?.["formula"] as ObjectSchema | undefined;
  const required = formula?.required ?? [];

  assert.ok(required.includes("periodIds"),
    `validateFormula rejects a formula without periodIds, so the schema has to require it; requires: ${required.join(", ")}`);
});

test("the readable sections are named in one runtime list the schema and the validator both spread", () => {
  assert.deepEqual([...MODEL_READ_SECTIONS], [
    "history", "metrics", "revenue", "operations", "dcf",
    "source_income_statement", "source_balance_sheet", "source_cash_flow",
  ]);
  assert.equal(new Set(MODEL_READ_SECTIONS).size, MODEL_READ_SECTIONS.length, "no duplicates");
});
