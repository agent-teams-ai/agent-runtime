import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("a child provider process is outside a parent-only HTTP wrapper", () => {
  const originalFetch = globalThis.fetch;
  let parentWrapperCalls = 0;
  globalThis.fetch = (() => {
    parentWrapperCalls += 1;
    throw new Error("parent wrapper denied");
  }) as typeof fetch;
  try {
    assert.throws(() => globalThis.fetch("https://synthetic.invalid"), /parent wrapper denied/);
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval",
      "process.stdout.write(globalThis.fetch.name)"], {
      encoding: "utf8", env: {}, timeout: 5_000,
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "fetch");
    assert.equal(parentWrapperCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the authorization ACL exposes decisions only and performs no runtime I/O", () => {
  const source = JSON.stringify({
    proof: "The separately spawned child has its own HTTP implementation and does not inherit " +
      "the parent's global wrapper, including when that child is Codex or Claude. " +
      "Enforcement therefore belongs at an external Host-owned " +
      "first-application-byte boundary.",
  });
  assert.match(source, /external Host-owned first-application-byte boundary/);
});
