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
const registrySchemaPath = join(
  repositoryRoot,
  "docs/architecture/qualification-registry.schema.json",
);

const readRegistry = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>;

test("qualification schema declares and requires every registry root field", async () => {
  const registry = await readRegistry();
  const schema = JSON.parse(
    await readFile(registrySchemaPath, "utf8"),
  ) as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  const required = schema.required as string[];
  assert.deepEqual(Object.keys(properties).toSorted(), Object.keys(registry).toSorted());
  assert.deepEqual(required.toSorted(), Object.keys(registry).toSorted());
  assert.deepEqual(properties.$schema, {
    const: "./qualification-registry.schema.json",
  });
});

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
  const targets = structuredClone(first.targets) as Record<string, unknown>[];
  targets[0] = { ...targets[0], provider: "*" };
  first.targets = targets;
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
    providerAdapter: "signed-egress-gateway-adapter",
    binaryClosure: "node-signed-egress-model-v14",
    platform: "hosted-single-host-linux-loopback",
    credentialRoute: "synthetic-signing-keys",
    storageTopology: "process-local-signed-policy-and-anchor-fixtures",
    transportTopology: "signed-egress-gateway-over-loopback-http1.1",
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

test("qualification lookup rejects fabricated PostgreSQL and OpenCode tuples", async () => {
  const registry = await readRegistry();
  const postgresqlTarget = {
    provider: "provider-neutral",
    providerAdapter: "postgresql-state-adapter",
    binaryClosure: "postgresql@18.4",
    platform: "hosted-linux-postgresql-with-linux-and-macos-clients",
    credentialRoute: "synthetic-database-role",
    storageTopology:
      "single-postgresql-18.4-docker-volume-with-same-server-dump-restore",
    transportTopology:
      "private-docker-postgresql-via-local-client-and-macos-ssh-forward-with-link-loss",
    failureDomain: "single-db-host-two-client-hosts",
  };
  assert.deepEqual(matchQualificationTarget(registry, postgresqlTarget), [
    { id: "postgresql-concurrency-recovery", qualification: "scoped" },
  ]);
  assert.deepEqual(
    matchQualificationTarget(registry, {
      ...postgresqlTarget,
      platform: "macos-client",
      transportTopology: "postgresql-client",
    }),
    [],
  );

  const openCodeTarget = {
    provider: "opencode",
    providerAdapter: "opencode-acp-v1-adapter",
    binaryClosure:
      "opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
    platform: "hosted-linux",
    credentialRoute: "none-synthetic-provider-stub",
    storageTopology: "isolated-xdg-roots-with-local-opencode-sqlite-wal",
    transportTopology:
      "acp-v1-over-stdio-to-local-openai-compatible-fault-stub",
    failureDomain: "single-host-process",
  };
  assert.deepEqual(matchQualificationTarget(registry, openCodeTarget), [
    { id: "opencode-hosting-e2e", qualification: "scoped" },
  ]);
  assert.deepEqual(
    matchQualificationTarget(registry, {
      ...openCodeTarget,
      credentialRoute: "disposable-chatgpt-oauth",
      transportTopology: "acp-v1-over-stdio-to-chatgpt-first-party-provider",
    }),
    [],
  );
});

test("qualification lookup fails closed on missing or wrong storage topology", async () => {
  const registry = await readRegistry();
  const target = {
    provider: "provider-neutral",
    providerAdapter: "postgresql-storage-recovery-adapter",
    binaryClosure: "postgresql@18.4",
    platform: "hosted-linux-loopback-ext4",
    credentialRoute: "synthetic-database-role",
    storageTopology:
      "dedicated-ext4-postgresql-18.4-volume-with-same-host-backup-restore",
    transportTopology: "local-postgresql",
    failureDomain: "single-host-storage",
  };
  const { storageTopology: _omitted, ...missingStorageTopology } = target;
  assert.throws(
    () => matchQualificationTarget(registry, missingStorageTopology),
    /target keys differ/,
  );
  assert.deepEqual(
    matchQualificationTarget(registry, {
      ...target,
      storageTopology: "fabricated-production-postgresql-cluster",
    }),
    [],
  );
});

test("qualification registry rejects duplicate and conflicting complete tuples", async () => {
  const registry = await readRegistry();
  const entries = structuredClone(registry.entries) as Record<string, unknown>[];
  const first = structuredClone(entries[0]) as Record<string, unknown>;
  const second = structuredClone(entries[1]) as Record<string, unknown>;
  second.targets = structuredClone(first.targets);
  entries[1] = second;
  registry.entries = entries;
  assert.throws(
    () => validateQualificationRegistryShape(registry),
    /registered more than once/,
  );

  second.qualification = "unqualified";
  assert.throws(
    () => validateQualificationRegistryShape(registry),
    /conflicting qualifications/,
  );
});
