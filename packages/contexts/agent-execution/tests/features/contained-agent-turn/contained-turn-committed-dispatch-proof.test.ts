import assert from "node:assert/strict";
import test from "node:test";

import {
  committedDispatchProofV1,
  validateCommittedDispatchProofV1,
  type CommittedDispatchProofV1Seed,
} from "../../../dist/features/contained-agent-turn/domain/committed-dispatch-proof-v1.js";
import {
  asContainedTurnCommandFingerprint,
  digestContainedTurnCanonicalValue,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";

const digest = (value: string) => digestContainedTurnCanonicalValue({ value });
const seed = Object.freeze({
  acceptedAuthorityVectorDigest: digest("authority"),
  admissionCutoffProofId: containedTurnIdentity("proof", "proof:admission-cutoff"),
  attemptId: containedTurnIdentity("attempt", "attempt:one"),
  commandFingerprint: asContainedTurnCommandFingerprint(digest("command")),
  commandId: containedTurnIdentity("command", "command:one"),
  committedOperationRevision: 7,
  custodyId: containedTurnIdentity("custody", "custody:one"),
  dispatchClaimProofId: containedTurnIdentity("proof", "proof:dispatch-claim"),
  effectId: containedTurnIdentity("effect", "effect:one"),
  executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:one"),
  hostBootId: containedTurnIdentity("host_boot", "host-boot:one"),
  hostCustodyProofId: containedTurnIdentity("proof", "proof:host-custody"),
  hostInstanceId: containedTurnIdentity("host_instance", "host-instance:one"),
  operationCutoffRevision: 3 as never,
  operationId: containedTurnIdentity("operation", "operation:one"),
  preparationToken: containedTurnIdentity("preparation", "preparation:one"),
  projectId: "project:one",
  provider: "codex" as const,
  providerAccessDispatchProofId: containedTurnIdentity("proof", "proof:provider-access"),
  providerAccessGrantReceiptDigest: digest("provider-access-receipt"),
  purpose: "contained_turn_committed_dispatch_v1" as const,
  runtimeSecurityDispatchProofId: containedTurnIdentity("proof", "proof:runtime-security"),
  runtimeSecurityGrantReceiptDigest: digest("runtime-security-receipt"),
  tenantId: "tenant:one",
  version: 1 as const,
  workspaceId: containedTurnIdentity("workspace", "workspace:one"),
}) satisfies CommittedDispatchProofV1Seed;

const alternate = Object.freeze({
  ...seed,
  acceptedAuthorityVectorDigest: digest("authority:other"),
  admissionCutoffProofId: containedTurnIdentity("proof", "proof:admission-cutoff:other"),
  attemptId: containedTurnIdentity("attempt", "attempt:other"),
  commandFingerprint: asContainedTurnCommandFingerprint(digest("command:other")),
  commandId: containedTurnIdentity("command", "command:other"),
  committedOperationRevision: 8,
  custodyId: containedTurnIdentity("custody", "custody:other"),
  dispatchClaimProofId: containedTurnIdentity("proof", "proof:dispatch-claim:other"),
  effectId: containedTurnIdentity("effect", "effect:other"),
  executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:other"),
  hostBootId: containedTurnIdentity("host_boot", "host-boot:other"),
  hostCustodyProofId: containedTurnIdentity("proof", "proof:host-custody:other"),
  hostInstanceId: containedTurnIdentity("host_instance", "host-instance:other"),
  operationCutoffRevision: 4 as never,
  operationId: containedTurnIdentity("operation", "operation:other"),
  preparationToken: containedTurnIdentity("preparation", "preparation:other"),
  projectId: "project:other",
  providerAccessDispatchProofId: containedTurnIdentity("proof", "proof:provider-access:other"),
  providerAccessGrantReceiptDigest: digest("provider-access-receipt:other"),
  runtimeSecurityDispatchProofId: containedTurnIdentity("proof", "proof:runtime-security:other"),
  runtimeSecurityGrantReceiptDigest: digest("runtime-security-receipt:other"),
  tenantId: "tenant:other",
  workspaceId: containedTurnIdentity("workspace", "workspace:other"),
}) satisfies CommittedDispatchProofV1Seed;

test("committed dispatch proof is the exact flat field-complete non-secret record", () => {
  const proof = committedDispatchProofV1(seed);
  assert.deepEqual(Object.keys(proof).toSorted(), [
    ...Object.keys(seed), "proofDigest",
  ].toSorted());
  assert.equal(Object.values(proof).every(value => value === null || typeof value !== "object"), true);
  for (const forbidden of [
    "writerFence", "intent", "prompt", "providerRoute", "credentials", "path", "body", "resolver",
    "connectionNonce", "transport", "grantReceipts", "adapterRevision", "binaryRevision", "capabilityManifestRevision",
  ]) {
    assert.equal(Object.keys(proof).some(key => key.toLowerCase().includes(forbidden.toLowerCase())), false);
  }
});

test("delete, add, or mutate every committed dispatch proof field is rejected", () => {
  const proof = committedDispatchProofV1(seed);
  for (const key of Object.keys(proof)) {
    const deleted = { ...proof } as Record<string, unknown>;
    delete deleted[key];
    assert.throws(() => validateCommittedDispatchProofV1(deleted), { name: "ContainedTurnInvariantError" });

    const mutatedValue = key === "proofDigest" ? digest("wrong-proof")
      : key === "purpose" ? "contained_turn_provider_start_v1"
        : key === "version" ? 2 : key === "provider" ? "claude"
          : alternate[key as keyof typeof alternate];
    const mutated = { ...proof, [key]: mutatedValue };
    assert.throws(() => validateCommittedDispatchProofV1(mutated));
  }
  assert.throws(() => validateCommittedDispatchProofV1({ ...proof, extra: true }), { name: "ContainedTurnInvariantError" });
});

test("proof domain, namespaces, digest canonical form, and revisions are collision-safe", () => {
  for (const malformed of [
    { ...seed, purpose: "contained_turn_provider_start_v1" },
    { ...seed, version: 2 },
    { ...seed, attemptId: containedTurnIdentity("custody", "custody:wrong-namespace") },
    { ...seed, acceptedAuthorityVectorDigest: `sha256:${"A".repeat(64)}` },
    { ...seed, providerAccessGrantReceiptDigest: `sha256:${"a".repeat(63)}` },
    { ...seed, committedOperationRevision: -0 },
    { ...seed, operationCutoffRevision: -0 },
    { ...seed, committedOperationRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...seed, operationCutoffRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => committedDispatchProofV1(malformed as never));
  }
});

test("proof records reject prototypes, accessors, Proxy exotica, cycles, sparse arrays, and aliases", () => {
  const proof = committedDispatchProofV1(seed);
  assert.throws(() => validateCommittedDispatchProofV1(Object.assign(Object.create(null), proof)));
  const accessor = { ...proof };
  Object.defineProperty(accessor, "tenantId", { enumerable: true, get: () => "tenant:trap" });
  assert.throws(() => validateCommittedDispatchProofV1(accessor));
  assert.throws(() => validateCommittedDispatchProofV1(new Proxy(proof, {
    ownKeys: () => {throw new TypeError("proxy trap");},
  })));
  const cycle: Record<string, unknown> = { ...proof }; cycle.extra = cycle;
  assert.throws(() => validateCommittedDispatchProofV1(cycle));
  const sparse = Array(2); sparse[1] = proof;
  assert.throws(() => validateCommittedDispatchProofV1(sparse));
  const alias = Object.freeze({ value: "shared" });
  assert.throws(() => validateCommittedDispatchProofV1({ ...proof, first: alias, second: alias }));
});
