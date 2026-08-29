import assert from "node:assert/strict";
import test from "node:test";

import { createContainedTurnFeature } from "../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { containedTurnSatisfactionDigest } from "../dist/features/contained-agent-turn/domain/contained-turn-satisfaction.js";
import { mutateContainedTurnOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-transitions.js";
import type { ContainedTurnKernelOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import type { ContainedTurnProof } from "../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import type { ContainedTurnKernelDependencies } from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";

const identity = <Namespace extends Parameters<typeof containedTurnIdentity>[0]>(namespace: Namespace, suffix: string) =>
  containedTurnIdentity(namespace, `${String(namespace).replaceAll("_", "-")}:${suffix}`);
const proofId = (suffix: string) => identity("proof", suffix);
const operationId = identity("operation", "one");
const effectId = identity("effect", "one");
const attemptId = identity("attempt", "one");
const custodyId = identity("custody", "one");
const workspaceId = identity("workspace", "one");
const hostBootId = identity("host_boot", "one");
const hostInstanceId = identity("host_instance", "one");

const adapterSnapshot = Object.freeze({
  adapterRevision: "adapter:one",
  binaryRevision: "binary:one",
  capabilityManifestRevision: "manifest:one",
  provider: "codex" as const,
});
const providerAccessSnapshot = Object.freeze({
  accessRef: "access:one",
  credentialBindingDigest: digestContainedTurnCanonicalValue({ binding: "one" }),
  credentialBindingRef: "credential-binding:one",
  credentialGeneration: 1,
  ownerAuthorityDigest: "authority-digest:one",
  projectId: "project:one",
  provider: "codex" as const,
  providerAccountRef: "account:one",
  providerRouteRef: "route:one",
  revision: 1,
  tenantId: "tenant:one",
});
const manifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation" as const,
  effectClass: "contained_unmediated_effect" as const,
  manifestRevision: adapterSnapshot.capabilityManifestRevision,
  manifestVersion: 1 as const,
  provider: "codex" as const,
  providerAttemptCardinality: "at_most_one" as const,
  requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: "resource-scope:one",
  supportedModes: Object.freeze(["analysis"] as const),
  unknownCapabilityPolicy: "fail_closed" as const,
});

const operationBinding = (operation: ContainedTurnKernelOperation) => ({
  authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  operationId: operation.operationId,
});
const attemptBinding = (operation: ContainedTurnKernelOperation) => {
  assert.equal(operation.dispatch.kind, "claimed");
  return { ...operationBinding(operation), attemptId, effectId: operation.effectId };
};

const createDependencies = (options: Readonly<{
  artifactIndeterminate?: boolean;
  emitBeforeGate?: boolean;
  indeterminateFirstCommit?: boolean;
  providerGate?: Promise<void>;
  providerStarted?: () => void;
  staleClaimAuthority?: boolean;
}> = {}): {
  claimAuthorities: Array<Parameters<ContainedTurnKernelDependencies["operationStore"]["claimDispatch"]>[0]["authority"]>;
  containmentCalls: { value: number };
  dependencies: ContainedTurnKernelDependencies;
  providerCalls: { value: number };
} => {
  let current: ContainedTurnKernelOperation | undefined;
  let commitCount = 0;
  const claimAuthorities: Array<Parameters<ContainedTurnKernelDependencies["operationStore"]["claimDispatch"]>[0]["authority"]> = [];
  const containmentCalls = { value: 0 };
  const providerCalls = { value: 0 };
  const operationStore: ContainedTurnKernelDependencies["operationStore"] = {
    accept: async candidate => {
      current = candidate;
      return { kind: "accepted", operation: candidate };
    },
    commit: async input => {
      if (current === undefined) {return { kind: "not_found" };}
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" };}
      commitCount += 1;
      if (options.indeterminateFirstCommit === true && commitCount === 1) {
        const evidenceId = identity("evidence", "lost-store-ack");
        current = mutateContainedTurnOperation(current, { evidenceId, kind: "record_reconciliation_debt", source: "store_commit" });
        return { debtOperation: current, evidenceId, kind: "indeterminate" };
      }
      current = input.candidate;
      return { kind: "applied", operation: current };
    },
    claimDispatch: async input => {
      if (current === undefined) {return { kind: "not_found" };}
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" };}
      assert.equal(input.authority.providerAccessRevision, current.providerAccessSnapshot.revision);
      assert.equal(input.authority.securityAuthorityRevision, current.acceptedAuthorityVector.securityAuthorityRevision);
      claimAuthorities.push(input.authority);
      if (options.staleClaimAuthority === true) {return { current, kind: "stale" };}
      current = input.candidate;
      return { kind: "applied", operation: current };
    },
    identifyAcceptance: async () => ({
      acceptanceProofId: proofId("acceptance"),
      effectId,
      kind: "available",
      operationAuthorityRevision: "operation-authority:one",
      operationId,
    }),
    prepareCancellation: async operation => {
      const scopeDigest = operation.acceptedAuthorityVector.scopeDigest;
      const cancellationCommandId = identity("cancellation_command", "one");
      const command = {
        cancellationCommandId,
        fingerprint: digestContainedTurnCanonicalValue({ cancellationCommandId, operationId, scopeDigest, version: 1 }) as never,
        operationId,
        scopeDigest,
      };
      return {
        command,
        cutoffProof: operation.admissionFence.kind === "fenced"
          ? operation.proofs.find(proof => proof.kind === "cutoff" && proof.proofId === operation.admissionFence.proofId) as Extract<ContainedTurnProof, { kind: "cutoff" }>
          : { binding: { ...operationBinding(operation), cancellationCommandId }, kind: "cutoff", proofId: proofId("cancel-cutoff") },
        proof: { binding: { ...operationBinding(operation), cancellationCommandId, cancellationFingerprint: command.fingerprint }, kind: "cancellation", proofId: proofId("cancellation") },
      };
    },
    prepareDispatch: async () => ({ attemptId, claimProofId: proofId("claim"), custodyId, cutoffProofId: proofId("cutoff") }),
    proofsForPrevention: async () => {throw new Error("not used by success conformance");},
    proofsForProcessNoStart: async () => {throw new Error("not used by success conformance");},
    read: async requested => requested === operationId ? current : undefined,
    requestCancellation: async input => {
      if (current === undefined) {return { kind: "not_found" };}
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" };}
      current = input.candidate;
      return { kind: "applied", operation: current };
    },
    terminalProof: async input => {
      assert.equal(input.satisfactionDigest, containedTurnSatisfactionDigest(input.operation));
      assert.equal(input.operation.providerExecution.kind, "closed");
      return {
        binding: { ...operationBinding(input.operation), satisfactionDigest: input.satisfactionDigest, terminalOutcome: input.operation.providerExecution.outcome },
        kind: "terminal_truth",
        proofId: proofId("terminal"),
      };
    },
  };
  const dependencies: ContainedTurnKernelDependencies = {
    operationStore,
    security: {
      authorizeForAcceptance: async () => ({
        acceptanceProofId: proofId("security-acceptance"),
        authorityRevision: "security-authority:one",
        containmentPolicyDigest: digestContainedTurnCanonicalValue({ containment: "one" }),
        decisionDigest: digestContainedTurnCanonicalValue({ allowed: true }),
        kind: "allowed",
      }),
      revalidateForDispatch: async () => ({ dispatchDecisionDigest: digestContainedTurnCanonicalValue({ current: true }), kind: "current", proofId: proofId("security-dispatch") }),
    },
    providerAccess: {
      resolveForAcceptance: async () => ({
        acceptanceProofId: proofId("provider-access-acceptance"),
        acceptanceResolutionDigest: digestContainedTurnCanonicalValue({ resolved: true }),
        kind: "resolved",
        snapshot: providerAccessSnapshot,
      }),
      revalidateForDispatch: async () => ({
        dispatchProofId: proofId("provider-access-dispatch"),
        dispatchResolutionDigest: digestContainedTurnCanonicalValue({ current: true }),
        kind: "current",
        snapshot: providerAccessSnapshot,
      }),
    },
    workspace: {
      close: async input => ({ kind: "closed", proof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), workspaceId: input.workspaceId }, kind: "workspace_closure", proofId: proofId("workspace-closure") } }),
      create: async () => ({ workspaceId }),
      quarantine: async () => {},
    },
    artifacts: {
      seal: async input => options.artifactIndeterminate === true
        ? { evidenceId: identity("evidence", "artifact-unknown"), kind: "indeterminate" }
        : ({
        artifactProof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), artifactManifestRef: "artifact:one", workspaceId: input.workspaceId }, kind: "artifact_manifest_seal", proofId: proofId("artifact") },
        kind: "sealed",
        resultProof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), resultRef: "result:one" }, kind: "result_publication", proofId: proofId("result") },
      }),
    },
    custody: {
      open: async () => ({
        custodyId,
        hostBootId,
        hostCustodyProof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), attemptId, effectId, custodyId }, kind: "host_custody", proofId: proofId("host-custody") },
        hostInstanceId,
      }),
      requestContainment: async () => {
        containmentCalls.value += 1;
        const operation = current as ContainedTurnKernelOperation;
        if (operation.output.fence.kind === "open") {
          return { evidenceId: identity("evidence", "containment-pending"), kind: "indeterminate" };
        }
        const proof = (kind: ContainedTurnProof["kind"]) => operation.proofs.find(candidate => candidate.kind === kind)?.proofId as ReturnType<typeof proofId>;
        return {
          kind: "contained",
          proof: {
            binding: {
              ...attemptBinding(operation),
              adapterRevision: operation.adapterSnapshot.adapterRevision,
              artifactManifestSealProofId: proof("artifact_manifest_seal"),
              binaryRevision: operation.adapterSnapshot.binaryRevision,
              capabilityManifestRevision: operation.capabilityManifest.manifestRevision,
              containmentPolicyDigest: operation.acceptedAuthorityVector.containmentPolicyDigest,
              credentialBindingDigest: operation.providerAccessSnapshot.credentialBindingDigest,
              custodyId,
              cutoffProofId: proof("cutoff"),
              executionClosureProofId: proof("execution_closure"),
              finalCursor: operation.output.chunks.length,
              hostBootId,
              hostInstanceId,
              immutableScopeDigest: operation.acceptedAuthorityVector.scopeDigest,
              outputDrainProofId: proof("output_drain"),
              providerRouteRef: operation.providerAccessSnapshot.providerRouteRef,
              terminalObservationProofId: proof("provider_terminal_observation"),
              workspaceId,
            },
            kind: "containment",
            proofId: proofId("containment"),
          },
        };
      },
      start: async () => ({
        kind: "execution_started",
        proof: { binding: { ...attemptBinding(current as ContainedTurnKernelOperation), custodyId, hostBootId, hostInstanceId }, kind: "provider_process_start", proofId: proofId("process-start") },
      }),
    },
    provider: {
      adapterSnapshot,
      manifest,
      execute: async input => {
        providerCalls.value += 1;
        options.providerStarted?.();
        if (options.emitBeforeGate === true) {await input.emit({ cursor: 0, kind: "assistant", text: "before cancellation" });}
        await options.providerGate;
        if (await input.isCancellationRequested()) {
          return { evidenceId: identity("evidence", "provider-after-cancellation"), kind: "indeterminate" };
        }
        await input.emit({ cursor: 0, kind: "assistant", text: "ok" });
        const operation = current as ContainedTurnKernelOperation;
        const binding = attemptBinding(operation);
        return {
          acceptanceProof: { binding: { ...binding, disposition: "accepted" }, kind: "provider_acceptance", proofId: proofId("provider-acceptance") },
          effectProof: { binding: { ...binding, disposition: "committed" }, kind: "effect_resolution", proofId: proofId("effect") },
          executionClosureProof: { binding: { ...binding, outcome: "succeeded" }, kind: "execution_closure", proofId: proofId("execution") },
          kind: "completed",
          outcome: "succeeded",
          outputDrainProof: { binding: { ...binding, finalCursor: 1 }, kind: "output_drain", proofId: proofId("output-drain") },
          terminalObservationProof: { binding: { ...binding, outcome: "succeeded" }, kind: "provider_terminal_observation", proofId: proofId("terminal-observation") },
        };
      },
    },
  };
  return { claimAuthorities, containmentCalls, dependencies, providerCalls };
};

test("seven-port conformance reaches terminal truth through only ordered kernel APIs", async () => {
  const { dependencies, providerCalls } = createDependencies();
  const feature = createContainedTurnFeature(dependencies);
  const result = await feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") {return;}
  assert.equal(result.turn.status, "succeeded");
  assert.deepEqual(result.turn.output, [{ cursor: 0, kind: "assistant", text: "ok" }]);
  assert.equal(providerCalls.value, 1);
  assert.deepEqual(await feature.observe.execute({ operationId, scope: { projectId: "project:one", tenantId: "tenant:one" } }), result);
});

test("final dispatch claim CAS carries Provider Access and Runtime Security authority fences", async () => {
  const { claimAuthorities, dependencies } = createDependencies();
  await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(claimAuthorities.length, 1);
  assert.equal(claimAuthorities[0]?.providerAccessRevision, 1);
  assert.equal(claimAuthorities[0]?.securityAuthorityRevision, "security-authority:one");
  assert.equal(claimAuthorities[0]?.providerAccessDispatchProofId, proofId("provider-access-dispatch"));
  assert.equal(claimAuthorities[0]?.runtimeSecurityDispatchProofId, proofId("security-dispatch"));
});

test("authority change at the final dispatch CAS prevents provider start", async () => {
  const { dependencies, providerCalls } = createDependencies({ staleClaimAuthority: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  assert.equal(providerCalls.value, 0);
});

test("durable acceptance is published before provider execution and accepted cancellation requests Host containment", async () => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => {releaseProvider = resolve;});
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => {providerStarted = resolve;});
  let accepted: import("../dist/index.js").ContainedTurnOperationRef | undefined;
  const { containmentCalls, dependencies } = createDependencies({ emitBeforeGate: true, providerGate, providerStarted });
  const feature = createContainedTurnFeature(dependencies);
  const submission = feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }, { onAccepted: operation => {accepted = operation;} });
  await started;
  assert.equal(accepted?.operationId, operationId);
  const cancellation = await feature.cancel.execute(accepted as import("../dist/index.js").ContainedTurnOperationRef);
  assert.equal(cancellation.status, "observed");
  assert.equal(containmentCalls.value, 1);
  if (cancellation.status === "observed") {
    assert.equal(cancellation.turn.output.length, 1);
    assert.equal(cancellation.turn.status, "reconcile_required");
  }
  releaseProvider();
  const completed = await submission;
  assert.equal(completed.status, "observed");
  if (completed.status === "observed") {assert.equal(completed.turn.status, "reconcile_required");}
});

test("abort after durable acceptance requests application cancellation without relying on onAccepted", async () => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => {releaseProvider = resolve;});
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => {providerStarted = resolve;});
  const controller = new AbortController();
  const { containmentCalls, dependencies } = createDependencies({ providerGate, providerStarted });
  const submission = createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }, { signal: controller.signal });
  await started;
  controller.abort();
  while (containmentCalls.value === 0) {await new Promise<void>(resolve => {setImmediate(resolve);});}
  assert.equal(containmentCalls.value, 1);
  releaseProvider();
  const completed = await submission;
  assert.equal(completed.status, "observed");
  if (completed.status === "observed") {assert.equal(completed.turn.status, "reconcile_required");}
});

test("lost store acknowledgement is returned only with durable reconciliation debt and no provider retry", async () => {
  const { dependencies, providerCalls } = createDependencies({ indeterminateFirstCommit: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 0);
});

test("[oracle-06-seal-outbox-recovery] unknown artifact sealing persists reconciliation debt without terminal failure or retry", async () => {
  const { dependencies, providerCalls } = createDependencies({ artifactIndeterminate: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 1);
});

test("composition rejects every non-exact seven-port dependency bag before effects", () => {
  const { dependencies, providerCalls } = createDependencies();
  const inherited = Object.create(dependencies) as ContainedTurnKernelDependencies;
  assert.throws(() => createContainedTurnFeature(inherited), /ordinary object prototype/u);
  const symbol = Object.assign({ ...dependencies }, { [Symbol("hidden")]: true }) as ContainedTurnKernelDependencies;
  assert.throws(() => createContainedTurnFeature(symbol), /symbol keys/u);
  const nonEnumerable = { ...dependencies };
  Object.defineProperty(nonEnumerable, "hidden", { enumerable: false, value: true });
  assert.throws(() => createContainedTurnFeature(nonEnumerable), /enumerable data properties/u);
  const prototypeExtra = Object.assign(Object.create({ hidden: true }), dependencies) as ContainedTurnKernelDependencies;
  assert.throws(() => createContainedTurnFeature(prototypeExtra), /ordinary object prototype/u);
  assert.equal(providerCalls.value, 0);
});
