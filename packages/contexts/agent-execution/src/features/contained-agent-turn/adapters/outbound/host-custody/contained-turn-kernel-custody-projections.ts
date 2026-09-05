import {
  containedTurnProviderAccessSnapshotDigest,
} from "../../../domain/contained-turn-authority.js";
import type {
  ContainedTurnCanonicalDigest,
  ContainedTurnCanonicalValue,
} from "../../../domain/contained-turn-codecs.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type {
  ContainedTurnKernelCustodyPort,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import type { HostCustodyEvidence } from "./custodied-provider-process.js";

type KernelOpenInput = Parameters<ContainedTurnKernelCustodyPort["open"]>[0];
type StartProof = Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }>;
type NoStartProof = Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }>;
type PhysicalProof = Extract<ContainedTurnProof, { readonly kind: "physical_containment" }>;

export interface ReservationIdentity {
  readonly attemptId: string;
  readonly custodyId: string;
  readonly operationId: string;
}

export interface ReservationProofAuthority {
  readonly attemptId: KernelOpenInput["attemptId"];
  readonly authorityVectorDigest: KernelOpenInput["authorityVectorDigest"];
  readonly custodyId: KernelOpenInput["custodyId"];
  readonly effectId: KernelOpenInput["effectId"];
  readonly operationId: KernelOpenInput["operationId"];
  readonly proofDigest?: ContainedTurnCanonicalDigest;
}

export interface HostProofIdentity {
  readonly hostBootId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostBootId"];
  readonly hostInstanceId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostInstanceId"];
}

export interface SealedProviderCompletion {
  readonly digest: ContainedTurnCanonicalDigest;
  readonly outcome: "cancelled" | "failed" | "succeeded";
}

export type ProjectedProviderObservation =
  | { readonly kind: "completed"; readonly outcome: SealedProviderCompletion["outcome"] }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "invalid" };

export const positiveInteger = (
  name: string,
  value: number | undefined,
  fallback: number,
): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new TypeError(name + " must be a positive integer");
  }
  return selected;
};

export const canonicalDigest = (
  value: ContainedTurnCanonicalValue,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue(value);

export const evidenceId = (source: string, value: ContainedTurnCanonicalValue) =>
  containedTurnIdentity(
    "evidence",
    "evidence:host-custody-adapter:" + source + ":" + canonicalDigest(value),
  );

export const proofId = (source: string, value: ContainedTurnCanonicalValue) =>
  containedTurnIdentity(
    "proof",
    "proof:host-custody-adapter:" + source + ":" + canonicalDigest(value),
  );

export const exactRecord = (
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return false;}
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

export const projectProviderObservation = (value: unknown): ProjectedProviderObservation => {
  if (exactRecord(value, ["kind", "outcome"]) && value.kind === "completed" &&
      (value.outcome === "cancelled" || value.outcome === "failed" ||
       value.outcome === "succeeded")) {
    return Object.freeze({ kind: "completed", outcome: value.outcome });
  }
  if (exactRecord(value, ["evidenceId", "kind"]) && value.kind === "indeterminate" &&
      typeof value.evidenceId === "string" && value.evidenceId.length > 0) {
    return Object.freeze({ kind: "indeterminate" });
  }
  return Object.freeze({ kind: "invalid" });
};

export const reservationIdentity = (
  reservation: ReservationIdentity,
): Readonly<{ readonly attemptId: string; readonly custodyId: string; readonly operationId: string }> =>
  Object.freeze({
    attemptId: reservation.attemptId,
    custodyId: reservation.custodyId,
    operationId: reservation.operationId,
  });

export const openIdentity = (
  input: KernelOpenInput,
  authority: Readonly<{
    readonly intentMode: "analysis" | "workspace-write";
    readonly workspaceRef: string;
  }>,
): ContainedTurnCanonicalDigest => canonicalDigest(Object.freeze({
  adapterRevision: input.adapterSnapshot.adapterRevision,
  attemptId: input.attemptId,
  authorityVectorDigest: input.authorityVectorDigest,
  binaryRevision: input.adapterSnapshot.binaryRevision,
  capabilityManifestRevision: input.adapterSnapshot.capabilityManifestRevision,
  commandId: input.commandId,
  custodyId: input.custodyId,
  effectId: input.effectId,
  intentMode: authority.intentMode,
  operationId: input.operationId,
  operationCutoffRevision: input.operationCutoffRevision,
  operationRevision: input.operationRevision,
  preparationToken: input.preparationToken,
  provider: input.adapterSnapshot.provider,
  providerAccessSnapshotDigest: containedTurnProviderAccessSnapshotDigest(
    input.providerAccessSnapshot,
  ),
  workspaceId: input.workspaceId,
  workspaceRef: authority.workspaceRef,
}));

export const hostEvidenceProjection = (
  evidence: HostCustodyEvidence,
): ContainedTurnCanonicalValue => Object.freeze({
  ...(evidence.closure.profile === "strict-linux-cgroup-v2" ? {} : {
    closureLimitations: evidence.closure.limitations,
    closureProfile: evidence.closure.profile,
  }),
  closureStatus: evidence.closure.status,
  fingerprintSha256: evidence.fingerprint.fingerprintSha256,
  guardianExit: evidence.guardianExit.status === "observed"
    ? Object.freeze({
      code: evidence.guardianExit.code === null ? null : String(evidence.guardianExit.code),
      signal: evidence.guardianExit.signal,
      status: evidence.guardianExit.status,
    })
    : Object.freeze({ code: null, signal: null, status: evidence.guardianExit.status }),
  identity: Object.freeze({
    binarySha256: evidence.identity.binarySha256,
    childProcessInstanceSha256: evidence.identity.childProcessInstanceSha256,
    hostLifecycleGenerationSha256: evidence.identity.hostLifecycleGenerationSha256,
    pgid: evidence.identity.pgid === undefined ? null : String(evidence.identity.pgid),
    pid: evidence.identity.pid === undefined ? null : String(evidence.identity.pid),
    planSha256: evidence.identity.planSha256,
    proofRef: evidence.identity.proofRef ?? null,
    status: evidence.identity.status,
  }),
  privateRootStatus: evidence.privateRoot.status,
  providerExit: evidence.providerExit.status === "observed"
    ? Object.freeze({
      code: evidence.providerExit.code === null ? null : String(evidence.providerExit.code),
      signal: evidence.providerExit.signal,
      status: evidence.providerExit.status,
    })
    : Object.freeze({ code: null, signal: null, status: evidence.providerExit.status }),
  sealed: evidence.sealed,
  spawn: evidence.spawn,
  stderr: Object.freeze({
    bytes: String(evidence.stderr.bytes),
    sha256: evidence.stderr.sha256,
    status: evidence.stderr.status,
  }),
  stdout: Object.freeze({
    bytes: String(evidence.stdout.bytes),
    sha256: evidence.stdout.sha256,
    status: evidence.stdout.status,
  }),
});

export const completionProjection = (
  completion: SealedProviderCompletion,
): ContainedTurnCanonicalValue => Object.freeze({
  digest: completion.digest,
  outcome: completion.outcome,
});

export const waitForDelay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => {setTimeout(resolve, milliseconds);});

export type HostStartObservation =
  | { readonly evidence: HostCustodyEvidence; readonly kind: "execution_started" }
  | { readonly evidence: HostCustodyEvidence; readonly kind: "proved_no_start" }
  | {
    readonly detail: ContainedTurnCanonicalValue;
    readonly kind: "indeterminate";
    readonly source: "start-cutoff" | "start-observation";
  };

export const observeHostStart = async (input: Readonly<{
  readonly contain: () => Promise<unknown>;
  readonly creatorCalled: () => boolean;
  readonly cutoff: () => boolean;
  readonly evidence: () => HostCustodyEvidence | undefined;
  readonly executionSettled: () => boolean;
  readonly monotonicNow: () => number;
  readonly reservation: ReservationIdentity;
  readonly timeoutMs: number;
}>): Promise<HostStartObservation> => {
  const deadline = input.monotonicNow() + input.timeoutMs;
  let attemptedNoStartContainment = false;
  for (;;) {
    if (input.cutoff()) {
      return Object.freeze({
        detail: reservationIdentity(input.reservation), kind: "indeterminate", source: "start-cutoff",
      });
    }
    let evidence = input.evidence();
    if (evidence?.spawn === "acknowledged" && evidence.identity.status === "proved") {
      return Object.freeze({ evidence, kind: "execution_started" });
    }
    if (evidence !== undefined && noStartEvidenceIsClosed(evidence)) {
      return Object.freeze({ evidence, kind: "proved_no_start" });
    }
    if (!input.creatorCalled() && input.executionSettled() && !attemptedNoStartContainment) {
      attemptedNoStartContainment = true;
      await input.contain();
      evidence = input.evidence();
      if (evidence !== undefined && noStartEvidenceIsClosed(evidence)) {
        return Object.freeze({ evidence, kind: "proved_no_start" });
      }
    }
    if (input.monotonicNow() >= deadline) {
      return Object.freeze({
        detail: Object.freeze({
          ...reservationIdentity(input.reservation),
          creatorCalled: input.creatorCalled(),
          identityStatus: evidence?.identity.status ?? "missing",
          spawn: evidence?.spawn ?? "missing",
        }),
        kind: "indeterminate",
        source: "start-observation",
      });
    }
    await waitForDelay(Math.min(10, Math.max(1, deadline - input.monotonicNow())));
  }
};

export const noStartEvidenceIsClosed = (evidence: HostCustodyEvidence): boolean =>
  (evidence.spawn === "error-before-start" || evidence.spawn === "never-started") &&
  evidence.closure.status === "not-started" &&
  evidence.identity.status === "not-started" &&
  evidence.providerExit.status === "not-started" &&
  evidence.sealed &&
  (evidence.stdout.status === "complete" || evidence.stdout.status === "not-started") &&
  (evidence.stderr.status === "complete" || evidence.stderr.status === "not-started");

export const physicalEvidenceIsClosed = (evidence: HostCustodyEvidence): boolean =>
  evidence.closure.profile === "strict-linux-cgroup-v2" &&
  evidence.closure.limitations.length === 0 &&
  evidence.sealed &&
  (evidence.closure.status === "closed" || evidence.closure.status === "not-started");

export const executionEvidenceIsClosed = (evidence: HostCustodyEvidence): boolean =>
  // Darwin can seal exact execution observations while descendant containment remains unproven.
  (evidence.closure.status === "closed" ||
    (evidence.closure.profile === "cooperative-darwin-posix-process-group" &&
      evidence.closure.status === "unproven")) &&
  evidence.guardianExit.status === "observed" &&
  evidence.identity.status === "proved" &&
  evidence.providerExit.status === "observed" &&
  evidence.sealed &&
  evidence.spawn === "acknowledged" &&
  evidence.stderr.status === "complete" &&
  evidence.stdout.status === "complete";

const processBinding = (
  reservation: ReservationProofAuthority,
  host: HostProofIdentity,
) => Object.freeze({
  attemptId: reservation.attemptId,
  authorityVectorDigest: reservation.authorityVectorDigest,
  custodyId: reservation.custodyId,
  effectId: reservation.effectId,
  hostBootId: host.hostBootId,
  hostInstanceId: host.hostInstanceId,
  operationId: reservation.operationId,
});

const processProjection = (
  reservation: ReservationProofAuthority,
  evidence: HostCustodyEvidence,
): ContainedTurnCanonicalValue => Object.freeze({
  evidence: hostEvidenceProjection(evidence),
  reservation: reservationIdentity(reservation),
  proofDigest: reservation.proofDigest ?? null,
});

export const createProcessStartProof = (
  reservation: ReservationProofAuthority,
  evidence: HostCustodyEvidence,
  host: HostProofIdentity,
): StartProof => Object.freeze({
  binding: processBinding(reservation, host),
  kind: "provider_process_start",
  proofId: proofId("provider-process-start", processProjection(reservation, evidence)),
});

export const createProcessNoStartProof = (
  reservation: ReservationProofAuthority,
  evidence: HostCustodyEvidence,
  host: HostProofIdentity,
): NoStartProof => Object.freeze({
  binding: processBinding(reservation, host),
  kind: "provider_process_no_start",
  proofId: proofId("provider-process-no-start", processProjection(reservation, evidence)),
});

export const createPhysicalProof = (
  reservation: ReservationProofAuthority,
  evidence: HostCustodyEvidence,
  host: HostProofIdentity,
  receiptRef: string,
): PhysicalProof => Object.freeze({
  binding: processBinding(reservation, host),
  kind: "physical_containment",
  proofId: proofId("physical-containment", Object.freeze({
    evidence: hostEvidenceProjection(evidence),
    proofDigest: reservation.proofDigest ?? null,
    receiptRef,
    reservation: reservationIdentity(reservation),
  })),
});
