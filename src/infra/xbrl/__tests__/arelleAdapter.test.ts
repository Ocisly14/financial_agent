import assert from "node:assert/strict";
import test from "node:test";
import { ArelleAdapterError, createArelleProcessRunner } from "../arelleAdapter.ts";

const REQUEST = { protocolVersion: 2 as const, filings: [], periods: [] };

test("unconfigured Arelle runtime fails explicitly without falling back", async () => {
  const runner = createArelleProcessRunner({ command: "" });
  await assert.rejects(runner(REQUEST), (error) => error instanceof ArelleAdapterError && error.code === "xbrl_runtime_unavailable");
});

test("bounded adapter accepts one strict protocol response from a fake process", async () => {
  const runner = createArelleProcessRunner({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({protocolVersion:2,filings:[],diagnostics:[]})))"],
    timeoutMs: 2_000,
  });
  assert.deepEqual(await runner(REQUEST), { protocolVersion: 2, filings: [], diagnostics: [] });
});

test("malformed companion output is a protocol error", async () => {
  const runner = createArelleProcessRunner({ command: process.execPath, args: ["-e", "console.log('{}')"] });
  await assert.rejects(runner(REQUEST), (error) => error instanceof ArelleAdapterError && error.code === "xbrl_protocol_error");
});

test("structured companion failures preserve the explicit runtime error code", async () => {
  const runner = createArelleProcessRunner({ command: process.execPath, args: ["-e",
    "process.stderr.write(JSON.stringify({code:'xbrl_runtime_unavailable',message:'Arelle missing'})+'\\n');process.exit(69)"] });
  await assert.rejects(runner(REQUEST), (error) => error instanceof ArelleAdapterError
    && error.code === "xbrl_runtime_unavailable" && error.message === "Arelle missing");
});

function emitting(response: unknown): ReturnType<typeof createArelleProcessRunner> {
  return createArelleProcessRunner({ command: process.execPath, timeoutMs: 2_000, args: ["-e",
    `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(response))}))`] });
}

const FILING = { accession: "a", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
  primaryDocumentUrl: "https://example.test/a.htm" };
const TABLE = { sourceTableId: "a:html-table:1", accession: "a", form: "10-K", filedAt: "2026-02-01",
  reportDate: "2025-12-31", heading: "", htmlOrder: 1, sourceAnchor: "https://example.test/a.htm#table=1",
  prescreen: { tier: "strong", presentationOverlap: 1, dimensionlessRatio: 1, periodSpan: 1, factCount: 1 },
  suggestedStatements: [], columns: [], rows: [] };

test("a protocol v1 response is rejected outright", async () => {
  const runner = emitting({ protocolVersion: 1, filings: [], diagnostics: [] });
  await assert.rejects(runner(REQUEST), (error) => error instanceof ArelleAdapterError
    && error.code === "xbrl_protocol_error" && error.message.includes("version 2"));
});

test("a v2 filing carrying grids and calculation relations round-trips", async () => {
  const response = { protocolVersion: 2, diagnostics: [], filings: [{ filing: FILING,
    tables: [TABLE], calculationRelations: [{ roleUri: "r", parentConcept: "us-gaap:Assets", children: [] }],
    negatedConcepts: [], diagnostics: [] }] };
  assert.deepEqual(await emitting(response)(REQUEST), response);
});

test("a grid missing its columns or prescreen is a protocol error", async () => {
  const runner = emitting({ protocolVersion: 2, diagnostics: [], filings: [{ filing: FILING,
    tables: [{ ...TABLE, columns: undefined }], calculationRelations: [], negatedConcepts: [], diagnostics: [] }] });
  await assert.rejects(runner(REQUEST), (error) => error instanceof ArelleAdapterError
    && error.message.includes("filing table grid"));
});
