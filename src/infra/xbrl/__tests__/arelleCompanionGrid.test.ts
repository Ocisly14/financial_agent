import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { FilingTableColumn, FilingTableGridRow } from "../tableTypes.ts";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/xbrl/arelle_companion.py", import.meta.url));

type Grid = { heading: string; columns: FilingTableColumn[]; rows: FilingTableGridRow[] };

/**
 * Arelle and lxml are unavailable here, so grid expansion and heading detection
 * are exercised through the companion's debug CLI over stdlib ElementTree.
 */
function expand(html: string): Grid {
  const result = spawnSync("python3", [SCRIPT, "--expand-table"], { input: html, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Grid;
}

function textAt(row: FilingTableGridRow, columnIndex: number): string | undefined {
  return row.cells.find((cell) => cell.columnIndex === columnIndex)?.text;
}

test("colspan and rowspan expand into a matrix with comparable column indices", () => {
  const grid = expand(`<div><table>
    <tr><th rowspan="2">Line item</th><th colspan="2">Year ended</th></tr>
    <tr><th>2025</th><th>2024</th></tr>
    <tr><td>Total net sales</td><td>391,035</td><td>383,285</td></tr>
  </table></div>`);
  assert.deepEqual(grid.columns.map((column) => column.index), [0, 1, 2]);
  assert.deepEqual(grid.columns.map((column) => column.headerText), ["Line item", "Year ended 2025", "Year ended 2024"]);
  assert.deepEqual(grid.columns.map((column) => column.isLabelColumn), [true, false, false]);
  // The rowspan cell still occupies column 0 of the second header row.
  assert.equal(textAt(grid.rows[1]!, 0), "Line item");
  assert.equal(textAt(grid.rows[2]!, 2), "383,285");
});

test("untagged numeric cells are retained as text rather than dropped", () => {
  const grid = expand(`<table><tr><td>Interest expense</td><td>$</td><td>(3,933)</td><td>(3,803)</td></tr></table>`);
  assert.deepEqual(grid.rows[0]!.cells.map((cell) => cell.text), ["Interest expense", "$", "(3,933)", "(3,803)"]);
  assert.equal(grid.rows[0]!.cells.every((cell) => cell.fact === undefined), true);
});

test("ragged rows keep their own width without borrowing columns", () => {
  const grid = expand(`<table>
    <tr><td>Assets</td></tr>
    <tr><td>Cash</td><td>29,943</td><td>29,965</td></tr>
  </table>`);
  assert.equal(grid.rows[0]!.cells.length, 1);
  assert.equal(grid.rows[1]!.cells.length, 3);
});

test("a nested table does not contribute rows to its container", () => {
  const grid = expand(`<table>
    <tr><td>Outer</td><td><table><tr><td>Inner A</td></tr><tr><td>Inner B</td></tr></table></td></tr>
  </table>`);
  assert.equal(grid.rows.length, 1);
  assert.equal(grid.rows[0]!.labelText, "Outer");
});

test("indentLevel comes from inline padding and leading nbsp, never from meaning", () => {
  const grid = expand(`<table>
    <tr><td>Revenue</td><td>1,000</td></tr>
    <tr><td style="padding-left:18pt">Products</td><td>600</td></tr>
    <tr><td style="margin-left:36pt">Services</td><td>400</td></tr>
    <tr><td>&#160;&#160;&#160;&#160;Rest</td><td>10</td></tr>
  </table>`);
  assert.deepEqual(grid.rows.map((row) => row.indentLevel), [0, 2, 4, 2]);
});

test("labelText is the first cell carrying words, not the first non-empty cell", () => {
  const grid = expand(`<table><tr><td></td><td>$</td><td>Total liabilities</td><td>308,030</td></tr></table>`);
  assert.equal(grid.rows[0]!.labelText, "Total liabilities");
});

test("heading detection matches plural BALANCE SHEETS through nbsp", () => {
  // The v1 pattern could not match here: \b never fires between "sheet" and "S".
  assert.equal(expand(`<div><p>CONSOLIDATED BALANCE SHEETS</p>
    <table><tr><td>Total assets</td><td>364,980</td></tr></table></div>`).heading, "CONSOLIDATED BALANCE SHEETS");
  assert.equal(expand(`<div><p>CONSOLIDATED&#160;STATEMENTS&#160;OF&#160;CASH&#160;FLOWS</p>
    <table><tr><td>Net income</td><td>93,736</td></tr></table></div>`).heading, "CONSOLIDATED STATEMENTS OF CASH FLOWS");
  assert.equal(expand(`<div><table><caption>Segment Information</caption>
    <tr><td>Americas</td><td>167,045</td></tr></table></div>`).heading, "Segment Information");
  assert.equal(expand(`<div><p>Some unrelated prose.</p>
    <table><tr><td>Americas</td><td>167,045</td></tr></table></div>`).heading, "");
});
