import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderConfigClassificationError,
  splitProviderConfig,
  type CredentialFieldRule,
} from "../src/features/profile-secrets/split-provider-config.ts";

const rules: readonly CredentialFieldRule[] = [
  { path: ["providers", "*", "apiKey"], kind: "api-key" },
  {
    path: ["mcp", "*", "environment", "GITHUB_TOKEN"],
    kind: "token",
  },
];

test("provider ACL removes secret values from profile artifacts", () => {
  const seenSecrets: string[] = [];
  const result = splitProviderConfig(
    {
      model: "provider/model",
      providers: {
        custom: { baseURL: "https://example.test", apiKey: "secret-api-key" },
      },
      mcp: {
        github: {
          command: ["github-mcp"],
          environment: { GITHUB_TOKEN: "secret-mcp-token", MODE: "read-only" },
        },
      },
    },
    rules,
    ({ path, secret }) => {
      seenSecrets.push(secret);
      return `credential:${path}`;
    },
  );

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret-api-key|secret-mcp-token/);
  assert.equal(result.credentialRequirements.length, 2);
  assert.deepEqual(seenSecrets, ["secret-api-key", "secret-mcp-token"]);
});

test("unknown secret-shaped fields fail closed", () => {
  assert.throws(
    () =>
      splitProviderConfig(
        { plugin: { unexplainedSecret: "value" } },
        rules,
        () => "unreachable",
      ),
    (error: unknown) =>
      error instanceof ProviderConfigClassificationError &&
      error.code === "UNCLASSIFIED_SECRET",
  );
});

test("embedded credentials fail even in preference fields", () => {
  assert.throws(
    () =>
      splitProviderConfig(
        { endpoint: "https://user:password@example.test/api" },
        rules,
        () => "unreachable",
      ),
    (error: unknown) =>
      error instanceof ProviderConfigClassificationError &&
      error.code === "INLINE_SECRET",
  );
});
