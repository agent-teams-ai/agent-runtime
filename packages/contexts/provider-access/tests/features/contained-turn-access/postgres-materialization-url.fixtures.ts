import assert from "node:assert/strict";

export const validateDisposablePostgresUrl = (value: string): string => {
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.search, "", "Connection target overrides are forbidden");
  assert.equal(url.hash, "", "Connection fragments are forbidden");
  assert.match(url.pathname, /^\/ar69_pa_test_[a-z0-9]+$/u);
  return url.href;
};
