import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContainedTurnProviderAccessPort } from "../dist/features/contained-agent-turn/composition/provider-access-anti-corruption.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  containedTurnDispatchGrantRequestId,
} from "../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";

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

test("Provider Access ambiguous consumption and settlement share the owner-known request key", async () => {
  const subject = Object.freeze({
    attemptId: containedTurnIdentity("attempt", "attempt:provider-access-correlation"),
    custodyId: containedTurnIdentity("custody", "custody:provider-access-correlation"),
    effectId: containedTurnIdentity("effect", "effect:provider-access-correlation"),
    executionGenerationId: containedTurnIdentity(
      "execution_generation", "execution-generation:provider-access-correlation",
    ),
    hostBootId: containedTurnIdentity("host_boot", "host-boot:provider-access-correlation"),
    hostInstanceId: containedTurnIdentity(
      "host_instance", "host-instance:provider-access-correlation",
    ),
    operationCutoffRevision: 0,
    operationId: containedTurnIdentity("operation", "operation:provider-access-correlation"),
    preparationToken: containedTurnIdentity(
      "preparation", "preparation:provider-access-correlation",
    ),
    purpose: "contained_turn_provider_start_v1" as const,
    scopeDigest: digestContainedTurnCanonicalValue({ scope }),
    workspaceId: containedTurnIdentity("workspace", "workspace:provider-access-correlation"),
  });
  const grantRequestId = containedTurnDispatchGrantRequestId("provider_access", subject);
  const ownerRequests: string[] = [];
  const port = createContainedTurnProviderAccessPort({
    consumeDispatchGrant: { async execute(input) {
      ownerRequests.push(input.grantRequestId);
      return { evidenceRef: "pa-17", kind: "indeterminate" as const };
    } },
    resolve: { async execute() {throw new Error("unused resolve");} },
    revalidate: { async execute() {throw new Error("unused revalidate");} },
    settleDispatchGrant: { async execute(input) {
      ownerRequests.push(input.grantRequestId);
      return { kind: "settled" as const };
    } },
  });

  const ambiguous = await port.consumeForDispatch({ grantRequestId, subject });
  assert.equal(ambiguous.kind, "indeterminate");
  if (ambiguous.kind === "indeterminate") {
    assert.notEqual(ambiguous.evidenceId, "pa-17");
    assert.match(ambiguous.evidenceId, /^evidence:provider-access:grant:sha256:[0-9a-f]{64}$/u);
  }
  const permitDigest = digestContainedTurnCanonicalValue({ grantRequestId, purpose: "cleanup" });
  assert.deepEqual(await port.settleConsumedGrant({
    cleanupPermit: {
      attemptId: subject.attemptId,
      custodyId: subject.custodyId,
      operationCutoffRevision: subject.operationCutoffRevision,
      operationId: subject.operationId,
      permitDigest,
      permitId: containedTurnIdentity("cleanup_permit", `cleanup-permit:${permitDigest}`),
      preparationToken: subject.preparationToken,
      preparedOperationRevision: 1,
      workspaceId: subject.workspaceId,
    },
    grantRequestId,
  }), { kind: "settled" });
  assert.deepEqual(ownerRequests, [grantRequestId, grantRequestId]);
});

test("production exports expose one kernel authority and isolate only non-authoritative legacy adapters", async () => {
  const [publicIndex, composition, manifest, dispatch] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/composition.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src/features/contained-agent-turn/application/contained-turn-dispatch.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(publicIndex, /PostgresContainedTurn|ContainedTurnOperationStore|contained-turn-state/u);
  assert.doesNotMatch(manifest, /legacy-compatibility/u);
  assert.doesNotMatch(dispatch, /LegacyClaim|legacy-claim|claimDispatch\(/u);
  assert.match(composition, /createContainedTurnFeature/u);
  assert.match(composition, /createContainedTurnProviderAccessPort/u);
});
