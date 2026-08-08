/**
 * The inputs behind a model's WACC, stored one parameter per row.
 *
 * WACC is computed, not assumed (see wacc.ts), which only means something if the terms it was
 * computed from survive. Storing the 9.04% alone leaves nothing to audit and nothing to re-run: a
 * later session cannot tell whether beta came from five years of daily bars or ten, and changing the
 * equity risk premium means guessing a fresh number rather than recomputing.
 *
 * A row per parameter rather than one blob, because they arrive separately and from different places
 * — beta from the bar cache, the risk-free rate from Treasury data, the cost of debt from the filings
 * or a search, the tax rate from the model's own income statement. Each carries its own provenance
 * and can be replaced without disturbing the others.
 *
 * Keyed by model, not by ticker. Two models of the same issuer may legitimately hold different
 * premium assumptions, and this is the record of one analysis rather than a fact about the company.
 * Market data that IS a fact about the company (the price bars beta is computed from) is cached in
 * the bar store, so nothing here needs to be a cache.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WaccInputs, WaccResult } from "./wacc.ts";
import { computeWacc } from "./wacc.ts";

/** The seven terms `computeWacc` needs. The names are the `WaccInputs` keys, so the set maps directly. */
export const WACC_PARAMETER_NAMES = [
  "beta", "riskFreeRate", "equityRiskPremium", "costOfDebt", "taxRate", "equityValue", "totalDebt",
] as const;
export type WaccParameterName = typeof WACC_PARAMETER_NAMES[number];

export type WaccParameterSource =
  /** Derived by the engine from data it holds — beta from bars, the tax rate from the income statement. */
  | "computed"
  /** Read off the issuer's filings. */
  | "filing"
  /** A market observation: a Treasury yield, a closing price. */
  | "market"
  /** Found by the agent through search, e.g. an issuer's bond yield or rating. */
  | "search"
  /** The agent's own judgment. The equity risk premium has no measurable source and lands here. */
  | "agent_estimate";

export type WaccParameter = {
  name: WaccParameterName;
  value: number;
  sourceType: WaccParameterSource;
  sourceRefs: string[];
  /**
   * How the value was arrived at, in whatever shape the producer needs: beta records its window,
   * frequency, market proxy, feed, and observation counts; the tax rate records its per-period rates.
   * Free-form on purpose — the alternative is a column per producer.
   */
  derivation: Record<string, unknown>;
  asOfDate: string;
  rationale: string;
  updatedAt: string;
};

export type WaccParameterInput = Omit<WaccParameter, "updatedAt">;

/** Either every term is present and WACC is computed, or the missing ones are named. */
export type WaccResolution =
  | { complete: true; parameters: WaccParameter[]; result: WaccResult }
  | { complete: false; parameters: WaccParameter[]; missing: WaccParameterName[] };

export interface WaccParameterStore {
  put(modelId: string, parameter: WaccParameterInput): void;
  list(modelId: string): WaccParameter[];
  remove(modelId: string, name: WaccParameterName): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS financial_model_wacc_parameters (
  model_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  value          REAL NOT NULL,
  source_type    TEXT NOT NULL,
  source_refs    TEXT NOT NULL,
  derivation     TEXT NOT NULL,
  as_of_date     TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (model_id, name)
);
`;

type Row = {
  name: string; value: number; source_type: string; source_refs: string;
  derivation: string; as_of_date: string; rationale: string; updated_at: string;
};

function assertKnown(name: string): asserts name is WaccParameterName {
  if (!(WACC_PARAMETER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`unknown WACC parameter: ${name}`);
  }
}

function toParameter(row: Row): WaccParameter {
  assertKnown(row.name);
  return {
    name: row.name, value: row.value,
    sourceType: row.source_type as WaccParameterSource,
    sourceRefs: JSON.parse(row.source_refs) as string[],
    derivation: JSON.parse(row.derivation) as Record<string, unknown>,
    asOfDate: row.as_of_date, rationale: row.rationale, updatedAt: row.updated_at,
  };
}

export class SqliteWaccParameterStore implements WaccParameterStore {
  private readonly db: DatabaseSync;
  private constructor(db: DatabaseSync) { this.db = db; this.db.exec(SCHEMA); }

  static open(path: string): SqliteWaccParameterStore {
    mkdirSync(dirname(path), { recursive: true });
    return new SqliteWaccParameterStore(new DatabaseSync(path));
  }

  put(modelId: string, parameter: WaccParameterInput): void {
    assertKnown(parameter.name);
    if (!Number.isFinite(parameter.value)) throw new Error(`${parameter.name} must be a finite number`);
    this.db.prepare(`INSERT INTO financial_model_wacc_parameters
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id, name) DO UPDATE SET
        value=excluded.value, source_type=excluded.source_type, source_refs=excluded.source_refs,
        derivation=excluded.derivation, as_of_date=excluded.as_of_date, rationale=excluded.rationale,
        updated_at=excluded.updated_at`)
      .run(modelId, parameter.name, parameter.value, parameter.sourceType,
        JSON.stringify(parameter.sourceRefs), JSON.stringify(parameter.derivation),
        parameter.asOfDate, parameter.rationale, new Date().toISOString());
  }

  list(modelId: string): WaccParameter[] {
    const rows = this.db.prepare(
      "SELECT name, value, source_type, source_refs, derivation, as_of_date, rationale, updated_at "
      + "FROM financial_model_wacc_parameters WHERE model_id=?").all(modelId) as unknown as Row[];
    return orderParameters(rows.map(toParameter));
  }

  remove(modelId: string, name: WaccParameterName): void {
    this.db.prepare("DELETE FROM financial_model_wacc_parameters WHERE model_id=? AND name=?").run(modelId, name);
  }

  close(): void { this.db.close(); }
}

export class InMemoryWaccParameterStore implements WaccParameterStore {
  private readonly byModel = new Map<string, Map<WaccParameterName, WaccParameter>>();

  put(modelId: string, parameter: WaccParameterInput): void {
    assertKnown(parameter.name);
    if (!Number.isFinite(parameter.value)) throw new Error(`${parameter.name} must be a finite number`);
    const parameters = this.byModel.get(modelId) ?? new Map();
    parameters.set(parameter.name, { ...structuredClone(parameter), updatedAt: new Date().toISOString() });
    this.byModel.set(modelId, parameters);
  }

  list(modelId: string): WaccParameter[] {
    return orderParameters([...(this.byModel.get(modelId)?.values() ?? [])].map((p) => structuredClone(p)));
  }

  remove(modelId: string, name: WaccParameterName): void { this.byModel.get(modelId)?.delete(name); }
}

/** Declaration order, so a reader always sees the CAPM terms before the capital structure. */
function orderParameters(parameters: readonly WaccParameter[]): WaccParameter[] {
  const rank = new Map(WACC_PARAMETER_NAMES.map((name, index) => [name, index]));
  return [...parameters].sort((left, right) => rank.get(left.name)! - rank.get(right.name)!);
}

/**
 * Reads the stored terms and computes WACC from them, or names what is still missing.
 *
 * Deliberately not a partial result: a WACC computed from four of seven terms with defaults standing
 * in for the rest looks exactly like a real one, and nothing downstream would flag it.
 */
export function resolveWacc(store: WaccParameterStore, modelId: string): WaccResolution {
  const parameters = store.list(modelId);
  const present = new Map(parameters.map((parameter) => [parameter.name, parameter.value]));
  const missing = WACC_PARAMETER_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0) return { complete: false, parameters, missing };
  const inputs = Object.fromEntries(WACC_PARAMETER_NAMES.map((name) => [name, present.get(name)!])) as WaccInputs;
  return { complete: true, parameters, result: computeWacc(inputs) };
}
