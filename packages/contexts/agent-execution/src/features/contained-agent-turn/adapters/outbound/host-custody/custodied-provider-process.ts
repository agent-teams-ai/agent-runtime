import type { ContainedTurnProviderBinding } from "../../../contracts/contained-agent-turn.js";

export interface CustodiedProviderProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface CustodiedProviderProcess {
  readonly custodyRef: string;
  readonly workspaceAuthorityPath: string;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly stdout: AsyncIterable<Uint8Array>;
  closeInput(): Promise<void>;
  waitForExit(): Promise<CustodiedProviderProcessExit>;
  write(bytes: Uint8Array): Promise<void>;
}

export interface CustodiedProviderProcessRegistry {
  get(custodyRef: string): CustodiedProviderProcess | undefined;
}

/** Host-owned verification seam for adapter-private directory projections. */
export interface PrivateDirectoryCustodyPort {
  assertPrivateDirectory(path: string): Promise<void>;
}

/** Host-owned reservation surface consumed only through outer custody adapters. */
export interface ContainedTurnCustodyHandle {
  readonly custodyRef: string;
}

export interface ProviderProcessCustodyPort {
  open(input: {
    readonly attemptId: string;
    readonly intentMode: "analysis" | "workspace-write";
    readonly operationId: string;
    readonly providerBinding: ContainedTurnProviderBinding;
    readonly workspaceRef: string;
  }): Promise<ContainedTurnCustodyHandle>;
  requestContainment(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
  }): Promise<
    | { readonly kind: "contained"; readonly receiptRef: string }
    | { readonly evidenceRef: string; readonly kind: "unproven" }
  >;
  release(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
    readonly receiptRef: string;
  }): Promise<
    | { readonly kind: "released" }
    | { readonly evidenceRef: string; readonly kind: "unproven" }
  >;
}

export interface HostCustodyDrainEvidence {
  readonly bytes: number;
  readonly sha256: string;
  readonly status: "complete" | "error" | "incomplete" | "not-started" | "overflow";
}

export interface HostCustodyLaunchFingerprintEvidence {
  readonly binaryRevision: string;
  readonly containmentProfile: HostCustodyContainmentProfile;
  readonly environmentKeys: readonly string[];
  readonly executablePathSha256: string;
  readonly fingerprintSha256: string;
  readonly intentMode: "analysis" | "workspace-write";
  readonly argumentsSha256: string;
  readonly executableSha256: string;
  readonly planSha256: string;
  readonly privatePathEnvironmentKeys: readonly string[];
  readonly privateRootPathSha256: string;
  readonly providerBindingSha256: string;
  readonly spawnMode: "eager" | "sdk-delegated";
  readonly workspaceSha256: string;
}

export interface HostCustodyProcessIdentityEvidence {
  readonly binarySha256: string;
  readonly childProcessInstanceSha256: string;
  readonly hostLifecycleGenerationSha256: string;
  readonly pgid?: number;
  readonly pid?: number;
  readonly planSha256: string;
  readonly proofRef?: string;
  readonly status: "ambiguous" | "not-started" | "proved" | "unproven";
}

export interface HostCustodyStrictClosureEvidence {
  readonly limitations: readonly [];
  readonly profile: "strict-linux-cgroup-v2";
  readonly status: "closed" | "not-started" | "unproven";
}

export const DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS = Object.freeze([
  "canonical-executable-path-is-name-bound-at-spawn",
  "canonical-workspace-path-is-name-bound-at-spawn",
  "private-environment-paths-are-name-bound-at-spawn",
  "descendant-may-escape-via-new-session",
] as const);

export type HostCustodyContainmentProfile =
  | "strict-linux-cgroup-v2"
  | "cooperative-darwin-posix-process-group";

export interface HostCustodyCooperativeClosureEvidence {
  readonly limitations: typeof DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS;
  readonly profile: "cooperative-darwin-posix-process-group";
  readonly status: "closed" | "not-started" | "unproven";
}

export type HostCustodyClosureEvidence =
  | HostCustodyStrictClosureEvidence
  | HostCustodyCooperativeClosureEvidence;

export interface HostCustodyPrivateRootClosureEvidence {
  readonly identitySha256: string;
  readonly status: "active" | "deleted" | "quarantined" | "unproven";
}

export type HostCustodyGuardianExitEvidence =
  | { readonly status: "unobserved" }
  | { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly status: "observed" };

export type HostCustodyProviderExitEvidence =
  | { readonly status: "not-started" | "unobserved" }
  | { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly status: "observed" };

export interface HostCustodyEvidence {
  readonly closure: HostCustodyClosureEvidence;
  readonly fingerprint: HostCustodyLaunchFingerprintEvidence;
  readonly guardianExit: HostCustodyGuardianExitEvidence;
  readonly identity: HostCustodyProcessIdentityEvidence;
  readonly privateRoot: HostCustodyPrivateRootClosureEvidence;
  readonly providerExit: HostCustodyProviderExitEvidence;
  readonly sealed: boolean;
  readonly spawn: "acknowledged" | "ambiguous" | "error-before-start" | "never-started";
  readonly stderr: HostCustodyDrainEvidence;
  readonly stdout: HostCustodyDrainEvidence;
}

export interface HostCustodyEvidenceRegistry {
  evidence(custodyRef: string): HostCustodyEvidence | undefined;
}

export interface HostCustodyProcessIdentityProof {
  readonly child: object;
  readonly childProcessInstanceSha256: string;
  readonly pgid: number;
  readonly pid: number;
  readonly proofRef: string;
  readonly status: "proved";
}

export interface HostCustodyProcessIdentityObserver {
  observe(input: {
    readonly binarySha256: string;
    readonly child: object;
    readonly childProcessInstanceSha256: string;
    readonly hostLifecycleGenerationSha256: string;
    readonly pgid: number;
    readonly pid: number;
    readonly planSha256: string;
  }): Promise<HostCustodyProcessIdentityProof | { readonly status: "ambiguous" | "unproven" }>;
}

export type HostCustodySpawnAcknowledgement =
  | {
      readonly child: object;
      readonly childProcessInstanceSha256: string;
      readonly pgid: number;
      readonly pid: number;
      readonly status: "acknowledged";
    }
  | {
      readonly child: object;
      readonly childProcessInstanceSha256: string;
      readonly status: "error-before-start";
    }
  | { readonly status: "ambiguous" };

export interface CustodiedSdkProcess {
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly signalCode?: NodeJS.Signals | null;
  readonly stdin: unknown;
  readonly stdout: unknown;
  kill(signal: NodeJS.Signals): boolean;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface CustodiedSdkProcessLauncher {
  start(custodyRef: string, input: {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly cwd: string | undefined;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }): CustodiedSdkProcess;
}

export interface HostCustodyLaunchPlan {
  readonly arguments: readonly string[];
  readonly binaryRevision: string;
  readonly containmentProfile: HostCustodyContainmentProfile;
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly privateRootPath: string;
  readonly privatePathEnvironmentKeys?: readonly string[];
  readonly intentMode: "analysis" | "workspace-write";
  readonly provider: string;
  readonly spawnMode?: "eager" | "sdk-delegated";
}

export interface HostCustodyLaunchPlanResolver {
  resolve(input: {
    readonly intentMode: "analysis" | "workspace-write";
    readonly providerBinding: ContainedTurnProviderBinding;
    readonly workspaceRef: string;
  }): Promise<HostCustodyLaunchPlan | undefined>;
}

/** Private reservation handoff from the filesystem owner to raw Host Custody. */
export interface HostCustodyWorkspaceAuthority {
  readonly canonicalPath: string;
  readonly descriptorPath: string;
  readonly identity: Readonly<{ readonly dev: bigint; readonly ino: bigint; readonly mountId: string }>;
}

export type HostCustodyReservationInput = Readonly<
  Parameters<ProviderProcessCustodyPort["open"]>[0] & {
    readonly launchPlan: HostCustodyLaunchPlan;
    readonly workspaceAuthority: HostCustodyWorkspaceAuthority;
  }
>;

export type HostCustodyUnsupportedCode =
  | "launch-plan-unavailable"
  | "platform-profile-unavailable"
  | "linux-cgroup-v2-unavailable"
  | "procfs-profile-unavailable"
  | "retention-capacity-exhausted";

const unsupportedMessages: Readonly<Record<HostCustodyUnsupportedCode, string>> = Object.freeze({
  "launch-plan-unavailable": "No exact Host Custody launch plan is available",
  "platform-profile-unavailable": "No qualified Host Custody profile is available for this platform",
  "linux-cgroup-v2-unavailable": "The qualified Linux cgroup v2 custody profile is unavailable",
  "procfs-profile-unavailable": "The qualified Host Custody procfs profile is unavailable",
  "retention-capacity-exhausted": "Host Custody retention capacity is exhausted",
});

export class HostCustodyUnsupportedError extends Error {
  public readonly code: HostCustodyUnsupportedCode;
  public readonly evidenceRef?: string;
  public readonly status = "unsupported" as const;
  public constructor(code: HostCustodyUnsupportedCode, evidenceRef?: string) {
    const knownCode = Object.hasOwn(unsupportedMessages, code)
      ? code
      : "platform-profile-unavailable";
    super(unsupportedMessages[knownCode]);
    this.name = "HostCustodyUnsupportedError";
    this.code = knownCode;
    if (evidenceRef !== undefined && /^urn:agent-runtime:host-custody-[a-z-]+:[a-f0-9]{64}$/u.test(evidenceRef)) {
      this.evidenceRef = evidenceRef;
    }
  }
}

export class HostCustodyLaunchRejectedError extends Error {
  public readonly code: "authority-verification-failed" | "guardian-launch-failed";
  public readonly status = "rejected" as const;

  public constructor(code: "authority-verification-failed" | "guardian-launch-failed" = "authority-verification-failed") {
    super("Host Custody launch precondition rejected");
    this.name = "HostCustodyLaunchRejectedError";
    this.code = code;
  }
}

export class HostCustodyIngressOverflowError extends Error {
  public readonly status = "overflow" as const;

  public constructor() {
    super("Host Custody ingress bound exceeded");
    this.name = "HostCustodyIngressOverflowError";
  }
}

export class HostCustodyFingerprintConflictError extends Error {
  public readonly status = "conflict" as const;

  public constructor(message: string) {
    super(message);
    this.name = "HostCustodyFingerprintConflictError";
  }
}

export class HostCustodyStartError extends Error {
  public readonly custodyRef: string;
  public readonly evidenceRef: string;
  public readonly status: "ambiguous" | "error-before-start";
  public readonly startCode?: HostCustodyStartCode;

  public constructor(
    custodyRef: string,
    evidenceRef: string,
    status: "ambiguous" | "error-before-start",
    startCode?: HostCustodyStartCode,
  ) {
    super(status === "error-before-start"
      ? "Host Custody spawn failed before start acknowledgement"
      : "Host Custody spawn acknowledgement is ambiguous");
    this.name = "HostCustodyStartError";
    this.custodyRef = custodyRef;
    this.evidenceRef = evidenceRef;
    this.status = status;
    if (startCode !== undefined) {this.startCode = startCode;}
  }
}

export type HostCustodyStartCode =
  | "access-denied"
  | "executable-not-found"
  | "resource-unavailable"
  | "unknown-start-failure";

export const normalizeHostCustodyStartCode = (code: unknown): HostCustodyStartCode | undefined => {
  if (code === undefined) {return undefined;}
  if (code === "EACCES" || code === "EPERM" || code === "access-denied") {return "access-denied";}
  if (code === "ENOENT" || code === "executable-not-found") {return "executable-not-found";}
  if (code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ENOMEM" || code === "resource-unavailable") {
    return "resource-unavailable";
  }
  return "unknown-start-failure";
};
