import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1,
} from "../dist/composition.js";

const feature = fileURLToPath(new URL("../src/features/codex-configuration-inspection/", import.meta.url));
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
// quoted one or an `import(...)` type cannot slip a forbidden dependency past a
// pattern that only recognizes one spelling.
const specifiers = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/gu)].map(match => match[1] ?? "");

test("the Codex application layer depends only on its own owned files", async () => {
  const files = await sources(join(feature, "application"));
  const owned = new Set(files.map(portable));
  for (const anchor of ["application/inspect-codex-configuration.ts", "application/models/codex-inspection-models.ts"]) {
    assert.ok(owned.has(anchor), `the application layer must still contain ${anchor}`);
  }
  for (const path of files) {
    for (const specifier of specifiers(await readFile(path, "utf8"))) {
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

test("an empty identity scope is refused before any port is touched", async () => {
  const calls = { classify: 0, digest: 0, parse: 0, read: 0 };
  const inspection = createCodexConfigurationInspectionFeature({
    digest: {
      hmacSha256Hex: () => {calls.digest += 1; return "0".repeat(64);},
      sha256Hex: () => {calls.digest += 1; return "0".repeat(64);},
    },
    parser: { parse: () => {calls.parse += 1; return { document: {}, kind: "parsed" as const };} },
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: { read: async () => {calls.read += 1; return { bytes: new Uint8Array(), kind: "read" as const };} },
  });
  const request = {
    dialect: "codex-0.134",
    identityScope: "",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: "/synthetic/config.toml", canonicalPath: "/synthetic/config.toml",
      custodyRoot: { absolutePath: "/synthetic", canonicalPath: "/synthetic" },
      displayPath: "/synthetic/config.toml", kind: "user" as const, observationEpoch: "epoch-1",
    }],
  };
  await assert.rejects(
    () => inspection.inspectCodexConfiguration.execute(request),
    (error: unknown) => error instanceof TypeError && error.message === "identityScope must not be empty",
  );
  // A degenerate identity namespace cannot produce an answer, so nothing should
  // have been read, parsed, classified or digested on the way to refusing it.
  assert.deepEqual(calls, { classify: 0, digest: 0, parse: 0, read: 0 });
});
