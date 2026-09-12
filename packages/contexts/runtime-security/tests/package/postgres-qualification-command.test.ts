import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const preload = new URL("../../scripts/require-postgres-qualification.mjs", import.meta.url).href;
const probe = (databaseUrl?: string) => spawnSync(process.execPath,
  ["--import", preload, "--input-type=module", "-e", "process.stdout.write('test-runner-started')"], {
    env: databaseUrl === undefined ? {} : {RS_POSTGRES_DISPOSABLE_URL: databaseUrl},
    encoding: "utf8", timeout: 5_000,
  });

test("the mandatory RS PostgreSQL gate fails before the runner when its database is missing", () => {
  for (const value of [undefined, "", "   "]) {
    const result = probe(value);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /qualification requires RS_POSTGRES_DISPOSABLE_URL/u);
  }
});

test("an explicit database permits the runner; the actual suite owns disposable-scope validation", () => {
  const result = probe("postgresql://fixture:fixture@127.0.0.1:5434/ar69_rs_test_ci");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "test-runner-started");
  assert.equal(result.stderr, "");
});
