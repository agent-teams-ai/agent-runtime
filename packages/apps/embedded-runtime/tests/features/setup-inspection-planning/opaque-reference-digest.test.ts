import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { createNodeOpaqueReferenceDigest } from "../../../dist/composition/opaque-reference-digest.js";

test("matches the direct HMAC-SHA256 hex digest for the same key and material", () => {
  const digest = createNodeOpaqueReferenceDigest();
  const key = new Uint8Array(32).fill(9);
  const material = JSON.stringify(["claude-code-setup-source", "scope", "epoch", "identity"]);
  const expected = createHmac("sha256", key).update(material).digest("hex");
  assert.equal(digest.hex(key, material), expected);
  assert.match(digest.hex(key, material), /^[a-f0-9]{64}$/u);
});

test("is deterministic for the same key and material, and diverges on either input", () => {
  const digest = createNodeOpaqueReferenceDigest();
  const keyA = new Uint8Array(32).fill(1);
  const keyB = new Uint8Array(32).fill(2);
  const materialA = "material-a";
  const materialB = "material-b";
  assert.equal(digest.hex(keyA, materialA), digest.hex(keyA, materialA));
  assert.notEqual(digest.hex(keyA, materialA), digest.hex(keyB, materialA));
  assert.notEqual(digest.hex(keyA, materialA), digest.hex(keyA, materialB));
});

test("returns a frozen adapter with no ambient state between instances", () => {
  const first = createNodeOpaqueReferenceDigest();
  const second = createNodeOpaqueReferenceDigest();
  assert.ok(Object.isFrozen(first));
  assert.notEqual(first, second);
  const key = new Uint8Array(32).fill(4);
  assert.equal(first.hex(key, "same"), second.hex(key, "same"));
});
