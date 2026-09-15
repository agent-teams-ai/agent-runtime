import {hasPreparationCallback, isSupportedIntent, startWasCutOff, kernelIndeterminate, readKernelReservation, createKernelReservation, kernelOpenOutcome, sealProviderCompletion} from "./contained-turn-kernel-custody-reservation-projection.js";
import { types } from "node:util";
import { isNativeHostCustodyWorkspaceAuthority, inspectNativeHostCustodyWorkspaceAuthority } from "./native-host-custody-workspace-authority.js";
import { KernelOpenAttempts, type KernelOpenAttempt } from "./contained-turn-kernel-custody-open-attempts.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type {
  ContainedTurnKernelCustodyPort,
  ContainedTurnKernelProviderObservation,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  HostCustodyLaunchPlan,
  HostCustodyReservationInput,
  ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";
import {
  type ContainedTurnHostCustodyPort,
  type ContainedTurnKernelCustodyAdapterOptions,
  type ContainedTurnKernelCustodyAttemptOwner,
  type ContainedTurnKernelWorkspaceOwner,
  type KernelOpenInput,
} from "./contained-turn-kernel-custody-contracts.js";
import { openKernelCompletionBoundary } from "./contained-turn-kernel-custody-deadline.js";
import { createExecutionAttestation } from "./contained-turn-kernel-custody-execution-attestation.js";
import {
  canonicalDigest,
  createPhysicalProof,
  createProcessNoStartProof,
  createProcessStartProof,
  evidenceId,
  exactRecord,
  executionEvidenceIsClosed,
  hostEvidenceProjection,
  observeHostStart,
  openIdentity,
  physicalEvidenceIsClosed,
  positiveInteger,
  projectProviderBinding,
  proofId,
  reservationIdentity,
} from "./contained-turn-kernel-custody-projections.js";
import {
  type ContainedTurnKernelCustodyLaunchAuthority,
  type KernelReservation,
  sameReservation,
} from "./contained-turn-kernel-custody-state.js";
import { admitCommittedDispatchStart } from "./contained-turn-kernel-custody-start-admission.js";

export type {
  ContainedTurnHostCustodyPort,
  ContainedTurnKernelCustodyAdapterOptions,
  ContainedTurnKernelCustodyAttemptOwner,
  ContainedTurnKernelWorkspaceOwner,
} from "./contained-turn-kernel-custody-contracts.js";
type StartInput = Parameters<ContainedTurnKernelCustodyPort["start"]>[0];
type StartProof = Extract<ContainedTurnProof, { readonly kind: "provider_process_start" }>;
type NoStartProof = Extract<ContainedTurnProof, { readonly kind: "provider_process_no_start" }>;
type StartObservation =
  | { readonly kind: "execution_started"; readonly proof: StartProof }
  | { readonly kind: "proved_no_start"; readonly proof: NoStartProof }
  | {
    readonly evidenceId: ReturnType<typeof evidenceId>;
    readonly kind: "indeterminate";
  };
type PhysicalInput = Parameters<ContainedTurnKernelCustodyPort["ensurePhysicalContainment"]>[0];
type ContainmentInput = Parameters<ContainedTurnKernelCustodyPort["attestContainment"]>[0];
/**
 * Outer anti-corruption adapter from raw Host facts to the kernel proof port.
 * Provider protocol completion is sealed from the exact one-use execute promise;
 * operating-system exit status is never interpreted as a logical outcome.
 */
export class ContainedTurnKernelCustodyAdapter implements ContainedTurnKernelCustodyPort {
  #admissionClosed = false;
  readonly #preparation: ContainedTurnKernelCustodyAdapterOptions["postClaimPreparation"];
  readonly #preparing = new Map<string, AbortController>();
  readonly #completionAfterMs: number;
  readonly #hostBootId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostBootId"];
  readonly #hostCustody: ContainedTurnHostCustodyPort;
  readonly #hostInstanceId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostInstanceId"];
  readonly #attemptOwner: ContainedTurnKernelCustodyAttemptOwner;
  readonly #workspaceOwner: ContainedTurnKernelWorkspaceOwner;
  readonly #monotonicNow: () => number;
  readonly #openAttempts = new KernelOpenAttempts();
  readonly #reservations = new Map<string, KernelReservation>();
  readonly #startObservationAfterMs: number;
  public constructor(
    hostCustody: ContainedTurnHostCustodyPort,
    options: ContainedTurnKernelCustodyAdapterOptions,
  ) {
    const preparation = options.postClaimPreparation;
    if (preparation !== "current-owner" && !hasPreparationCallback(preparation)) {
      throw new TypeError("Host post-claim preparation owner is unavailable");
    }
    this.#preparation = preparation === "current-owner" ? preparation
      : Object.freeze({prepareClaimed: preparation.prepareClaimed.bind(preparation)});
    this.#hostCustody = hostCustody;
    this.#completionAfterMs = positiveInteger("completionAfterMs", options.completionAfterMs, 30_000);
    this.#startObservationAfterMs = positiveInteger(
      "startObservationAfterMs", options.startObservationAfterMs, 10_000,
    );
    this.#attemptOwner = options.attemptOwner;
    this.#workspaceOwner = options.workspaceOwner;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#hostBootId = containedTurnIdentity("host_boot", options.hostBootId);
    this.#hostInstanceId = containedTurnIdentity("host_instance", options.hostInstanceId);
  }
  /** Host-private lifecycle fence; it neither releases custody nor proves closure. */
  public sealAdmission(): void {
    this.#admissionClosed = true;
    this.#openAttempts.sealAdmission();
    for (const reservation of this.#reservations.values()) {reservation.startBoundaryCutoff = true;}
    for (const preparation of this.#preparing.values()) {preparation.abort();}
  }
  public async open(input: KernelOpenInput): ReturnType<ContainedTurnKernelCustodyPort["open"]> {
    if (this.#admissionClosed) {throw new TypeError("Host Custody admission is unavailable");}
    const existing = this.#reservations.get(input.custodyId);
    if (existing !== undefined) {
      const identity = openIdentity(input, {
        intentMode: input.intentMode,
        workspaceRef: "owner-private-workspace-not-reconsumed",
      });
      if (!sameReservation(existing, input) || existing.kernelOpenIdentityDigest !== identity) {
        throw new TypeError("Host Custody kernel reservation identity conflict");
      }
      return this.#openOutcome(existing);
    }
    return this.#openAttempts.open(input, this.#workspaceOwner, this.#attemptOwner,
      (snapshot, authority, attempt) => this.#openScoped(snapshot, authority, attempt));
  }
  async #openScoped(
    input: KernelOpenInput,
    workspaceAuthority: HostCustodyReservationInput["workspaceAuthority"],
    attempt: KernelOpenAttempt,
  ): ReturnType<ContainedTurnKernelCustodyPort["open"]> {
    if (isNativeHostCustodyWorkspaceAuthority(workspaceAuthority)) {
      inspectNativeHostCustodyWorkspaceAuthority(workspaceAuthority, input);
    } else if (types.isProxy(workspaceAuthority) || !("descriptorPath" in workspaceAuthority) || workspaceAuthority.canonicalPath.length === 0 ||
        workspaceAuthority.descriptorPath.length === 0 || workspaceAuthority.identity.mountId.length === 0) {
      throw new TypeError("Host Custody scoped workspace authority is unavailable");
    }
    if (!isSupportedIntent(input.intentMode)) {
      throw new TypeError("Host Custody scoped workspace authority is unavailable");
    }
    const providerBinding = projectProviderBinding(input);
    const plan = await this.#attemptOwner.prepare({ kernel: input, providerBinding, workspaceAuthority });
    const authority = Object.freeze({ intentMode: input.intentMode, workspaceRef: workspaceAuthority.canonicalPath });
    if (attempt.closed) {throw new TypeError("Host Custody open was cut off before acquisition");}
    if (isNativeHostCustodyWorkspaceAuthority(workspaceAuthority)) {
      inspectNativeHostCustodyWorkspaceAuthority(workspaceAuthority, input);
    }
    // From this point even a rejected or malformed raw response may own resources.
    attempt.acquisitionPossible = true;
    return this.#reserve(input, authority, providerBinding, plan, workspaceAuthority);
  }
  async #reserve(
    input: KernelOpenInput,
    authority: ContainedTurnKernelCustodyLaunchAuthority,
    providerBinding: HostCustodyReservationInput["providerBinding"],
    launchPlan: HostCustodyLaunchPlan,
    workspaceAuthority: HostCustodyReservationInput["workspaceAuthority"],
  ): ReturnType<ContainedTurnKernelCustodyPort["open"]> {
    const identityDigest = openIdentity(input, authority);
    const existing = this.#reservations.get(input.custodyId);
    if (existing !== undefined) {
      if (!sameReservation(existing, input) || existing.openIdentityDigest !== identityDigest) {
        throw new TypeError("Host Custody kernel reservation identity conflict");
      }
      return this.#openOutcome(existing);
    }
    try {
      const opened = await this.#hostCustody.reserve({
        attemptId: input.attemptId, intentMode: authority.intentMode, launchPlan,
        operationId: input.operationId, providerBinding, workspaceAuthority,
        workspaceRef: authority.workspaceRef,
      });
      if (!exactRecord(opened, ["custodyRef"]) ||
          typeof opened.custodyRef !== "string" || opened.custodyRef.length === 0) {
        throw new TypeError("Host Custody returned no exact reservation identity");
      }
      const custodyRef = opened.custodyRef;
      this.#attemptOwner.retain({
        kernel: input, underlyingCustodyRef: custodyRef, workspaceRef: authority.workspaceRef,
      });
      return this.#recordReservation(input, authority, identityDigest, custodyRef);
    } catch (error) {
      this.#attemptOwner.retire(input);
      throw error;
    }
  }
  #recordReservation(input: KernelOpenInput, authority: ContainedTurnKernelCustodyLaunchAuthority,
    identityDigest: ReturnType<typeof openIdentity>, custodyRef: string): Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>> {
    const reservation = createKernelReservation(input, authority, identityDigest, custodyRef);
    this.#reservations.set(input.custodyId, reservation);
    return this.#openOutcome(reservation);
  }
  #openOutcome(reservation: KernelReservation): Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>> {
    return kernelOpenOutcome(reservation, {hostBootId: this.#hostBootId, hostInstanceId: this.#hostInstanceId});
  }
  public completionBoundary(
    input: Parameters<ContainedTurnKernelCustodyPort["completionBoundary"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["completionBoundary"]> {
    const boundary = openKernelCompletionBoundary(input, readKernelReservation(this.#reservations, input), this.#completionAfterMs);
    if (input.phase === "start") {void boundary.expiration.then(() => {this.#preparing.get(input.custodyId)?.abort(); return null;});}
    return boundary;
  }
  public async start(input: StartInput): ReturnType<ContainedTurnKernelCustodyPort["start"]> {
    if (this.#admissionClosed) {throw new TypeError("Host Custody admission is unavailable");}
    const reservation = readKernelReservation(this.#reservations, input);
    const hostCustodyProof = this.#openOutcome(reservation).hostCustodyProof;
    admitCommittedDispatchStart(input, reservation, {
      hostBootId: this.#hostBootId,
      hostCustodyProofId: hostCustodyProof.proofId,
      hostInstanceId: this.#hostInstanceId,
    });
    const preparation = new AbortController();
    this.#preparing.set(reservation.custodyId, preparation);
    try {
      if (reservation.startBoundaryCutoff) {throw new TypeError("Host start was cut off");}
      if (this.#preparation !== "current-owner") {
        const result = await this.#preparation.prepareClaimed({committedDispatchProof: input.committedDispatchProof,
          signal: preparation.signal, underlyingCustodyRef: reservation.underlyingCustodyRef});
        if (result.kind !== "prepared") {throw new TypeError("Host post-claim preparation is unavailable");}
      }
      if (preparation.signal.aborted || startWasCutOff(reservation)) {throw new TypeError("Host preparation was cut off");}
    } catch {
      await this.#contain(reservation, true);
      return kernelIndeterminate("post-claim-preparation", reservation);
    }
    let creatorCalled = false;
    let executionSettled = false;
    let observation!: Promise<StartObservation>;
    const execution: Promise<ContainedTurnKernelProviderObservation> = Promise.resolve().then(
      () => {
        if (reservation.startBoundaryCutoff) {throw new TypeError("Host execute arrived after cutoff");}
        return input.execute(Object.freeze({
        createProcess: <Process>(createProcess: () => Process): Process => {
          if (creatorCalled) {throw new TypeError("Host Custody delegated process creator is one-use");}
          if (reservation.startBoundaryCutoff) {
            throw new TypeError("Host Custody delegated process creator arrived after cutoff");
          }
          creatorCalled = true;
          return createProcess();
        },
        observation,
      }));},
    );
    void execution.then(
      value => {
        executionSettled = true;
        sealProviderCompletion(reservation, value); return;
      },
      () => {
        executionSettled = true;
        if (reservation.providerCompletionState === "pending") {
          reservation.providerCompletionState = "ambiguous";
        }
        return null;
      },
    );
    const hostObservation = observeHostStart({
      contain: () => this.#contain(reservation, true),
      creatorCalled: () => creatorCalled,
      cutoff: () => reservation.startBoundaryCutoff,
      evidence: () => this.#hostCustody.evidence(reservation.underlyingCustodyRef),
      executionSettled: () => executionSettled,
      monotonicNow: this.#monotonicNow,
      reservation,
      timeoutMs: this.#startObservationAfterMs,
    });
    observation = hostObservation.then(observed => {
      if (observed.kind === "execution_started") {
        return Object.freeze({
          kind: observed.kind, proof: createProcessStartProof(reservation, observed.evidence, {
            hostBootId: this.#hostBootId, hostInstanceId: this.#hostInstanceId,
          }),
        });
      }
      if (observed.kind === "proved_no_start") {
        return Object.freeze({
          kind: observed.kind, proof: createProcessNoStartProof(reservation, observed.evidence, {
            hostBootId: this.#hostBootId, hostInstanceId: this.#hostInstanceId,
          }),
        });
      }
      return Object.freeze({
        evidenceId: evidenceId(observed.source, Object.freeze({
          detail: observed.detail, proofDigest: reservation.proofDigest ?? null,
        })), kind: "indeterminate",
      });
    });
    const start = await observation;
    if (start.kind === "execution_started") {
      reservation.processStartProved = true;
      return Object.freeze({ execution, kind: "execution_started", proof: start.proof });
    }
    return start;
  }
  public async attestExecutionClosure(
    input: Parameters<ContainedTurnKernelCustodyPort["attestExecutionClosure"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["attestExecutionClosure"]> {
    const reservation = readKernelReservation(this.#reservations, input);
    const prior = reservation.executionAttestation;
    if (prior !== undefined) {
      return prior.finalCursor === input.finalCursor
        ? prior.result
        : kernelIndeterminate("execution-cursor-conflict", reservation);
    }
    const contained = await this.#contain(reservation, true);
    const observed = this.#hostCustody.evidence(reservation.underlyingCustodyRef);
    const completion = reservation.providerCompletion;
    if (observed === undefined || completion === undefined ||
        (contained === undefined && observed.closure.profile !== "cooperative-darwin-posix-process-group") ||
        reservation.providerCompletionState !== "sealed" || !reservation.processStartProved ||
        !executionEvidenceIsClosed(observed)) {
      return kernelIndeterminate("execution-closure", reservation, observed);
    }
    const result = createExecutionAttestation(reservation, observed, completion, contained, input.finalCursor);
    reservation.executionAttestation = Object.freeze({ finalCursor: input.finalCursor, result });
    return result;
  }
  public ensurePhysicalContainment(
    input: PhysicalInput,
  ): ReturnType<ContainedTurnKernelCustodyPort["ensurePhysicalContainment"]> {
    return this.#physicalContainment(input, true);
  }
  public queryPhysicalContainment(
    input: PhysicalInput,
  ): ReturnType<ContainedTurnKernelCustodyPort["queryPhysicalContainment"]> {
    return this.#physicalContainment(input, false);
  }
  async #physicalContainment(
    input: PhysicalInput,
    initiate: boolean,
  ): ReturnType<ContainedTurnKernelCustodyPort["ensurePhysicalContainment"]> {
    const reservation = readKernelReservation(this.#reservations, input);
    const proof = await this.#physicalProof(reservation, initiate);
    if (proof === undefined) {return kernelIndeterminate("physical-containment", reservation);}
    return Object.freeze({
      kind: "proved",
      proof,
      requestDigest: input.requestDigest,
      requestId: input.requestId,
    });
  }
  public attestContainment(
    input: ContainmentInput,
  ): ReturnType<ContainedTurnKernelCustodyPort["attestContainment"]> {
    return this.#attestContainment(input, true);
  }
  public queryContainmentAttestation(
    input: ContainmentInput,
  ): ReturnType<ContainedTurnKernelCustodyPort["queryContainmentAttestation"]> {
    return this.#attestContainment(input, false);
  }
  async #attestContainment(
    input: ContainmentInput,
    initiate: boolean,
  ): ReturnType<ContainedTurnKernelCustodyPort["attestContainment"]> {
    const reservation = readKernelReservation(this.#reservations, input);
    const contained = await this.#contain(reservation, initiate);
    const observed = this.#hostCustody.evidence(reservation.underlyingCustodyRef);
    if (contained === undefined || observed === undefined || !physicalEvidenceIsClosed(observed) ||
        reservation.physicalProof?.proofId !== input.binding.physicalContainmentProofId ||
        input.binding.attemptId !== reservation.attemptId ||
        input.binding.custodyId !== reservation.custodyId ||
        input.binding.effectId !== reservation.effectId ||
        input.binding.operationId !== reservation.operationId ||
        input.binding.hostBootId !== this.#hostBootId ||
        input.binding.hostInstanceId !== this.#hostInstanceId ||
        input.binding.authorityVectorDigest !== reservation.authorityVectorDigest) {
      return Object.freeze({
        evidenceId: evidenceId("containment-attestation", reservationIdentity(reservation)),
        kind: "identity_conflict",
      });
    }
    return Object.freeze({
      kind: "proved",
      proof: Object.freeze({
        binding: input.binding,
        kind: "containment",
        proofId: proofId("containment-attestation", Object.freeze({
          bindingDigest: canonicalDigest(Object.freeze({
            artifactManifestSealProofId: input.binding.artifactManifestSealProofId,
            custodyId: input.binding.custodyId,
            executionClosureProofId: input.binding.executionClosureProofId,
            outputDrainProofId: input.binding.outputDrainProofId,
            physicalContainmentProofId: input.binding.physicalContainmentProofId,
            terminalObservationProofId: input.binding.terminalObservationProofId,
          })),
          evidence: hostEvidenceProjection(observed),
          proofDigest: reservation.proofDigest ?? null,
          receiptRef: contained,
          reservation: reservationIdentity(reservation),
        })),
      }),
      requestDigest: input.requestDigest,
      requestId: input.requestId,
    });
  }
  async #contain(reservation: KernelReservation, initiate: boolean): Promise<string | undefined> {
    if (initiate) {reservation.startBoundaryCutoff = true; this.#preparing.get(reservation.custodyId)?.abort();}
    if (reservation.containmentReceiptRef !== undefined) {return reservation.containmentReceiptRef;}
    if (!initiate) {return undefined;}
    let outcome: Awaited<ReturnType<ProviderProcessCustodyPort["requestContainment"]>>;
    try {
      outcome = await this.#hostCustody.requestContainment({
        attemptId: reservation.attemptId,
        custodyRef: reservation.underlyingCustodyRef,
        operationId: reservation.operationId,
      });
    } catch {
      return undefined;
    }
    if (outcome.kind !== "contained") {return undefined;}
    reservation.containmentReceiptRef = outcome.receiptRef;
    return outcome.receiptRef;
  }
  public async releaseReservation(
    input: Parameters<ContainedTurnKernelCustodyPort["releaseReservation"]>[0],
  ): Promise<void> {
    if (this.#openAttempts.failedBeforeAcquisition(input) !== undefined) {return;}
    const reservation = readKernelReservation(this.#reservations, input);
    if (reservation.workspaceId !== input.workspaceId) {
      throw new TypeError("Host Custody reservation workspace identity conflict");
    }
    if (reservation.released) {return;}
    const receiptRef = await this.#contain(reservation, true);
    if (receiptRef === undefined) {
      throw new TypeError("Host Custody reservation containment is unproven");
    }
    const released = await this.#hostCustody.release({
      attemptId: reservation.attemptId,
      custodyRef: reservation.underlyingCustodyRef,
      operationId: reservation.operationId,
      receiptRef,
    });
    if (released.kind !== "released") {
      throw new TypeError("Host Custody reservation release is unproven");
    }
    reservation.released = true;
    this.#preparing.delete(reservation.custodyId);
    this.#attemptOwner.retire(reservation);
  }
  public async releaseRetiredReservation(
    input: Parameters<ContainedTurnKernelCustodyPort["releaseRetiredReservation"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["releaseRetiredReservation"]> {
    const failed = this.#openAttempts.failedBeforeAcquisition(input.cleanupPermit);
    if (failed !== undefined && failed.input.preparationToken === input.cleanupPermit.preparationToken &&
        failed.input.operationRevision === input.cleanupPermit.preparedOperationRevision &&
        failed.input.operationCutoffRevision === input.cleanupPermit.operationCutoffRevision) {
      return Object.freeze({ kind: "already_released" });
    }
    const reservation = this.#reservations.get(input.cleanupPermit.custodyId);
    if (reservation === undefined || !sameReservation(reservation, input.cleanupPermit) ||
        reservation.workspaceId !== input.cleanupPermit.workspaceId) {
      return Object.freeze({
        evidenceId: evidenceId("retired-reservation-missing", Object.freeze({
          attemptId: input.cleanupPermit.attemptId,
          custodyId: input.cleanupPermit.custodyId,
          operationId: input.cleanupPermit.operationId,
          workspaceId: input.cleanupPermit.workspaceId,
        })),
        kind: "indeterminate",
      });
    }
    if (reservation.released) {return Object.freeze({ kind: "already_released" });}
    try {
      await this.releaseReservation({
        attemptId: reservation.attemptId,
        custodyId: reservation.custodyId,
        operationId: reservation.operationId,
        reason: "claim_lost",
        workspaceId: reservation.workspaceId,
      });
      return Object.freeze({ kind: "released" });
    } catch {
      return kernelIndeterminate("retired-reservation-release", reservation);
    }
  }
  public async requestPhysicalContainment(
    input: Parameters<ContainedTurnKernelCustodyPort["requestPhysicalContainment"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["requestPhysicalContainment"]> {
    const reservation = readKernelReservation(this.#reservations, input);
    const proof = await this.#physicalProof(reservation, true);
    return proof === undefined
      ? kernelIndeterminate("physical-containment", reservation)
      : Object.freeze({ kind: "contained", proof });
  }
  async #physicalProof(
    reservation: KernelReservation,
    initiate: boolean,
  ): Promise<Extract<ContainedTurnProof, { readonly kind: "physical_containment" }> | undefined> {
    const contained = await this.#contain(reservation, initiate);
    const observed = this.#hostCustody.evidence(reservation.underlyingCustodyRef);
    if (contained === undefined || observed === undefined || !physicalEvidenceIsClosed(observed)) {return;}
    reservation.physicalProof ??= createPhysicalProof(reservation, observed, {
      hostBootId: this.#hostBootId, hostInstanceId: this.#hostInstanceId,
    }, contained);
    return reservation.physicalProof;
  }
  public async requestContainment(
    input: Parameters<ContainedTurnKernelCustodyPort["requestContainment"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["requestContainment"]> {
    const reservation = readKernelReservation(this.#reservations, input);
    await this.#contain(reservation, true);
    return kernelIndeterminate("composite-binding-required", reservation);
  }
}
