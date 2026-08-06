import { spawn } from "node:child_process";
import type { ArelleExtractionRequest, ArelleExtractionResponse } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class ArelleAdapterError extends Error {
  readonly code: "xbrl_runtime_unavailable" | "xbrl_timeout" | "xbrl_protocol_error" | "xbrl_process_failed";
  constructor(code: ArelleAdapterError["code"], message: string) {
    super(message);
    this.name = "ArelleAdapterError";
    this.code = code;
  }
}

export type ArelleRunner = (request: ArelleExtractionRequest) => Promise<ArelleExtractionResponse>;

/**
 * Bounded JSON-lines adapter. The companion process reads one protocol object
 * from stdin and emits exactly one protocol object on stdout. Network access,
 * filing downloads, and Arelle all remain outside the financial-model core.
 */
export function createArelleProcessRunner(options: {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
} = {}): ArelleRunner {
  const command = options.command ?? process.env["ARELLE_ADAPTER_COMMAND"];
  const args = options.args ?? parseArgs(process.env["ARELLE_ADAPTER_ARGS"]);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return async (request) => {
    if (!command) {
      throw new ArelleAdapterError(
        "xbrl_runtime_unavailable",
        "ARELLE_ADAPTER_COMMAND is not configured; install/configure the filing-level Arelle companion runtime",
      );
    }
    return await new Promise<ArelleExtractionResponse>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, response?: ArelleExtractionResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(response!);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new ArelleAdapterError("xbrl_timeout", `Arelle adapter exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (error) => finish(new ArelleAdapterError(
        error.message.includes("ENOENT") ? "xbrl_runtime_unavailable" : "xbrl_process_failed",
        `Arelle adapter could not start: ${error.message}`,
      )));
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          child.kill("SIGKILL");
          finish(new ArelleAdapterError("xbrl_protocol_error", "Arelle adapter output exceeded the configured byte limit"));
        } else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.reduce((sum, entry) => sum + entry.length, 0) < 32_768) stderr.push(chunk);
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
          const structured = companionError(diagnostic);
          return finish(new ArelleAdapterError(structured?.code ?? "xbrl_process_failed",
            structured?.message ?? `Arelle adapter exited ${String(code)}: ${diagnostic}`));
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as ArelleExtractionResponse;
          validateResponse(parsed);
          finish(undefined, parsed);
        } catch (error) {
          finish(error instanceof ArelleAdapterError ? error : new ArelleAdapterError("xbrl_protocol_error", `Invalid adapter JSON: ${String(error)}`));
        }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  };
}

function companionError(stderr: string): { code: ArelleAdapterError["code"]; message: string } | undefined {
  for (const line of stderr.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as { code?: unknown; message?: unknown };
      if ((parsed.code === "xbrl_runtime_unavailable" || parsed.code === "xbrl_timeout"
          || parsed.code === "xbrl_protocol_error" || parsed.code === "xbrl_process_failed")
        && typeof parsed.message === "string") {
        return { code: parsed.code, message: parsed.message };
      }
    } catch { /* non-structured diagnostics remain part of process_failed */ }
  }
  return undefined;
}

function validateResponse(value: ArelleExtractionResponse): void {
  if (!value || value.protocolVersion !== 2 || !Array.isArray(value.filings) || !Array.isArray(value.diagnostics)) {
    throw new ArelleAdapterError("xbrl_protocol_error", "Arelle adapter response does not match protocol version 2");
  }
  for (const filing of value.filings) {
    if (!filing?.filing?.accession || !Array.isArray(filing.tables)
      || !Array.isArray(filing.calculationRelations) || !Array.isArray(filing.negatedConcepts)
      || !Array.isArray(filing.diagnostics)) {
      throw new ArelleAdapterError("xbrl_protocol_error", "Arelle adapter returned a malformed filing");
    }
    for (const table of filing.tables) {
      // A grid without columns is unusable downstream: columnIndex is the only
      // thing making cells comparable across rows.
      if (!table.sourceTableId || !Array.isArray(table.columns) || !Array.isArray(table.rows)
        || typeof table.prescreen?.factCount !== "number" || !Array.isArray(table.suggestedStatements)) {
        throw new ArelleAdapterError("xbrl_protocol_error", "Arelle adapter returned a malformed filing table grid");
      }
    }
    for (const relation of filing.calculationRelations) {
      if (!relation.roleUri || !relation.parentConcept || !Array.isArray(relation.children)) {
        throw new ArelleAdapterError("xbrl_protocol_error", "Arelle adapter returned a malformed calculation relation");
      }
    }
  }
}

function parseArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed;
  } catch { /* handled below */ }
  throw new ArelleAdapterError("xbrl_protocol_error", "ARELLE_ADAPTER_ARGS must be a JSON string array");
}
