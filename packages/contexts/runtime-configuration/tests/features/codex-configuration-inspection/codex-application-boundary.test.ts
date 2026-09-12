import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1,
} from "../../../dist/composition.js";
import { createInspectCodexConfiguration } from "../../../dist/features/codex-configuration-inspection/application/inspect-codex-configuration.js";

const feature = fileURLToPath(new URL("../../../src/features/codex-configuration-inspection/", import.meta.url));
const portable = (path: string): string => relative(feature, path).split(sep).join("/");

const sources = async (directory: string): Promise<string[]> => {
  const collected: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {collected.push(...await sources(path));}
    else if (entry.name.endsWith(".ts")) {collected.push(path);}
  }
  return collected;
};

// Every specifier form the language offers, so a multi-line import, a single
// or double quoted one, a backtick literal, a require() and an `import(...)`
// type cannot slip a forbidden dependency past a pattern that only
// recognizes one spelling.
const specifiers = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/gu)].map(match => match[1] ?? "");

// A specifier that is not a string literal (a computed require/import target,
// or a `typeof import(...)` built from a non-literal expression) cannot be
// resolved by the pattern above at all, so it must be refused on sight rather
// than silently passed.
const nonLiteralLoads = (source: string): number =>
  [...source.matchAll(/\b(?:import|require)\s*\(\s*[^"'`)]/gu)].length;

test("the Codex application layer depends only on its own owned files", async () => {
  const files = await sources(join(feature, "application"));
  const owned = new Set(files.map(portable));
  for (const anchor of ["application/inspect-codex-configuration.ts", "application/models/codex-inspection-models.ts"]) {
    assert.ok(owned.has(anchor), `the application layer must still contain ${anchor}`);
  }
  for (const path of files) {
    const source = await readFile(path, "utf8");
    // A load whose target is not a string/template literal cannot be checked
    // by the allowlist below at all, so it fails closed instead of passing by
    // omission.
    assert.equal(nonLiteralLoads(source), 0, `${portable(path)} must not load a non-literal specifier`);
    for (const specifier of specifiers(source)) {
      // An allowlist rather than a denylist: the layer may only reach its own
      // relative files. That rejects a transport contract, a Node builtin, a
      // sibling production module and any third-party package in one rule.
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("../"),
        `${portable(path)} must not depend on ${specifier}`,
      );
      for (const forbidden of ["contracts/", "adapters/", "composition/"]) {
        assert.ok(
          !specifier.includes(forbidden),
          `${portable(path)} must not reach into ${forbidden} (${specifier})`,
        );
      }
    }
  }
});

test("only the inbound adapter translates between the contract and the application models", async () => {
  const adapters = await sources(join(feature, "adapters"));
  const contractConsumers = [];
  for (const path of adapters) {
    if (specifiers(await readFile(path, "utf8")).some(specifier => specifier.includes("contracts/"))) {
      contractConsumers.push(portable(path));
    }
  }
  assert.deepEqual(contractConsumers, ["adapters/inbound/codex-configuration-inspection-v1.ts"]);
});

// Wraps the real V1 classifier instead of standing in a bare stub, so a
// `calls.classify` of 0 means the classifier was genuinely never reached, not
// merely that a stub happened to record nothing.
const observedClassifier = (calls: { classify: number }) => {
  const real = createCodexConfigurationSemanticClassifierV1();
  return {
    ...real,
    classify: (...args: Parameters<typeof real.classify>) => {
      calls.classify += 1;
      return real.classify(...args);
    },
    supportsDialect: (...args: Parameters<typeof real.supportsDialect>) => {
      calls.classify += 1;
      return real.supportsDialect(...args);
    },
  };
};

const emptyScopeRequest = {
  dialect: "codex-0.134",
  identityScope: "",
  observationEpoch: "epoch-1",
  sources: [{
    absolutePath: "/synthetic/config.toml", canonicalPath: "/synthetic/config.toml",
    custodyRoot: { absolutePath: "/synthetic", canonicalPath: "/synthetic" },
    displayPath: "/synthetic/config.toml", kind: "user" as const, observationEpoch: "epoch-1",
  }],
};

const isEmptyScopeError = (error: unknown): boolean =>
  error instanceof TypeError && error.message === "identityScope must not be empty";

test("an empty identity scope is refused before any port is touched", async () => {
  const calls = { classify: 0, digest: 0, parse: 0, read: 0 };
  const inspection = createCodexConfigurationInspectionFeature({
    digest: {
      hmacSha256Hex: () => {calls.digest += 1; return "0".repeat(64);},
      sha256Hex: () => {calls.digest += 1; return "0".repeat(64);},
    },
    parser: { parse: () => {calls.parse += 1; return { document: {}, kind: "parsed" as const };} },
    semanticClassifier: observedClassifier(calls),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: { read: async () => {calls.read += 1; return { bytes: new Uint8Array(), kind: "read" as const };} },
  });
  await assert.rejects(
    () => inspection.inspectCodexConfiguration.execute(emptyScopeRequest),
    isEmptyScopeError,
  );
  // A degenerate identity namespace cannot produce an answer, so nothing should
  // have been read, parsed, classified or digested on the way to refusing it.
  assert.deepEqual(calls, { classify: 0, digest: 0, parse: 0, read: 0 });
});

// The feature-level test above goes through the inbound adapter, which repeats
// the same check at the transport edge; that alone does not prove the use case
// enforces the invariant itself. Call the use case directly, with no adapter in
// front of it, so removing the check from `executeInspection` would fail here
// even though the adapter's own copy still passes every other test.
test("the use case itself refuses an empty identity scope before any port is touched, with no adapter in front of it", async () => {
  const calls = { classify: 0, digest: 0, parse: 0, read: 0 };
  const useCase = createInspectCodexConfiguration({
    digest: {
      hmacSha256Hex: () => {calls.digest += 1; return "0".repeat(64);},
      sha256Hex: () => {calls.digest += 1; return "0".repeat(64);},
    },
    parser: { parse: () => {calls.parse += 1; return { document: {}, kind: "parsed" as const };} },
    semanticClassifier: observedClassifier(calls),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: { read: async () => {calls.read += 1; return { bytes: new Uint8Array(), kind: "read" as const };} },
  });
  await assert.rejects(() => useCase.execute(emptyScopeRequest), isEmptyScopeError);
  assert.deepEqual(calls, { classify: 0, digest: 0, parse: 0, read: 0 });
});
