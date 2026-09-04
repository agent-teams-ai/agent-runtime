import assert from "node:assert/strict";
import test from "node:test";

import { claimContainedTurnWithConsumedGrants } from "../../../dist/features/contained-agent-turn/application/contained-turn-grant-claim.js";
import { retireAndCleanupContainedTurnPreparation } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { createContainedTurnPreparationScopeDependencies } from "../../../dist/features/contained-agent-turn/composition/preparation-scope-anti-corruption.js";
import { containedTurnProviderAccessSnapshotDigest, containedTurnScopeDigest } from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { completeContainedTurnDispatchGrantSubject } from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import {
  CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT,
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
  type ContainedTurnDispatchPreparation,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { committedDispatchProofV1 } from "../../../dist/features/contained-agent-turn/domain/committed-dispatch-proof-v1.js";
import type { ContainedTurnKernelOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  attemptId,
  createOperation,
  createReservedOperation,
  custodyId,
  effectId,
  executionGenerationId,
  hostBootId,
  hostInstanceId,
  operationId,
  preparationToken,
  scope,
  workspaceId,
} from "../../contained-turn-kernel-fixtures.ts";
import { committedDispatchProofForClaim } from "./support/committed-dispatch-proof-fixture.ts";

const initial = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
const subject = completeContainedTurnDispatchGrantSubject(Object.freeze({
  attemptId,
  custodyId,
  effectId,
  executionGenerationId,
  hostBootId,
  hostInstanceId,
  operationCutoffRevision: initial.operationCutoff.revision,
  operationId,
  preparationToken,
  purpose: "contained_turn_provider_start_v1" as const,
  provider: "codex" as const,
  providerAccessExpectation: Object.freeze({
    acceptedAuthorityDigest: initial.acceptedAuthorityVectorDigest,
    accessRef: initial.providerAccessSnapshot.accessRef,
    authorityHeadDigest: initial.providerAccessSnapshot.ownerAuthorityDigest,
    bindingDigest: containedTurnProviderAccessSnapshotDigest(initial.providerAccessSnapshot),
    bindingRevision: initial.providerAccessSnapshot.revision,
    credentialBindingDigest: initial.providerAccessSnapshot.credentialBindingDigest,
    credentialBindingRef: initial.providerAccessSnapshot.credentialBindingRef,
    credentialGeneration: initial.providerAccessSnapshot.credentialGeneration,
    providerAccountRef: initial.providerAccessSnapshot.providerAccountRef,
    providerRouteRef: initial.providerAccessSnapshot.providerRouteRef,
  }),
  runtimeSecurityExpectation: Object.freeze({
    acceptedAuthorityDigest: initial.acceptedAuthorityVectorDigest,
    authorityGeneration: initial.acceptedAuthorityVector.operationAuthorityRevision,
    authorityHeadDigest: initial.acceptedAuthorityVector.securityDecisionDigest,
    authorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision,
    constraintsDigest: digestContainedTurnCanonicalValue({ constraints: "scope-sanitization" }),
    containmentPolicyDigest: initial.acceptedAuthorityVector.containmentPolicyDigest,
    providerBindingDigest: containedTurnProviderAccessSnapshotDigest(initial.providerAccessSnapshot),
    providerId: "codex",
  }),
  scope,
  scopeDigest: containedTurnScopeDigest(scope),
  workspaceId,
}));
const hostCustodyProof = Object.freeze({
  binding: Object.freeze({
    attemptId,
    authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
    custodyId,
    effectId,
    operationId,
  }),
  kind: "host_custody" as const,
  proofId: containedTurnIdentity("proof", "proof:scope-sanitization-host-custody"),
});

const consumedReceipt = (owner: "provider_access" | "runtime_security") => {
  const request = owner === "provider_access" ? subject.providerAccessRequest : subject.runtimeSecurityRequest;
  const grantRequestDigest = request.grantRequestId.slice("grant-request:".length);
  return Object.freeze({
    authorityFacts: owner === "provider_access" ? subject.providerAccessExpectation : subject.runtimeSecurityExpectation,
    claimBeforeControlTime: 100,
    claimBindingDigest: request.claimBindingDigest,
    consumedAtControlTime: 50,
    consumptionDigest: digestContainedTurnCanonicalValue({ owner, state: "consumed" }),
    grantRequestDigest,
    grantRequestId: request.grantRequestId,
    operationId,
    owner,
    ownerEvidenceRef: `scope-sanitization:${owner}`,
    provider: "codex" as const,
    purpose: "contained-turn.provider-dispatch/v1" as const,
    requestDigest: request.requestDigest,
    scope: Object.freeze({ ...scope, scopeDigest: containedTurnScopeDigest(scope) }),
    validThroughOperationCutoffRevision: initial.operationCutoff.revision,
  });
};
const committedReceipts = Object.freeze([
  consumedReceipt("provider_access"), consumedReceipt("runtime_security"),
]) as never;
const winnerSeed = createReservedOperation();
if (winnerSeed.dispatch.kind !== "claimed") {throw new TypeError("winner fixture must be claimed");}
const winner = Object.freeze({
  ...winnerSeed,
  dispatch: Object.freeze({ ...winnerSeed.dispatch, grantReceipts: committedReceipts }),
  proofs: Object.freeze(winnerSeed.proofs.map(proof => proof.kind === "provider_access_dispatch"
    ? Object.freeze({ ...proof, binding: Object.freeze({
      ...proof.binding, resolutionDigest: digestContainedTurnCanonicalValue(committedReceipts[0] as never),
    }) })
    : proof.kind === "runtime_security_dispatch"
      ? Object.freeze({ ...proof, binding: Object.freeze({
        ...proof.binding, currentSecurityDecisionDigest: digestContainedTurnCanonicalValue(committedReceipts[1] as never),
      }) })
      : proof.kind === "host_custody" ? hostCustodyProof : proof)),
});
const committedDispatchProof = committedDispatchProofForClaim(
  winner, subject, hostCustodyProof, committedReceipts,
);

const unavailableAfterConsumed = Object.freeze({
  consumedGrantReceipts: Object.freeze({
    providerAccess: consumedReceipt("provider_access"),
    runtimeSecurity: consumedReceipt("runtime_security"),
  }),
  consumedGrantRequestIds: Object.freeze({
    providerAccessConsumptionReceipt: consumedReceipt("provider_access"),
    providerAccessGrantRequestId: consumedReceipt("provider_access").grantRequestId,
    runtimeSecurityConsumptionReceipt: consumedReceipt("runtime_security"),
    runtimeSecurityGrantRequestId: consumedReceipt("runtime_security").grantRequestId,
  }),
  consumptionEvidenceIds: Object.freeze({}),
  kind: "unavailable" as const,
});

const unavailablePreparationDependency = async (): Promise<never> => {
  throw new Error("unused mandatory preparation dependency");
};

const canonicalDependencies = (
  dependencies: Partial<ContainedTurnKernelDependencies>,
): ContainedTurnKernelDependencies => {
  return createContainedTurnPreparationScopeDependencies(Object.freeze({
    operationStore: Object.freeze({
      claimPreparedDispatch: unavailablePreparationDependency,
      recordDispatchPreparationCleanup: unavailablePreparationDependency,
      retireDispatchPreparation: unavailablePreparationDependency,
      ...dependencies.operationStore,
    }),
    security: Object.freeze({ consumeForDispatch: unavailablePreparationDependency, settleConsumedGrant: async () => ({ kind: "settled" as const }), ...dependencies.security }),
    providerAccess: Object.freeze({ consumeForDispatch: unavailablePreparationDependency, settleConsumedGrant: async () => ({ kind: "settled" as const }), ...dependencies.providerAccess }),
    workspace: Object.freeze({ ensureClosed: unavailablePreparationDependency, queryClosure: unavailablePreparationDependency, ...dependencies.workspace }),
    artifacts: Object.freeze({ ensureSealed: unavailablePreparationDependency, querySeal: unavailablePreparationDependency, ...dependencies.artifacts }),
    custody: Object.freeze({
      attestContainment: unavailablePreparationDependency,
      ensurePhysicalContainment: unavailablePreparationDependency,
      queryContainmentAttestation: unavailablePreparationDependency,
      queryPhysicalContainment: unavailablePreparationDependency,
      releaseRetiredReservation: unavailablePreparationDependency,
      ...dependencies.custody,
    }),
    provider: Object.freeze({ ...dependencies.provider }),
  }) as unknown as ContainedTurnKernelDependencies);
};

const claimDependencies = (
  outcome: Awaited<ReturnType<NonNullable<ContainedTurnKernelDependencies["operationStore"]["claimPreparedDispatch"]>>>,
): ContainedTurnKernelDependencies => canonicalDependencies({
  operationStore: { claimPreparedDispatch: async () => outcome },
  providerAccess: {
    consumeForDispatch: async () => ({ kind: "consumed", receipt: consumedReceipt("provider_access") }),
  },
  security: {
    consumeForDispatch: async () => ({ kind: "consumed", receipt: consumedReceipt("runtime_security") }),
  },
});

const foreignOperationMutations: readonly ((operation: ContainedTurnKernelOperation) => ContainedTurnKernelOperation)[] = [
  operation => ({ ...operation, scope: { ...operation.scope, tenantId: "tenant:foreign" } }),
  operation => ({ ...operation, scope: { ...operation.scope, projectId: "project:foreign" } }),
  operation => ({ ...operation, operationId: containedTurnIdentity("operation", "operation:foreign") }),
  operation => ({ ...operation, commandId: containedTurnIdentity("command", "command:foreign") }),
  operation => ({ ...operation, effectId: containedTurnIdentity("effect", "effect:foreign") }),
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, preparationToken: containedTurnIdentity("preparation", "preparation:foreign") } }
    : operation,
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, attemptId: containedTurnIdentity("attempt", "attempt:foreign") } }
    : operation,
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:foreign") } }
    : operation,
  operation => operation.dispatch.kind === "claimed"
    ? { ...operation, dispatch: { ...operation.dispatch, operationCutoffRevision: 1 } }
    : operation,
  operation => ({ ...operation, custodyId: containedTurnIdentity("custody", "custody:foreign") }),
  operation => ({ ...operation, hostBootId: containedTurnIdentity("host_boot", "host-boot:foreign") }),
  operation => ({ ...operation, hostInstanceId: containedTurnIdentity("host_instance", "host-instance:foreign") }),
  operation => ({ ...operation, workspaceId: containedTurnIdentity("workspace", "workspace:foreign") }),
];

test("prepared claim claimed, observed, and stale outcomes collapse foreign owner aggregates", async () => {
  for (const mutate of foreignOperationMutations) {
    const foreign = { ...mutate(winner), foreignAggregate: "must-not-leak" } as ContainedTurnKernelOperation;
    for (const outcome of [
      { committedDispatchProof, kind: "claimed" as const, operation: foreign },
      { kind: "observed_claim" as const, operation: foreign },
      { current: foreign, kind: "stale" as const },
    ]) {
      const result = await claimContainedTurnWithConsumedGrants(
        claimDependencies(outcome), initial, scope, subject, hostCustodyProof,
      );
      assert.deepEqual(result, unavailableAfterConsumed);
      assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
    }
  }
});

test("prepared claim rejects same-owner extras and returns only a detached frozen Kernel projection", async () => {
  const withExtra = { ...winner, foreignAggregate: "must-not-leak" } as ContainedTurnKernelOperation;
  const rejected = await claimContainedTurnWithConsumedGrants(
    claimDependencies({ committedDispatchProof, kind: "claimed", operation: withExtra }),
    initial, scope, subject, hostCustodyProof,
  );
  assert.deepEqual(rejected, unavailableAfterConsumed);

  const accepted = await claimContainedTurnWithConsumedGrants(
    claimDependencies({ committedDispatchProof, kind: "claimed", operation: winner }),
    initial, scope, subject, hostCustodyProof,
  );
  assert.equal(accepted.kind, "claimed");
  if (accepted.kind === "claimed") {
    assert.notStrictEqual(accepted.operation, winner);
    assert.deepEqual(accepted.operation, winner);
    assert.equal(Object.isFrozen(accepted), true);
    assert.equal(Object.isFrozen(accepted.operation), true);
  }
});

test("valid-looking committed proof substitutions cannot cross the detached operation owner", async () => {
  const { proofDigest: _proofDigest, ...proofSeed } = committedDispatchProof;
  const substitutions = Object.freeze({
    acceptedAuthorityVectorDigest: digestContainedTurnCanonicalValue({ authority: "foreign" }),
    admissionCutoffProofId: containedTurnIdentity("proof", "proof:foreign-cutoff"),
    attemptId: containedTurnIdentity("attempt", "attempt:foreign"),
    commandFingerprint: digestContainedTurnCanonicalValue({ command: "foreign" }) as never,
    commandId: containedTurnIdentity("command", "command:foreign"),
    committedOperationRevision: committedDispatchProof.committedOperationRevision + 1,
    custodyId: containedTurnIdentity("custody", "custody:foreign"),
    dispatchClaimProofId: containedTurnIdentity("proof", "proof:foreign-claim"),
    effectId: containedTurnIdentity("effect", "effect:foreign"),
    executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:foreign"),
    hostBootId: containedTurnIdentity("host_boot", "host-boot:foreign-proof"),
    hostCustodyProofId: containedTurnIdentity("proof", "proof:foreign-host-custody"),
    hostInstanceId: containedTurnIdentity("host_instance", "host-instance:foreign-proof"),
    operationCutoffRevision: (committedDispatchProof.operationCutoffRevision + 1) as never,
    operationId: containedTurnIdentity("operation", "operation:foreign-proof"),
    preparationToken: containedTurnIdentity("preparation", "preparation:foreign"),
    projectId: "project:foreign-proof",
    provider: "claude" as const,
    providerAccessDispatchProofId: containedTurnIdentity("proof", "proof:foreign-provider-access"),
    providerAccessGrantReceiptDigest: digestContainedTurnCanonicalValue({ receipt: "foreign-provider-access" }),
    runtimeSecurityDispatchProofId: containedTurnIdentity("proof", "proof:foreign-runtime-security"),
    runtimeSecurityGrantReceiptDigest: digestContainedTurnCanonicalValue({ receipt: "foreign-runtime-security" }),
    tenantId: "tenant:foreign-proof",
    workspaceId: containedTurnIdentity("workspace", "workspace:foreign-proof"),
  });
  for (const [field, value] of Object.entries(substitutions)) {
    const substituted = committedDispatchProofV1({ ...proofSeed, [field]: value } as never);
    const outcome = await claimContainedTurnWithConsumedGrants(
      claimDependencies({ committedDispatchProof: substituted, kind: "claimed", operation: winner }),
      initial, scope, subject, hostCustodyProof,
    );
    assert.deepEqual(outcome, unavailableAfterConsumed, field);
  }
});

test("prepared claim rejects proxies, accessors, sparse or augmented arrays without invoking hostile code", async () => {
  let traps = 0;
  let thenGets = 0;
  let getters = 0;
  const proxiedDispatch = new Proxy({ ...winner.dispatch }, {
    getOwnPropertyDescriptor: () => {traps += 1; throw new TypeError("trap must not run");},
    ownKeys: () => {traps += 1; throw new TypeError("trap must not run");},
  });
  const accessorOperation = structuredClone(winner);
  Object.defineProperty(accessorOperation, "revision", {
    enumerable: true,
    get: () => {getters += 1; return winner.revision;},
  });
  const augmentedProofs = [...winner.proofs] as ContainedTurnKernelOperation["proofs"] & { extra?: string };
  augmentedProofs.extra = "must-not-leak";
  const sparseProofs = [...winner.proofs];
  delete sparseProofs[0];
  const operations = [
    { ...winner, dispatch: proxiedDispatch },
    accessorOperation,
    { ...winner, proofs: augmentedProofs },
    { ...winner, proofs: sparseProofs },
  ] as ContainedTurnKernelOperation[];
  for (const operation of operations) {
    const result = await claimContainedTurnWithConsumedGrants(
      claimDependencies({ kind: "observed_claim", operation }), initial, scope, subject,
      hostCustodyProof,
    );
    assert.deepEqual(result, unavailableAfterConsumed);
  }
  const proxiedOutcome = new Proxy({ kind: "observed_claim" as const, operation: winner }, {
    get: (_target, key) => {
      if (key === "then") {thenGets += 1; return;}
      traps += 1;
      throw new TypeError(`unexpected hostile get ${String(key)}`);
    },
    ownKeys: () => {traps += 1; throw new TypeError("outcome trap must not run");},
  });
  const hostileClaim = (() => proxiedOutcome) as unknown as
    ContainedTurnKernelDependencies["operationStore"]["claimPreparedDispatch"];
  assert.deepEqual(
    await claimContainedTurnWithConsumedGrants(canonicalDependencies({
      operationStore: { claimPreparedDispatch: hostileClaim },
      providerAccess: {
        consumeForDispatch: async () => ({ kind: "consumed", receipt: consumedReceipt("provider_access") }),
      },
      security: {
        consumeForDispatch: async () => ({ kind: "consumed", receipt: consumedReceipt("runtime_security") }),
      },
    }), initial, scope, subject, hostCustodyProof),
    unavailableAfterConsumed,
  );
  assert.equal(thenGets, 0, "the trusted outer adapter rejects before Promise assimilation");
  assert.equal(traps, 0);
  assert.equal(getters, 0);
});

test("prepared claim snapshots mutable aliases and rejects owner outcome extras", async () => {
  const mutableWinner = structuredClone(winner);
  const accepted = await claimContainedTurnWithConsumedGrants(
    claimDependencies({ kind: "observed_claim", operation: mutableWinner }), initial, scope, subject,
    hostCustodyProof,
  );
  assert.equal(accepted.kind, "observed_claim");
  if (accepted.kind === "observed_claim") {
    mutableWinner.scope.tenantId = "tenant:mutated-after-return";
    assert.equal(accepted.operation.scope.tenantId, scope.tenantId);
    assert.notStrictEqual(accepted.operation.scope, mutableWinner.scope);
    assert.equal(Object.isFrozen(accepted.operation.scope), true);
  }
  const outcomeWithExtra = {
    kind: "observed_claim" as const,
    operation: winner,
    rawOwnerPayload: "must-not-leak",
  };
  assert.deepEqual(
    await claimContainedTurnWithConsumedGrants(
      claimDependencies(outcomeWithExtra), initial, scope, subject, hostCustodyProof,
    ),
    unavailableAfterConsumed,
  );
});

test("preparation dependencies are one-time snapshots in frozen plain facades", async () => {
  let originalReads = 0;
  let mutatedReads = 0;
  let callableGetterInvocations = 0;
  const operationStore = {
    claimPreparedDispatch: unavailablePreparationDependency,
    read: async () => {originalReads += 1; return;},
    recordDispatchPreparationCleanup: unavailablePreparationDependency,
    retireDispatchPreparation: unavailablePreparationDependency,
  };
  const raw = {
    operationStore,
    security: { consumeForDispatch: unavailablePreparationDependency, settleConsumedGrant: unavailablePreparationDependency },
    providerAccess: { consumeForDispatch: unavailablePreparationDependency, settleConsumedGrant: unavailablePreparationDependency },
    workspace: { ensureClosed: unavailablePreparationDependency, queryClosure: unavailablePreparationDependency },
    artifacts: { ensureSealed: unavailablePreparationDependency, querySeal: unavailablePreparationDependency },
    custody: {
      attestContainment: unavailablePreparationDependency,
      ensurePhysicalContainment: unavailablePreparationDependency,
      queryContainmentAttestation: unavailablePreparationDependency,
      queryPhysicalContainment: unavailablePreparationDependency,
      releaseRetiredReservation: unavailablePreparationDependency,
    },
    provider: {},
  };
  const snapshot = createContainedTurnPreparationScopeDependencies(raw as unknown as ContainedTurnKernelDependencies);
  operationStore.read = async () => {mutatedReads += 1; return winner;};
  raw.operationStore = { ...operationStore };
  await snapshot.operationStore.read({ operationId, scope });
  assert.equal(originalReads, 1);
  assert.equal(mutatedReads, 0);
  for (const port of Object.values(snapshot)) {
    assert.equal(Object.getPrototypeOf(port), Object.prototype);
    assert.equal(Object.isFrozen(port), true);
  }
  assert.equal(Object.isFrozen(snapshot.operationStore.read), true);
  assert.equal(Object.isFrozen(snapshot), true);

  const accessorStore = { ...operationStore };
  Object.defineProperty(accessorStore, "read", {
    enumerable: true,
    get: () => {callableGetterInvocations += 1; return operationStore.read;},
  });
  assert.throws(
    () => createContainedTurnPreparationScopeDependencies({ ...raw, operationStore: accessorStore } as unknown as ContainedTurnKernelDependencies),
    /must be a data property or method/u,
  );
  assert.equal(callableGetterInvocations, 0);

  let hostileThenGets = 0;
  const hostileThenable = {};
  // oxlint-disable-next-line unicorn/no-thenable -- proves rejection before assimilation.
  Object.defineProperty(hostileThenable, "then", {
    get: () => {hostileThenGets += 1; throw new Error("hostile then getter must not run");},
  });
  const hostileBoundary = createContainedTurnPreparationScopeDependencies({
    ...raw,
    operationStore: {
      ...operationStore,
      claimPreparedDispatch: (() => hostileThenable) as unknown as ContainedTurnKernelDependencies["operationStore"]["claimPreparedDispatch"],
    },
  } as unknown as ContainedTurnKernelDependencies);
  await assert.rejects(
    hostileBoundary.operationStore.claimPreparedDispatch({} as never),
    /native Promise, not a thenable or aggregate/u,
  );
  assert.equal(hostileThenGets, 0);
});

test("preparation dependency snapshot rejects every traversed Proxy without get or apply traps", () => {
  const operationStore = {
    claimPreparedDispatch: unavailablePreparationDependency,
    read: async () => {return;},
    recordDispatchPreparationCleanup: unavailablePreparationDependency,
    retireDispatchPreparation: unavailablePreparationDependency,
  };
  const dependencies = (store: object): ContainedTurnKernelDependencies => ({
    operationStore: store,
    security: { consumeForDispatch: unavailablePreparationDependency, settleConsumedGrant: unavailablePreparationDependency },
    providerAccess: { consumeForDispatch: unavailablePreparationDependency, settleConsumedGrant: unavailablePreparationDependency },
    workspace: { ensureClosed: unavailablePreparationDependency, queryClosure: unavailablePreparationDependency },
    artifacts: { ensureSealed: unavailablePreparationDependency, querySeal: unavailablePreparationDependency },
    custody: {
      attestContainment: unavailablePreparationDependency,
      ensurePhysicalContainment: unavailablePreparationDependency,
      queryContainmentAttestation: unavailablePreparationDependency,
      queryPhysicalContainment: unavailablePreparationDependency,
      releaseRetiredReservation: unavailablePreparationDependency,
    },
    provider: {},
  }) as unknown as ContainedTurnKernelDependencies;

  let topLevelGets = 0;
  let topLevelReflections = 0;
  const topLevelProxy = new Proxy(operationStore, {
    get: () => {topLevelGets += 1; throw new Error("top-level get trap must not run");},
    getOwnPropertyDescriptor: () => {topLevelReflections += 1; throw new Error("top-level descriptor trap must not run");},
    ownKeys: () => {topLevelReflections += 1; throw new Error("top-level ownKeys trap must not run");},
  });
  assert.throws(
    () => createContainedTurnPreparationScopeDependencies(dependencies(topLevelProxy)),
    /boundary port must not be a Proxy/u,
  );
  assert.deepEqual([topLevelGets, topLevelReflections], [0, 0]);

  let prototypeGets = 0;
  let prototypeReflections = 0;
  const prototypeProxy = new Proxy({}, {
    get: () => {prototypeGets += 1; throw new Error("prototype get trap must not run");},
    getOwnPropertyDescriptor: () => {prototypeReflections += 1; throw new Error("prototype descriptor trap must not run");},
    ownKeys: () => {prototypeReflections += 1; throw new Error("prototype ownKeys trap must not run");},
  });
  const inheritedStore = Object.assign(Object.create(prototypeProxy) as object, operationStore);
  assert.throws(
    () => createContainedTurnPreparationScopeDependencies(dependencies(inheritedStore)),
    /boundary port prototype must not be a Proxy/u,
  );
  assert.deepEqual([prototypeGets, prototypeReflections], [0, 0]);

  let callableApplies = 0;
  const callableProxy = new Proxy(operationStore.read, {
    apply: () => {callableApplies += 1; throw new Error("callable apply trap must not run");},
  });
  assert.throws(
    () => createContainedTurnPreparationScopeDependencies(dependencies({ ...operationStore, read: callableProxy })),
    /callable must not be a Proxy/u,
  );
  assert.equal(callableApplies, 0);

  let permissiveGets = 0;
  let permissiveApplies = 0;
  const getThenApplyProxy = new Proxy(operationStore.read, {
    apply: () => {permissiveApplies += 1; throw new Error("permissive callable apply trap must not run");},
    get: (target, key, receiver) => {
      permissiveGets += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(
    () => createContainedTurnPreparationScopeDependencies(dependencies({
      ...operationStore,
      read: getThenApplyProxy,
    })),
    /callable must not be a Proxy/u,
  );
  assert.deepEqual([permissiveGets, permissiveApplies], [0, 0]);
});

const activePreparation = Object.freeze({
  attemptId,
  custodyId,
  kind: "active" as const,
  operationCutoffRevision: initial.operationCutoff.revision,
  operationId,
  preparationToken,
  preparedOperationRevision: initial.revision,
  providerAccessConsumptionReceipt: consumedReceipt("provider_access"),
  providerAccessGrantRequestId: consumedReceipt("provider_access").grantRequestId,
  runtimeSecurityConsumptionReceipt: consumedReceipt("runtime_security"),
  runtimeSecurityGrantRequestId: consumedReceipt("runtime_security").grantRequestId,
  workspaceId,
});
const retiredPreparation = retireContainedTurnDispatchPreparation(activePreparation, "retirement:scope-sanitization");
if (retiredPreparation.kind !== "cleanup_pending") {throw new TypeError("fixture retirement failed");}

const cleanupDependencies = (input: Readonly<{
  custodyRelease?: ContainedTurnKernelDependencies["custody"]["releaseRetiredReservation"];
  providerSettle?: ContainedTurnKernelDependencies["providerAccess"]["settleConsumedGrant"];
  record?: (target: "custody" | "provider_access" | "runtime_security") => ContainedTurnDispatchPreparation;
  retirement: Awaited<ReturnType<NonNullable<ContainedTurnKernelDependencies["operationStore"]["retireDispatchPreparation"]>>>;
  securitySettle?: ContainedTurnKernelDependencies["security"]["settleConsumedGrant"];
}>): ContainedTurnKernelDependencies => canonicalDependencies({
  custody: { releaseRetiredReservation: input.custodyRelease ?? (async () => ({ kind: "released" })) },
  operationStore: {
    recordDispatchPreparationCleanup: async ({ target }) => input.record?.(target) ?? retiredPreparation,
    retireDispatchPreparation: async () => input.retirement,
  },
  providerAccess: { settleConsumedGrant: input.providerSettle ?? (async () => ({ kind: "settled" })) },
  security: { settleConsumedGrant: input.securitySettle ?? (async () => ({ kind: "settled" })) },
});

test("retirement claimed and stale outcomes never adopt foreign operation or preparation owners", async () => {
  for (const mutate of foreignOperationMutations) {
    const foreign = { ...mutate(winner), foreignAggregate: "must-not-leak" } as ContainedTurnKernelOperation;
    const claimed = await retireAndCleanupContainedTurnPreparation(
      cleanupDependencies({ retirement: { kind: "claimed", operation: foreign } }),
      initial, scope, subject, "reconciliation",
    );
    assert.deepEqual(claimed, { kind: "cleanup_pending", operation: initial });

    const stale = await retireAndCleanupContainedTurnPreparation(
      cleanupDependencies({ retirement: { current: foreign, kind: "stale" } }),
      initial, scope, subject, "reconciliation",
    );
    assert.deepEqual(stale, { kind: "cleanup_pending", operation: initial });
    assert.equal(JSON.stringify([claimed, stale]).includes("must-not-leak"), false);
  }

  const foreignPreparation = {
    ...retiredPreparation,
    operationId: containedTurnIdentity("operation", "operation:foreign-preparation"),
    foreignAggregate: "must-not-leak",
  } as ContainedTurnDispatchPreparation;
  const retired = await retireAndCleanupContainedTurnPreparation(
    cleanupDependencies({ retirement: { kind: "retired", preparation: foreignPreparation as typeof retiredPreparation } }),
    initial, scope, subject, "reconciliation",
  );
  assert.deepEqual(retired, { kind: "cleanup_pending", operation: initial });
});

test("cleanup record outcomes adopt only exact preparation and permit owner identities", async () => {
  const foreignPreparation = {
    ...retiredPreparation,
    providerAccessGrantRequestId: "provider-access-grant:foreign",
    foreignAggregate: "must-not-leak",
  } as ContainedTurnDispatchPreparation;
  const rejected = await retireAndCleanupContainedTurnPreparation(
    cleanupDependencies({
      record: () => foreignPreparation,
      retirement: { kind: "retired", preparation: retiredPreparation },
    }),
    initial, scope, subject, "reconciliation",
  );
  assert.equal(rejected.kind, "cleanup_pending");
  assert.notStrictEqual(rejected.preparation, retiredPreparation);
  assert.deepEqual(rejected.preparation, retiredPreparation);
  assert.equal(JSON.stringify(rejected).includes("must-not-leak"), false);

  let current: ContainedTurnDispatchPreparation = retiredPreparation;
  const closed = await retireAndCleanupContainedTurnPreparation(
    cleanupDependencies({
      record: target => {
        current = recordContainedTurnPreparationCleanup(current, {
          permit: retiredPreparation.cleanupPermit,
          target,
        });
        return current;
      },
      retirement: { kind: "retired", preparation: retiredPreparation },
    }),
    initial, scope, subject, "reconciliation",
  );
  assert.equal(closed.kind, "cleanup_closed");
  if (closed.kind === "cleanup_closed") {
    assert.notStrictEqual(closed.preparation, current);
    assert.deepEqual(closed.preparation, current);
    assert.equal(Object.isFrozen(closed.preparation), true);
  }
});

test("cleanup permits reject extras, forged digest or ID, accessors, proxies, and cross-owner substitution", async () => {
  const attempts: ContainedTurnDispatchPreparation[] = [
    {
      ...retiredPreparation,
      cleanupPermit: { ...retiredPreparation.cleanupPermit, extra: "same-owner-extra" },
    } as ContainedTurnDispatchPreparation,
    {
      ...retiredPreparation,
      cleanupPermit: {
        ...retiredPreparation.cleanupPermit,
        permitDigest: digestContainedTurnCanonicalValue({ forged: "digest" }),
      },
    } as ContainedTurnDispatchPreparation,
    {
      ...retiredPreparation,
      cleanupPermit: {
        ...retiredPreparation.cleanupPermit,
        permitId: containedTurnIdentity("cleanup_permit", "cleanup-permit:forged"),
      },
    } as ContainedTurnDispatchPreparation,
    {
      ...retiredPreparation,
      cleanupPermit: {
        ...retiredPreparation.cleanupPermit,
        operationId: containedTurnIdentity("operation", "operation:foreign-permit-owner"),
      },
    } as ContainedTurnDispatchPreparation,
  ];
  const accessorPermit = { ...retiredPreparation.cleanupPermit };
  Object.defineProperty(accessorPermit, "permitDigest", {
    enumerable: true,
    get: () => retiredPreparation.cleanupPermit.permitDigest,
  });
  attempts.push({ ...retiredPreparation, cleanupPermit: accessorPermit } as ContainedTurnDispatchPreparation);
  attempts.push({
    ...retiredPreparation,
    cleanupPermit: new Proxy({ ...retiredPreparation.cleanupPermit }, {}),
  } as ContainedTurnDispatchPreparation);
  const augmentedEvidenceIds = [...retiredPreparation.cleanupEvidenceIds] as string[] & { extra?: string };
  augmentedEvidenceIds.extra = "must-not-leak";
  attempts.push({ ...retiredPreparation, cleanupEvidenceIds: augmentedEvidenceIds });
  const sparseEvidenceIds = ["evidence:scope-sanitization"];
  delete sparseEvidenceIds[0];
  attempts.push({ ...retiredPreparation, cleanupEvidenceIds: sparseEvidenceIds });
  let oversizedEvidenceReads = 0;
  const oversizedEvidenceIds = Array.from(
    { length: CONTAINED_TURN_PREPARATION_CLEANUP_EVIDENCE_LIMIT + 1 },
    (_unused, index) => `evidence:oversized-scope-sanitization:${String(index)}`,
  );
  Object.defineProperty(oversizedEvidenceIds, 0, {
    enumerable: true,
    get: () => {
      oversizedEvidenceReads += 1;
      return "evidence:oversized-scope-sanitization:0";
    },
  });
  attempts.push({ ...retiredPreparation, cleanupEvidenceIds: oversizedEvidenceIds });

  for (const preparation of attempts) {
    let calls = 0;
    const dependencies = cleanupDependencies({
      custodyRelease: async () => {calls += 1; return { kind: "released" };},
      providerSettle: async () => {calls += 1; return { kind: "settled" };},
      retirement: { kind: "retired", preparation: preparation as typeof retiredPreparation },
      securitySettle: async () => {calls += 1; return { kind: "settled" };},
    });
    const outcome = await retireAndCleanupContainedTurnPreparation(
      dependencies, initial, scope, subject, "reconciliation",
    );
    assert.deepEqual(outcome, { kind: "cleanup_pending", operation: initial });
    assert.equal(calls, 0);
  }
  assert.equal(oversizedEvidenceReads, 0, "the evidence cap is checked before copying array elements");
});

test("cleanup snapshots once before owner calls and never forwards or returns owner-store aggregates", async () => {
  const rawPermit = { ...retiredPreparation.cleanupPermit };
  const rawPreparation = {
    ...retiredPreparation,
    cleanupEvidenceIds: [],
    cleanupPermit: rawPermit,
  } as Extract<ContainedTurnDispatchPreparation, { readonly kind: "cleanup_pending" }>;
  const receivedPermits: unknown[] = [];
  const recordedAggregates: ContainedTurnDispatchPreparation[] = [];
  let current: ContainedTurnDispatchPreparation = retiredPreparation;
  const dependencies = cleanupDependencies({
    custodyRelease: async input => {
      receivedPermits.push(input.cleanupPermit);
      rawPermit.operationId = containedTurnIdentity("operation", "operation:mutated-after-snapshot");
      return { kind: "released" };
    },
    providerSettle: async _input => {
      return { kind: "settled" };
    },
    record: target => {
      current = recordContainedTurnPreparationCleanup(current, {
        permit: retiredPreparation.cleanupPermit,
        target,
      });
      const rawRecorded = { ...current } as ContainedTurnDispatchPreparation;
      recordedAggregates.push(rawRecorded);
      return rawRecorded;
    },
    retirement: { kind: "retired", preparation: rawPreparation },
    securitySettle: async _input => {
      return { kind: "settled" };
    },
  });

  const outcome = await retireAndCleanupContainedTurnPreparation(
    dependencies, initial, scope, subject, "reconciliation",
  );
  assert.equal(receivedPermits.length, 1);
  assert.equal(recordedAggregates.length, 3);
  assert.equal(outcome.kind, "cleanup_closed");
  for (const permit of receivedPermits) {
    assert.notStrictEqual(permit, rawPermit);
    assert.deepEqual(permit, retiredPreparation.cleanupPermit);
    assert.equal(Object.isFrozen(permit), true);
  }
  if (outcome.kind === "cleanup_closed") {
    assert.equal(recordedAggregates.includes(outcome.preparation), false);
    assert.equal(outcome.preparation.operationId, operationId);
    assert.equal(Object.isFrozen(outcome.preparation), true);
  }
});

test("cleanup rejects owner proxies, accessors, and outcome extras across the supported async boundary", async () => {
  let traps = 0;
  let getters = 0;
  let thenGets = 0;
  const proxiedPreparation = new Proxy({ ...retiredPreparation }, {
    ownKeys: () => {traps += 1; throw new TypeError("preparation trap must not run");},
  });
  assert.deepEqual(
    await retireAndCleanupContainedTurnPreparation(
      cleanupDependencies({ retirement: { kind: "retired", preparation: proxiedPreparation } }),
      initial, scope, subject, "reconciliation",
    ),
    { kind: "cleanup_pending", operation: initial },
  );
  const dependencies = cleanupDependencies({
    custodyRelease: async () => {
      const outcome = {};
      Object.defineProperty(outcome, "kind", {
        enumerable: true,
        get: () => {getters += 1; return "released";},
      });
      return outcome as { readonly kind: "released" };
    },
    providerSettle: async () =>
      ({ kind: "settled", rawOwnerPayload: "must-not-leak" }) as { readonly kind: "settled" },
    retirement: { kind: "retired", preparation: retiredPreparation },
    securitySettle: (() => new Proxy({ kind: "settled" as const }, {
      get: (_target, key) => {
        if (key === "then") {thenGets += 1; return;}
        traps += 1;
        throw new TypeError(`unexpected hostile get ${String(key)}`);
      },
      ownKeys: () => {traps += 1; throw new TypeError("cleanup outcome trap must not run");},
    })) as unknown as ContainedTurnKernelDependencies["security"]["settleConsumedGrant"],
  });
  const outcome = await retireAndCleanupContainedTurnPreparation(
    dependencies, initial, scope, subject, "reconciliation",
  );
  assert.equal(outcome.kind, "cleanup_pending");
  assert.equal(JSON.stringify(outcome).includes("must-not-leak"), false);
  assert.equal(thenGets, 0, "the trusted outer adapter rejects before Promise assimilation");
  assert.equal(traps, 0);
  assert.equal(getters, 0);
});
