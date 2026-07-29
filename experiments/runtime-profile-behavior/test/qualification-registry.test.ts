import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  matchQualificationTarget,
  validateQualificationRegistry,
  validateQualificationRegistryShape,
} from "../src/features/evidence/validate-qualification-registry.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const registryPath = join(
  repositoryRoot,
  "docs/architecture/qualification-registry.json",
);

const readRegistry = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>;

test("qualification registry pins every promoted evidence row", async () => {
  const result = await validateQualificationRegistry(repositoryRoot);
  assert.deepEqual(result, {
    entryCount: 30,
    evidenceArtifactCount: 57,
    traceabilityRowCount: 30,
  });
});

test("qualification registry rejects wildcard target dimensions", async () => {
  const registry = await readRegistry();
  const entries = structuredClone(registry.entries) as Record<string, unknown>[];
  const first = structuredClone(entries[0]) as Record<string, unknown>;
  const dimensions = structuredClone(first.dimensions) as Record<string, unknown>;
  dimensions.provider = ["*"];
  first.dimensions = dimensions;
  entries[0] = first;
  registry.entries = entries;

  assert.throws(
    () => validateQualificationRegistryShape(registry),
    /forbidden wildcard token/,
  );
});

test("qualification registry rejects unknown fields", async () => {
  const registry = await readRegistry();
  const entries = structuredClone(registry.entries) as Record<string, unknown>[];
  const first = structuredClone(entries[0]) as Record<string, unknown>;
  first.assumeCompatible = true;
  entries[0] = first;
  registry.entries = entries;

  assert.throws(
    () => validateQualificationRegistryShape(registry),
    /keys differ/,
  );
});

test("qualification lookup defaults an unlisted target to unqualified", async () => {
  const registry = await readRegistry();
  const exactTarget = {
    provider: "provider-neutral",
    binaryClosure: "node-signed-egress-model-v14",
    platform: "hosted-single-host-linux-loopback",
    credentialRoute: "synthetic-signing-keys",
    transport: "http1-loopback",
    failureDomain: "single-host-transport",
  };
  assert.deepEqual(matchQualificationTarget(registry, exactTarget), [
    {
      id: "stage-m-egress-policy",
      qualification: "scoped",
    },
  ]);
  assert.deepEqual(
    matchQualificationTarget(registry, {
      ...exactTarget,
      platform: "production-multi-host-linux",
    }),
    [],
  );
});
