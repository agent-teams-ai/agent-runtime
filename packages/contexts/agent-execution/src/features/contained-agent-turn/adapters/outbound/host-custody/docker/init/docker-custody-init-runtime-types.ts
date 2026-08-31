import type {
  DockerCustodyChildSignal,
  DockerCustodyContainmentRequest,
  DockerCustodyHostSignal,
  DockerCustodyIdentity,
  DockerCustodyInitClosureSubresult,
  DockerCustodyInitMessage,
  DockerCustodyProviderObservation,
  DockerCustodySignalObservation,
} from "./docker-custody-init-protocol.js";

export type DockerCustodyOutputStream = "stderr" | "stdout";
export interface DockerCustodyProviderRootExit {readonly exitCode: number | null; readonly signal: DockerCustodyChildSignal | null;}
declare const dockerCustodyProviderRootHandle: unique symbol;
/** Nominal direct-child capability bound to one observed ChildProcess generation. */
export interface DockerCustodyProviderRootHandle {readonly [dockerCustodyProviderRootHandle]: never;}
declare const dockerCustodyProviderOutputHandle: unique symbol;
export interface DockerCustodyProviderOutputHandle {readonly [dockerCustodyProviderOutputHandle]: never;}
export interface DockerCustodyProviderSpawn {
  readonly argv: readonly string[]; readonly clearSupplementaryGroups: true;
  readonly environment: Readonly<Record<string, string>>; readonly executablePath: string;
  readonly gid: number; readonly inheritedDescriptors: readonly [0, 1, 2]; readonly noNewPrivileges: true;
  readonly shell: false; readonly uid: number;
}
export interface DockerCustodyReapedDescendant extends DockerCustodyProviderRootExit {readonly pid: number;}
export interface DockerCustodyOutputWriteResult {readonly committedBytes: number; readonly status: "accepted" | "blocked";}
export interface DockerCustodyInitSyscalls {
  readonly assertNoNewPrivileges: () => void;
  readonly assertDirectChildOfContainerInit: () => void;
  readonly closeProviderInput: () => void;
  readonly monotonicNowMs: () => number;
  readonly observeProviderRootExit: (handle: DockerCustodyProviderRootHandle) => DockerCustodyProviderRootExit | null;
  readonly observeIdentity: () => DockerCustodyIdentity;
  readonly reapExitedDescendants: () => readonly DockerCustodyReapedDescendant[];
  readonly requestContainerContainment: (reason: DockerCustodyContainmentRequest["reason"]) => "accepted" | "failed";
  readonly signalProviderRoot: (handle: DockerCustodyProviderRootHandle, signal: DockerCustodyHostSignal | "SIGKILL") => "absent" | "sent";
  readonly spawnProvider: (spawn: DockerCustodyProviderSpawn) =>
    | {readonly kind: "not-started"}
    | {readonly handle: DockerCustodyProviderRootHandle; readonly kind: "started"; readonly pid: number;
      readonly stderr: DockerCustodyProviderOutputHandle; readonly stdout: DockerCustodyProviderOutputHandle;};
  readonly wallNowUnixMs: () => number;
  readonly writeProviderInput: (bytes: Uint8Array) => "accepted" | "blocked" | "closed";
  readonly writeProviderOutput: (stream: DockerCustodyOutputStream, bytes: Uint8Array) => DockerCustodyOutputWriteResult;
}
export interface DockerCustodyInitRuntimeOptions {
  readonly allowedEnvironmentNames: readonly string[]; readonly executablePath: string; readonly executableSha256: string;
  readonly maximumStderrBytes: number; readonly maximumStdinBytes: number; readonly maximumStdoutBytes: number;
  readonly maximumProviderRuntimeMs: number; readonly observedIdentity: DockerCustodyIdentity; readonly shutdownGraceMs: number;
  readonly syscalls: DockerCustodyInitSyscalls;
  readonly writeControl: (message: DockerCustodyInitMessage) => "accepted" | "blocked";
}
export interface DockerCustodyStreamEvidence {
  readonly bytes: number; readonly eof: boolean; readonly sha256: string; readonly status: "blocked" | "open" | "overflow";
}
export interface DockerCustodyInitSnapshot {
  readonly acknowledgement: "delivered" | "lost" | "not-applicable" | "pending"; readonly closure: DockerCustodyInitClosureSubresult | null;
  readonly containmentRequested: boolean; readonly descendantsReaped: number;
  readonly phase: "awaiting-handshake" | "awaiting-request" | "drained" | "failed" | "provider-exited" | "provider-running" | "stopping";
  readonly providerRootTracked: boolean; readonly requestId: string | null; readonly signalEvidence: readonly DockerCustodySignalObservation[];
  readonly startFenced: boolean; readonly stderr: DockerCustodyStreamEvidence; readonly stdinBytes: number;
  readonly stdinStatus: "blocked" | "closed" | "open" | "overflow"; readonly stdout: DockerCustodyStreamEvidence;
}

export type DockerCustodyObservationKind = DockerCustodyProviderObservation["observation"];
