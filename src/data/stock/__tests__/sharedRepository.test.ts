import test from "node:test";
import assert from "node:assert/strict";
import { getSharedBarRepository, resetSharedBarRepository } from "../sharedRepository.ts";

/** mkdirSync inside SqliteBarStore.open cannot create a directory under /dev/null. */
const UNOPENABLE = "/dev/null/nope/stock.db";

function withPath(path: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env["STOCK_DB_PATH"];
  process.env["STOCK_DB_PATH"] = path;
  return run().finally(() => {
    if (previous === undefined) delete process.env["STOCK_DB_PATH"];
    else process.env["STOCK_DB_PATH"] = previous;
  });
}

test("a transient open failure does not disable the store for the rest of the process", async () => {
  resetSharedBarRepository();
  await withPath(UNOPENABLE, async () => {
    assert.equal(await getSharedBarRepository(), undefined);
    assert.equal(await getSharedBarRepository(), undefined);
  });

  await withPath(":memory:", async () => {
    assert.notEqual(await getSharedBarRepository(), undefined);
  });
  resetSharedBarRepository();
});

test("the store gives up after three failed opens and stops retrying", async () => {
  resetSharedBarRepository();
  await withPath(UNOPENABLE, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(await getSharedBarRepository(), undefined);
    }
  });

  await withPath(":memory:", async () => {
    assert.equal(await getSharedBarRepository(), undefined);
  });
  resetSharedBarRepository();
});
