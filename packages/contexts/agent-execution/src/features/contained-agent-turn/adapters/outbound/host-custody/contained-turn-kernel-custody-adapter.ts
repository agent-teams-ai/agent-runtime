import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import type {
  ContainedTurnKernelCustodyPort,
  ContainedTurnKernelProviderObservation,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  HostCustodyEvidence,
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
  projectProviderObservation,
  proofId,
  reservationIdentity,
  type SealedProviderCompletion,
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
interface KernelOpenAttempt {
  readonly input: KernelOpenInput;
  closed: boolean;
  acquisitionPossible: boolean;
  failedBeforeAcquisition: boolean;
}
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
  readonly #preparation: ContainedTurnKernelCustodyAdapterOptions["postClaimPreparation"];
  readonly #preparing = new Map<string, AbortController>();
  readonly #completionAfterMs: number;
  readonly #hostBootId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostBootId"];
  readonly #hostCustody: ContainedTurnHostCustodyPort;
  readonly #hostInstanceId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostInstanceId"];
  readonly #attemptOwner: ContainedTurnKernelCustodyAttemptOwner;
  readonly #workspaceOwner: ContainedTurnKernelWorkspaceOwner;
  readonly #monotonicNow: () => number;
  readonly #openAttempts = new Map<string, KernelOpenAttempt>();
  readonly #reservations = new Map<string, KernelReservation>();
  readonly #startObservationAfterMs: number;
  public constructor(
    hostCustody: ContainedTurnHostCustodyPort,
    options: ContainedTurnKernelCustodyAdapterOptions,
  ) {
    const preparation = options.postClaimPreparation;
    if (preparation !== "current-owner" && typeof preparation?.prepareClaimed !== "function") {
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
  public async open(input: KernelOpenInput): ReturnType<ContainedTurnKernelCustodyPort["open"]> {
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
    // Keep failed identities fenced for this owner lifetime: absence is not proof,
    // and a duplicate call must never race preparation or resurrect acquisition.
    if (this.#openAttempts.has(input.custodyId) || [...this.#openAttempts.values()].some(
      prior => prior.input.attemptId === input.attemptId && prior.input.operationId === input.operationId,
    )) {
      throw new TypeError("Host Custody kernel open attempt is already consumed");
    }
    input = Object.freeze({ ...input, adapterSnapshot: Object.freeze({ ...input.adapterSnapshot }),
      providerAccessSnapshot: Object.freeze({ ...input.providerAccessSnapshot }) });
    const attempt: KernelOpenAttempt = {
      input, closed: false, acquisitionPossible: false, failedBeforeAcquisition: false,
    };
    this.#openAttempts.set(input.custodyId, attempt);
    let scoped: ReturnType<ContainedTurnKernelCustodyPort["open"]> | undefined;
    try {
      return await this.#workspaceOwner.withLaunchAuthority({
        attemptId: input.attemptId, operationId: input.operationId, workspaceId: input.workspaceId,
      }, authority => {
        if (attempt.closed || scoped !== undefined) {
          throw new TypeError("Host Custody workspace authority is already consumed");
        }
        scoped = this.#openScoped(input, authority, attempt);
        return scoped;
      });
    } catch (error) {
      attempt.closed = true;
      // A workspace owner can reject while its callback is still preparing.
      // Fence raw acquisition and wait for preparation before retiring its record.
      await scoped?.catch(() => {});
      if (!attempt.acquisitionPossible) {
        this.#attemptOwner.retire(input);
        attempt.failedBeforeAcquisition = true;
      }
      throw error;
    } finally {
      attempt.closed = true;
    }
  }
  async #openScoped(
    input: KernelOpenInput,
    workspaceAuthority: HostCustodyReservationInput["workspaceAuthority"],
    attempt: KernelOpenAttempt,
  ): ReturnType<ContainedTurnKernelCustodyPort["open"]> {
    if (workspaceAuthority.canonicalPath.length === 0 || workspaceAuthority.descriptorPath.length === 0 ||
        workspaceAuthority.identity.mountId.length === 0 || input.intentMode !== "analysis" && input.intentMode !== "workspace-write") {
      throw new TypeError("Host Custody scoped workspace authority is unavailable");
    }
    const providerBinding = this.#providerBinding(input);
    const plan = await this.#attemptOwner.prepare({ kernel: input, providerBinding, workspaceAuthority });
    const authority = Object.freeze({ intentMode: input.intentMode, workspaceRef: workspaceAuthority.canonicalPath });
    if (attempt.closed) {throw new TypeError("Host Custody open was cut off before acquisition");}
    // From this point even a rejected or malformed raw response may own resources.
    attempt.acquisitionPossible = true;
    return this.#reserve(input, authority, providerBinding, plan, workspaceAuthority);
  }
  #providerBinding(input: KernelOpenInput): HostCustodyReservationInput["providerBinding"] {
    return Object.freeze({
      adapterRevision: input.adapterSnapshot.adapterRevision,
      binaryRevision: input.adapterSnapshot.binaryRevision,
      capabilityManifestRevision: input.adapterSnapshot.capabilityManifestRevision,
      credentialBindingDigest: input.providerAccessSnapshot.credentialBindingDigest,
      provider: input.adapterSnapshot.provider,
      providerRouteRef: input.providerAccessSnapshot.providerRouteRef,
    });
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
  #recordReservation(
    input: KernelOpenInput,
    authority: ContainedTurnKernelCustodyLaunchAuthority,
    identityDigest: ReturnType<typeof openIdentity>,
    custodyRef: string,
  ): Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>> {
    const reservation: KernelReservation = {
      attemptId: input.attemptId,
      authorityVectorDigest: input.authorityVectorDigest,
      commandId: input.commandId,
      custodyId: input.custodyId,
      effectId: input.effectId,
      executionBoundaryOpened: false,
      intentMode: authority.intentMode,
      kernelOpenIdentityDigest: openIdentity(input, {
        intentMode: input.intentMode,
        workspaceRef: "owner-private-workspace-not-reconsumed",
      }),
      openIdentityDigest: identityDigest,
      operationId: input.operationId,
      operationCutoffRevision: input.operationCutoffRevision,
      operationRevision: input.operationRevision,
      preparationToken: input.preparationToken,
      projectId: input.providerAccessSnapshot.projectId,
      processStartProved: false,
      providerCompletionState: "pending",
      provider: input.adapterSnapshot.provider,
      released: false,
      startBoundaryCutoff: false,
      started: false,
      tenantId: input.providerAccessSnapshot.tenantId,
      underlyingCustodyRef: custodyRef,
      workspaceId: input.workspaceId,
    };
    this.#reservations.set(input.custodyId, reservation);
    return this.#openOutcome(reservation);
  }
  #openOutcome(
    reservation: KernelReservation,
  ): Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>> {
    return Object.freeze({
      custodyId: reservation.custodyId,
      hostBootId: this.#hostBootId,
      hostCustodyProof: Object.freeze({
        binding: Object.freeze({
          attemptId: reservation.attemptId,
          authorityVectorDigest: reservation.authorityVectorDigest,
          custodyId: reservation.custodyId,
          effectId: reservation.effectId,
          operationId: reservation.operationId,
        }),
        kind: "host_custody",
        proofId: proofId("reservation", Object.freeze({
          openIdentityDigest: reservation.openIdentityDigest,
          underlyingCustodyRefDigest: canonicalDigest(reservation.underlyingCustodyRef),
        })),
      }),
      hostInstanceId: this.#hostInstanceId,
    });
  }
  public completionBoundary(
    input: Parameters<ContainedTurnKernelCustodyPort["completionBoundary"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["completionBoundary"]> {
    const boundary = openKernelCompletionBoundary(input, this.#reservation(input), this.#completionAfterMs);
    if (input.phase === "start") {void boundary.expiration.then(() => {this.#preparing.get(input.custodyId)?.abort(); return null;});}
    return boundary;
  }
  public async start(input: StartInput): ReturnType<ContainedTurnKernelCustodyPort["start"]> {
    const reservation = this.#reservation(input);
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
      if (preparation.signal.aborted || reservation.startBoundaryCutoff) {throw new TypeError("Host preparation was cut off");}
    } catch {
      await this.#contain(reservation, true);
      return this.#indeterminate("post-claim-preparation", reservation);
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
        return this.#sealProviderCompletion(reservation, value);
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
          kind: observed.kind, proof: this.#processStartProof(reservation, observed.evidence),
        });
      }
      if (observed.kind === "proved_no_start") {
        return Object.freeze({
          kind: observed.kind, proof: this.#processNoStartProof(reservation, observed.evidence),
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
  #sealProviderCompletion(reservation: KernelReservation, value: unknown): void {
    if (reservation.providerCompletionState !== "pending") {return;}
    const projected = projectProviderObservation(value);
    if (projected.kind !== "completed") {
      reservation.providerCompletionState = "ambiguous";
      return;
    }
    const completion: SealedProviderCompletion = Object.freeze({
      digest: canonicalDigest(Object.freeze({
        ...reservationIdentity(reservation),
        outcome: projected.outcome,
        proofDigest: reservation.proofDigest ?? null,
      })),
      outcome: projected.outcome,
    });
    reservation.providerCompletion = completion;
    reservation.providerCompletionState = "sealed";
  }
  #processStartProof(reservation: KernelReservation, evidence: HostCustodyEvidence): StartProof {
    return createProcessStartProof(reservation, evidence, {
      hostBootId: this.#hostBootId, hostInstanceId: this.#hostInstanceId,
    });
  }
  #processNoStartProof(reservation: KernelReservation, evidence: HostCustodyEvidence): NoStartProof {
    return createProcessNoStartProof(reservation, evidence, {
      hostBootId: this.#hostBootId, hostInstanceId: this.#hostInstanceId,
    });
  }
  public async attestExecutionClosure(
    input: Parameters<ContainedTurnKernelCustodyPort["attestExecutionClosure"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["attestExecutionClosure"]> {
    const reservation = this.#reservation(input);
    const prior = reservation.executionAttestation;
    if (prior !== undefined) {
      return prior.finalCursor === input.finalCursor
        ? prior.result
        : this.#indeterminate("execution-cursor-conflict", reservation);
    }
    const contained = await this.#contain(reservation, true);
    const observed = this.#hostCustody.evidence(reservation.underlyingCustodyRef);
    const completion = reservation.providerCompletion;
    if (observed === undefined || completion === undefined ||
        (contained === undefined && observed.closure.profile !== "cooperative-darwin-posix-process-group") ||
        reservation.providerCompletionState !== "sealed" || !reservation.processStartProved ||
        !executionEvidenceIsClosed(observed)) {
      return this.#indeterminate("execution-closure", reservation, observed);
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
    const reservation = this.#reservation(input);
    const proof = await this.#physicalProof(reservation, initiate);
    if (proof === undefined) {return this.#indeterminate("physical-containment", reservation);}
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
    const reservation = this.#reservation(input);
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
    if (this.#failedBeforeAcquisition(input) !== undefined) {return;}
    const reservation = this.#reservation(input);
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
    const failed = this.#failedBeforeAcquisition(input.cleanupPermit);
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
      return this.#indeterminate("retired-reservation-release", reservation);
    }
  }
  public async requestPhysicalContainment(
    input: Parameters<ContainedTurnKernelCustodyPort["requestPhysicalContainment"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["requestPhysicalContainment"]> {
    const reservation = this.#reservation(input);
    const proof = await this.#physicalProof(reservation, true);
    return proof === undefined
      ? this.#indeterminate("physical-containment", reservation)
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
    const reservation = this.#reservation(input);
    await this.#contain(reservation, true);
    return this.#indeterminate("composite-binding-required", reservation);
  }
  #indeterminate(
    source: string,
    reservation: KernelReservation,
    evidence?: HostCustodyEvidence,
  ): {
    readonly evidenceId: ReturnType<typeof evidenceId>;
    readonly kind: "indeterminate";
  } {
    return Object.freeze({
      evidenceId: evidenceId(source, Object.freeze({
        evidence: evidence === undefined ? null : hostEvidenceProjection(evidence),
        proofDigest: reservation.proofDigest ?? null,
        providerCompletionState: reservation.providerCompletionState,
        reservation: reservationIdentity(reservation),
      })),
      kind: "indeterminate",
    });
  }
  #failedBeforeAcquisition(
    input: Readonly<{ attemptId: string; custodyId: string; operationId: string; workspaceId: string }>,
  ): KernelOpenAttempt | undefined {
    const attempt = this.#openAttempts.get(input.custodyId);
    return attempt?.failedBeforeAcquisition === true && attempt.input.attemptId === input.attemptId &&
      attempt.input.operationId === input.operationId &&
      attempt.input.workspaceId === input.workspaceId ? attempt : undefined;
  }
  #reservation(
    input: Readonly<{ readonly attemptId: string; readonly custodyId: string; readonly operationId: string }>,
  ): KernelReservation {
    const reservation = this.#reservations.get(input.custodyId);
    if (reservation === undefined || !sameReservation(reservation, input)) {
      throw new TypeError("Host Custody kernel reservation is unavailable");
    }
    return reservation;
  }
}
export const createContainedTurnKernelCustodyPort = (
  hostCustody: ContainedTurnHostCustodyPort,
  options: ContainedTurnKernelCustodyAdapterOptions,
): ContainedTurnKernelCustodyPort =>
  new ContainedTurnKernelCustodyAdapter(hostCustody, options);
