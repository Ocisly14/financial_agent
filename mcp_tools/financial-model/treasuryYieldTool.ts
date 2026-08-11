import type { JsonSchema, ToolExecutionResult } from "../../src/framework/types.ts";
import { fetchTreasuryYield, TREASURY_TERMS, type TreasuryTerm } from "../../src/infra/market/treasuryYield.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { validate } from "./schemas.ts";

export const TREASURY_YIELD_TOOL = "get_treasury_yield";

const INPUT_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["term"],
  properties: {
    term: { type: "string", enum: [...TREASURY_TERMS], description: "Tenor on the daily par yield curve, e.g. \"10Y\" or \"30Y\"." },
    asOfDate: { type: "string", description: "YYYY-MM-DD; defaults to today. Resolves to the latest published point on or before this date." },
  },
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetches the official U.S. Treasury daily par yield curve at any tenor, from treasury.gov's own
 * feed. The WACC sheet auto-fills risk_free_rate from the 30-year point as of the model's own
 * as-of date; this tool lets the agent inspect the curve at another tenor, or pull a fresh value to
 * override that auto-filled row with set_wacc_input.
 */
export function createTreasuryYieldTool(fetchImpl?: typeof fetch): RegisteredTool {
  return {
    name: TREASURY_YIELD_TOOL,
    description: "Fetch the official U.S. Treasury daily par yield curve at a given tenor (treasury.gov's own feed) — the risk-free anchor for WACC. Use it to inspect the curve at any term, or to pull a value at a different tenor than the auto-filled 30Y and set it via set_wacc_input.",
    category: "non_trading",
    inputSchema: INPUT_SCHEMA,
    async execute(input): Promise<ToolExecutionResult> {
      try { validate(input, INPUT_SCHEMA, "$", true); }
      catch (error) { return failure("invalid_tool_input", message(error)); }

      const term = input["term"] as TreasuryTerm;
      const asOfDate = typeof input["asOfDate"] === "string" ? input["asOfDate"] : today();

      const result = await fetchTreasuryYield(term, asOfDate, fetchImpl);
      if (!result) {
        return failure("treasury_yield_unavailable", `Could not fetch the ${term} Treasury yield as of ${asOfDate} from treasury.gov.`);
      }

      const percent = (result.value * 100).toFixed(2);
      return {
        summary: `${term} Treasury yield ${percent}% as of ${result.curveDate} (treasury.gov)`,
        generation_context: { data: { term, value: result.value, curve_date: result.curveDate, source: "treasury.gov daily yield curve" } },
      };
    },
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function failure(code: string, message: string): ToolExecutionResult {
  return { summary: message, error: { code, message }, generation_context: { data: { error: code } } };
}
