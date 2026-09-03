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

export interface ContainedTurnKernelCustodyAdapterOptions {
  readonly completionAfterMs?: number;
  readonly hostBootId: string;
  readonly hostInstanceId: string;
  readonly attemptOwner: ContainedTurnKernelCustodyAttemptOwner;
  readonly workspaceOwner: ContainedTurnKernelWorkspaceOwner;
  readonly monotonicNow?: () => number;
  readonly startObservationAfterMs?: number;
}
