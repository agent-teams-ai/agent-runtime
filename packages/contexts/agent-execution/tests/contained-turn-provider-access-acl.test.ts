import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContainedTurnProviderAccessPort } from "../dist/features/contained-agent-turn/composition/provider-access-anti-corruption.js";
import { createContainedTurnProviderAccessFeature } from "../../provider-access/dist/features/contained-turn-access/composition/feature-module-factory.js";

const scope = Object.freeze({ projectId: "project:kernel", tenantId: "tenant:kernel" });
const binding = Object.freeze({
  accessRef: "access:one",
  credentialBindingDigest: "owner-issued-opaque-digest",
  credentialBindingRef: "credential-binding:one",
  credentialGeneration: 7,
  projectId: scope.projectId,
  provider: "codex" as const,
  providerAccountRef: "provider-account:one",
  providerRouteRef: "provider-route:one",
  revision: 11,
  tenantId: scope.tenantId,
});
const evidence = (purpose: "acceptance" | "dispatch") => Object.freeze({
  authorityDigest: `signed-canonical:${purpose}:${binding.credentialBindingDigest}`,
  bindingAuthorityDigest: binding.credentialBindingDigest,
  proofRef: `binding:access:one:revision:11:purpose:${purpose}`,
  purpose,
});

test("Provider Access ACL preserves owner evidence and binds the exact snapshot at acceptance and dispatch", async () => {
  let dispatchedBinding: typeof binding | undefined;
  const port = createContainedTurnProviderAccessPort({
    resolve: { async execute() { return { binding, evidence: evidence("acceptance"), kind: "resolved" as const }; } },
    revalidate: { async execute(input) {
      dispatchedBinding = input.binding as typeof binding;
      return { binding, evidence: evidence("dispatch"), kind: "valid" as const };
    } },
  });

  const accepted = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") { return; }
  assert.equal(accepted.snapshot.ownerAuthorityDigest, binding.credentialBindingDigest);
  assert.match(accepted.snapshot.credentialBindingDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(accepted.snapshot.credentialBindingDigest, binding.credentialBindingDigest);

  const current = await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:one",
    scope,
  });
  assert.equal(current.kind, "current");
  if (current.kind !== "current") { return; }
  assert.equal(dispatchedBinding?.credentialBindingDigest, binding.credentialBindingDigest);
  assert.deepEqual(current.snapshot, accepted.snapshot);
  assert.notEqual(current.dispatchResolutionDigest, accepted.acceptanceResolutionDigest);
  assert.notEqual(current.dispatchProofId, accepted.acceptanceProofId);
  assert.match(accepted.acceptanceProofId, /:acceptance:/u);
  assert.match(current.dispatchProofId, /:dispatch:/u);
});

test("Provider Access ACL maps owner rejection evidence without exposing owner reasons", async () => {
  const port = createContainedTurnProviderAccessPort({
    resolve: { async execute() { return { evidence: evidence("acceptance"), kind: "unavailable" as const, reason: "revoked" }; } },
    revalidate: { async execute() { return { evidence: evidence("dispatch"), kind: "rejected" as const, reason: "revoked" }; } },
  });
  const outcome = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.equal(outcome.kind, "prevented");
  if (outcome.kind === "prevented") {
    assert.match(outcome.preventionProofId, /^proof:provider-access:acceptance:sha256:[0-9a-f]{64}$/u);
    assert.equal(outcome.reason, "access_denied");
  }
});

test("real Provider Access revalidation accepts unchanged evidence and fails closed on drift, revocation, and scope mismatch", async () => {
  const record = {
    ...binding,
    availability: "available" as const,
    revocation: "active" as const,
  };
  let currentRecord = record;
  const feature = createContainedTurnProviderAccessFeature({
    bindingRepository: {
      async observeExact() { return { kind: "found" as const, record: currentRecord }; },
    },
  });
  const port = createContainedTurnProviderAccessPort(feature);
  const accepted = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") { return; }

  const unchanged = await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:unchanged",
    scope,
  });
  assert.equal(unchanged.kind, "current");
  if (unchanged.kind === "current") {
    assert.notEqual(unchanged.dispatchProofId, accepted.acceptanceProofId);
  }

  currentRecord = { ...record, providerRouteRef: "provider-route:drifted" };
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:drift",
    scope,
  })).kind, "current");

  currentRecord = { ...record, revocation: "revoked" };
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:revoked",
    scope,
  })).kind, "current");

  currentRecord = record;
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:scope-mismatch",
    scope: { projectId: "project:other", tenantId: scope.tenantId },
  })).kind, "current");
});

test("production exports expose one kernel authority and isolate only non-authoritative legacy adapters", async () => {
  const [composition, manifest, dispatch] = await Promise.all([
    readFile(new URL("../src/composition.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src/features/contained-agent-turn/application/contained-turn-dispatch.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(composition, /PostgresContainedTurn|ContainedTurnOperationStore|contained-turn-state/u);
  assert.doesNotMatch(manifest, /legacy-compatibility/u);
  assert.doesNotMatch(dispatch, /LegacyClaim|legacy-claim|claimDispatch\(/u);
  assert.match(composition, /createContainedTurnFeature/u);
  assert.match(composition, /createContainedTurnProviderAccessPort/u);
});
