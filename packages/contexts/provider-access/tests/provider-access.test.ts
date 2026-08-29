import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createContainedTurnProviderAccessFeature,
  createStaticProviderAccessBindingRepository,
  type ProviderAccessBindingRecord,
} from "../dist/composition.js";

const binding = (overrides: Partial<ProviderAccessBindingRecord> = {}): ProviderAccessBindingRecord => ({
  accessRef: "access:one",
  adapterRevision: "adapter:one",
  binaryRevision: "binary:one",
  capabilityManifestRevision: "manifest:one",
  credentialBindingDigest: "credential-digest:one",
  credentialBindingRef: "credential-binding:one",
  credentialGeneration: 1,
  projectId: "project:one",
  provider: "codex",
  providerAccountRef: "provider-account:one",
  providerRouteRef: "provider-route:one",
  revision: 1,
  status: "active",
  tenantId: "tenant:one",
  ...overrides,
});

test("resolves one exact active tenant, project, and provider binding", async () => {
  const source = binding();
  const repository = createStaticProviderAccessBindingRepository([source]);
  const feature = createContainedTurnProviderAccessFeature({ bindingRepository: repository });
  const outcome = await feature.resolve.execute({
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind !== "resolved") {return;}
  assert.equal(outcome.binding.credentialBindingRef, "credential-binding:one");
  assert.equal(outcome.binding.providerRouteRef, "provider-route:one");
  assert.ok(Object.isFrozen(outcome.binding));
  source.providerRouteRef = "mutated";
  assert.equal(outcome.binding.providerRouteRef, "provider-route:one");
});

test("does not fall back across tenant, project, provider, or revoked authority", async () => {
  const repository = createStaticProviderAccessBindingRepository([
    binding(),
    binding({ accessRef: "access:revoked", projectId: "project:revoked", status: "revoked" }),
  ]);
  const feature = createContainedTurnProviderAccessFeature({ bindingRepository: repository });
  assert.deepEqual(
    await feature.resolve.execute({ provider: "claude", scope: { projectId: "project:one", tenantId: "tenant:one" } }),
    { kind: "unavailable", reason: "not_found" },
  );
  assert.deepEqual(
    await feature.resolve.execute({ provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:other" } }),
    { kind: "unavailable", reason: "not_found" },
  );
  assert.deepEqual(
    await feature.resolve.execute({ provider: "codex", scope: { projectId: "project:revoked", tenantId: "tenant:one" } }),
    { kind: "unavailable", reason: "revoked" },
  );
});

test("rejects duplicate authority and invalid monotonic generations", () => {
  assert.throws(
    () => createStaticProviderAccessBindingRepository([binding(), binding({ accessRef: "access:duplicate" })]),
    /duplicate/u,
  );
  assert.throws(
    () => createStaticProviderAccessBindingRepository([binding({ credentialGeneration: 0 })]),
    /credentialGeneration/u,
  );
});

test("production sources do not import Agent Execution, secrets, or module runtime", async () => {
  const sources = await Promise.all([
    "../src/features/contained-turn-access/contracts/contained-turn-provider-access.ts",
    "../src/features/contained-turn-access/domain/provider-access-binding.ts",
    "../src/features/contained-turn-access/application/resolve-contained-turn-provider-access.ts",
    "../src/features/contained-turn-access/composition/feature-module-factory.ts",
  ].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /@agent-teams\/agent-execution|module[-_/ ]runtime|ModuleKit|rawCredential|secretValue/u);
  }
});
