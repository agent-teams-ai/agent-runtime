import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoKnownSecret,
  redactText,
} from "../src/features/redaction/redact.ts";

test("redacts roots and common credential forms", () => {
  const secret = "sk-test-secret-value";
  const source = [
    "/home/worker/.claude/config",
    `api_key=${secret}`,
    `Authorization: Bearer ${secret}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    "account@example.com",
  ].join("\n");

  const redacted = redactText(source, {
    roots: { HOME: "/home/worker" },
    literalSecrets: [secret],
  });

  assert.match(redacted, /<HOME>\/\.claude\/config/);
  assert.doesNotMatch(redacted, /sk-test-secret-value/);
  assert.doesNotMatch(redacted, /eyJhbGci/);
  assert.doesNotMatch(redacted, /account@example\.com/);
  assertNoKnownSecret(redacted, [secret]);
});

test("rejects evidence that still contains a known secret", () => {
  assert.throws(
    () => {
      assertNoKnownSecret("leaked-value", ["leaked-value"]);
    },
    {
      message: "Redaction failed: a known secret remains in evidence",
    },
  );
});
