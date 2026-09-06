import assert from "node:assert/strict";
import test from "node:test";
import { validateDisposablePostgresUrl } from "./postgres-materialization-url.fixtures.ts";

test("disposable PostgreSQL validation rejects target overrides before constructing a driver", () => {
  const base = "postgresql://fixture:fixture@127.0.0.1:5433/ar69_pa_test_ci";
  for (const suffix of ["?host=192.0.2.1", "?host=%2Ftmp", "?hostaddr=192.0.2.1", "?port=5432",
    "?dbname=real", "?service=ambient", "?sslmode=disable", "#fragment"]) {
    assert.throws(() => validateDisposablePostgresUrl(base + suffix));
  }
  assert.throws(() => validateDisposablePostgresUrl(base.replace("127.0.0.1", "192.0.2.1")));
  assert.throws(() => validateDisposablePostgresUrl(base.replace("ar69_pa_test_ci", "real")));
  assert.equal(validateDisposablePostgresUrl(base), base);
});
