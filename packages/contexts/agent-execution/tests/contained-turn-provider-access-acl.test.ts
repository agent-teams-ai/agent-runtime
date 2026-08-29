import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContainedTurnProviderAccessPort } from "../dist/features/contained-agent-turn/composition/provider-access-anti-corruption.js";

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
const evidence = Object.freeze({
  authorityDigest: binding.credentialBindingDigest,
  proofRef: "binding:access:one:revision:11",
});

test("Provider Access ACL preserves owner evidence and binds the exact snapshot at acceptance and dispatch", async () => {
  let dispatchedBinding: typeof binding | undefined;
  const port = createContainedTurnProviderAccessPort({
    resolve: { async execute() { return { binding, evidence, kind: "resolved" as const }; } },
    revalidate: { async execute(input) {
      dispatchedBinding = input.binding as typeof binding;
      return { binding, evidence, kind: "valid" as const };
    } },
  });

  const accepted = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") { return; }
  assert.equal(accepted.snapshot.ownerAuthorityDigest, evidence.authorityDigest);
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
  assert.equal(current.dispatchProofId, accepted.acceptanceProofId);
});

test("Provider Access ACL maps owner rejection evidence without exposing owner reasons", async () => {
  const port = createContainedTurnProviderAccessPort({
    resolve: { async execute() { return { evidence, kind: "unavailable" as const, reason: "revoked" }; } },
    revalidate: { async execute() { return { evidence, kind: "rejected" as const, reason: "revoked" }; } },
  });
  const outcome = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.deepEqual(outcome, {
    kind: "prevented",
    preventionProofId: "proof:provider-access:binding:access:one:revision:11",
    reason: "access_denied",
  });
});

test("production exports expose one kernel authority and isolate only non-authoritative legacy adapters", async () => {
  const [composition, compatibility] = await Promise.all([
    readFile(new URL("../src/composition.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/legacy-compatibility.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(composition, /PostgresContainedTurn|ContainedTurnOperationStore|contained-turn-state/u);
  assert.doesNotMatch(compatibility, /PostgresContainedTurn|OperationStore|state-machine|authorityDigest/u);
  assert.match(composition, /createContainedTurnFeature/u);
  assert.match(composition, /createContainedTurnProviderAccessPort/u);
});
