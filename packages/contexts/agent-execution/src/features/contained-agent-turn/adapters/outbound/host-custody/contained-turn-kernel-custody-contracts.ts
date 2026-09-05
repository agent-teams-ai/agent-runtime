import type { CommittedDispatchProofV1 } from "../../../domain/committed-dispatch-proof-v1.js";
import type {
  ContainedTurnKernelCustodyPort,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  HostCustodyEvidenceRegistry,
  HostCustodyLaunchPlan,
  HostCustodyReservationInput,
  ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";

export interface ContainedTurnHostCustodyPort
  extends ProviderProcessCustodyPort, HostCustodyEvidenceRegistry {
  reserve(input: HostCustodyReservationInput): ReturnType<ProviderProcessCustodyPort["open"]>;
}

export type KernelOpenInput = Parameters<ContainedTurnKernelCustodyPort["open"]>[0];

export interface ContainedTurnKernelWorkspaceOwner {
  withLaunchAuthority<Result>(input: Readonly<{
    operationId: KernelOpenInput["operationId"];
    workspaceId: KernelOpenInput["workspaceId"];
    attemptId: KernelOpenInput["attemptId"];
  }>, consume: (target: Readonly<{
    canonicalPath: string;
    descriptorPath: string;
    identity: Readonly<{ dev: bigint; ino: bigint; mountId: string }>;
  }>) => Promise<Result>): Promise<Result>;
}

export interface ContainedTurnKernelCustodyAttemptOwner {
  prepare(input: Readonly<{
    kernel: KernelOpenInput;
    providerBinding: HostCustodyReservationInput["providerBinding"];
    workspaceAuthority: HostCustodyReservationInput["workspaceAuthority"];
  }>): Promise<HostCustodyLaunchPlan>;
  retain(input: Readonly<{
    kernel: KernelOpenInput;
    underlyingCustodyRef: string;
    workspaceRef: string;
  }>): void;
  retire(input: Readonly<{ attemptId: string; custodyId: string; operationId: string }>): void;
}

/** Host-private capability: register pending cleanup before effects and honor irreversible signal cutoff.
 * Only the fresh owner-acknowledged proof reaches this method; replay cannot reconstruct it.
 * Missing network, broker, durable journal or authority owners must return unsupported before allocation.
 */
export interface ContainedTurnHostPostClaimPreparation {
  prepareClaimed(input: Readonly<{
    committedDispatchProof: CommittedDispatchProofV1;
    signal: AbortSignal;
    underlyingCustodyRef: string;
  }>): Promise<
    | Readonly<{kind: "prepared"}>
    | Readonly<{kind: "unsupported"; reason: "network" | "broker" | "journal" | "owner"}>
    | Readonly<{kind: "quarantined"}>
  >;
}

export interface ContainedTurnKernelCustodyAdapterOptions {
  /** Explicit legacy current-owner semantics carry no Docker readiness claim. */
  readonly postClaimPreparation: "current-owner" | ContainedTurnHostPostClaimPreparation;
  readonly completionAfterMs?: number;
  readonly hostBootId: string;
  readonly hostInstanceId: string;
  readonly attemptOwner: ContainedTurnKernelCustodyAttemptOwner;
  readonly workspaceOwner: ContainedTurnKernelWorkspaceOwner;
  readonly monotonicNow?: () => number;
  readonly startObservationAfterMs?: number;
}
