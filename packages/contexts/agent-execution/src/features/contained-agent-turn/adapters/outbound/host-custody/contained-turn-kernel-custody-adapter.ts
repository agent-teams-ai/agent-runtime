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
import {
  canonicalDigest,
  completionProjection,
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
type ExecutionAttestation = Extract<
  Awaited<ReturnType<ContainedTurnKernelCustodyPort["attestExecutionClosure"]>>,
  { readonly kind: "proved" }
>;
/**
 * Outer anti-corruption adapter from raw Host facts to the kernel proof port.
 * Provider protocol completion is sealed from the exact one-use execute promise;
 * operating-system exit status is never interpreted as a logical outcome.
 */
export class ContainedTurnKernelCustodyAdapter implements ContainedTurnKernelCustodyPort {
  readonly #completionAfterMs: number;
  readonly #hostBootId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostBootId"];
  readonly #hostCustody: ContainedTurnHostCustodyPort;
  readonly #hostInstanceId: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostInstanceId"];
  readonly #attemptOwner: ContainedTurnKernelCustodyAttemptOwner;
  readonly #workspaceOwner: ContainedTurnKernelWorkspaceOwner;
  readonly #monotonicNow: () => number;
  readonly #reservations = new Map<string, KernelReservation>();
  readonly #startObservationAfterMs: number;
  public constructor(
    hostCustody: ContainedTurnHostCustodyPort,
    options: ContainedTurnKernelCustodyAdapterOptions,
  ) {
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
    return this.#workspaceOwner.withLaunchAuthority({
      attemptId: input.attemptId,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
    }, authority => this.#openScoped(input, authority));
  }
  async #openScoped(
    input: KernelOpenInput,
    workspaceAuthority: HostCustodyReservationInput["workspaceAuthority"],
  ): ReturnType<ContainedTurnKernelCustodyPort["open"]> {
    if (workspaceAuthority.canonicalPath.length === 0 || workspaceAuthority.descriptorPath.length === 0 ||
        workspaceAuthority.identity.mountId.length === 0 || input.intentMode !== "analysis" && input.intentMode !== "workspace-write") {
      throw new TypeError("Host Custody scoped workspace authority is unavailable");
    }
    const providerBinding = this.#providerBinding(input);
    const plan = await this.#attemptOwner.prepare({ kernel: input, providerBinding, workspaceAuthority });
    const authority = Object.freeze({ intentMode: input.intentMode, workspaceRef: workspaceAuthority.canonicalPath });
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
      processStartProved: false,
      providerCompletionState: "pending",
      released: false,
      startBoundaryCutoff: false,
      started: false,
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
    return openKernelCompletionBoundary(input, this.#reservation(input), this.#completionAfterMs);
  }
  public async start(input: StartInput): ReturnType<ContainedTurnKernelCustodyPort["start"]> {
    const reservation = this.#reservation(input);
    if (reservation.started) {throw new TypeError("Host Custody start authority was already consumed");}
    if (typeof input.startAuthority !== "string" || input.startAuthority.length === 0) {
      throw new TypeError("Host Custody start authority is unavailable");}
    if (reservation.workspaceId !== input.workspaceId || reservation.intentMode !== input.intent.mode) {
      throw new TypeError("Host Custody start identity conflict");}
    reservation.startIdentityDigest = canonicalDigest(Object.freeze({
      intentMode: input.intent.mode, startAuthorityDigest: canonicalDigest(input.startAuthority),
      workspaceId: input.workspaceId,
    }));
    reservation.started = true;
    let creatorCalled = false;
    let executionSettled = false;
    let observation!: Promise<StartObservation>;
    const execution: Promise<ContainedTurnKernelProviderObservation> = Promise.resolve().then(
      () => input.execute(Object.freeze({
        createProcess: <Process>(createProcess: () => Process): Process => {
          if (creatorCalled) {throw new TypeError("Host Custody delegated process creator is one-use");}
          if (reservation.startBoundaryCutoff) {
            throw new TypeError("Host Custody delegated process creator arrived after cutoff");
          }
          creatorCalled = true;
          return createProcess();
        },
        observation,
      })),
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
        evidenceId: evidenceId(observed.source, observed.detail), kind: "indeterminate",
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
        startIdentityDigest: reservation.startIdentityDigest ?? null,
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
    if (contained === undefined || observed === undefined || completion === undefined ||
        reservation.providerCompletionState !== "sealed" || !reservation.processStartProved ||
        !executionEvidenceIsClosed(observed)) {
      return this.#indeterminate("execution-closure", reservation, observed);
    }
    const binding = Object.freeze({
      attemptId: reservation.attemptId,
      authorityVectorDigest: reservation.authorityVectorDigest,
      effectId: reservation.effectId,
      operationId: reservation.operationId,
    });
    const closureProjection = Object.freeze({
      completion: completionProjection(completion),
      evidence: hostEvidenceProjection(observed),
      receiptRef: contained,
      reservation: reservationIdentity(reservation),
    });
    const result: ExecutionAttestation = Object.freeze({
      executionClosureProof: Object.freeze({
        binding: Object.freeze({ ...binding, outcome: completion.outcome }),
        kind: "execution_closure",
        proofId: proofId("execution-closure", closureProjection),
      }),
      kind: "proved",
      outputDrainProof: Object.freeze({
        binding: Object.freeze({ ...binding, finalCursor: input.finalCursor }),
        kind: "output_drain",
        proofId: proofId("output-drain", Object.freeze({
          closure: closureProjection,
          finalCursor: input.finalCursor,
        })),
      }),
      terminalObservationProof: Object.freeze({
        binding: Object.freeze({ ...binding, outcome: completion.outcome }),
        kind: "provider_terminal_observation",
        proofId: proofId("terminal-observation", closureProjection),
      }),
    });
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
          receiptRef: contained,
          reservation: reservationIdentity(reservation),
        })),
      }),
      requestDigest: input.requestDigest,
      requestId: input.requestId,
    });
  }
  async #contain(reservation: KernelReservation, initiate: boolean): Promise<string | undefined> {
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
    this.#attemptOwner.retire(reservation);
  }
  public async releaseRetiredReservation(
    input: Parameters<ContainedTurnKernelCustodyPort["releaseRetiredReservation"]>[0],
  ): ReturnType<ContainedTurnKernelCustodyPort["releaseRetiredReservation"]> {
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
        providerCompletionState: reservation.providerCompletionState,
        reservation: reservationIdentity(reservation),
      })),
      kind: "indeterminate",
    });
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
