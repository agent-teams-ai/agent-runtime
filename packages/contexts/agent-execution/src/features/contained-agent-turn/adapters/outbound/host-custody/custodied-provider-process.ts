import type { ContainedTurnProviderBinding } from "../../../contracts/contained-agent-turn.js";

export interface CustodiedProviderProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface CustodiedProviderProcess {
  readonly custodyRef: string;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly stdout: AsyncIterable<Uint8Array>;
  closeInput(): Promise<void>;
  waitForExit(): Promise<CustodiedProviderProcessExit>;
  write(bytes: Uint8Array): Promise<void>;
}

export interface CustodiedProviderProcessRegistry {
  get(custodyRef: string): CustodiedProviderProcess | undefined;
}

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
  readonly containmentProfile: "cooperative-posix";
  readonly delegatedArgumentVariants?: readonly (readonly string[])[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly provider: "claude" | "codex";
  readonly spawnMode?: "eager" | "sdk-delegated";
}

export interface HostCustodyLaunchPlanResolver {
  resolve(input: {
    readonly providerBinding: ContainedTurnProviderBinding;
    readonly workspaceRef: string;
  }): Promise<HostCustodyLaunchPlan | undefined>;
}

export class HostCustodyUnsupportedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HostCustodyUnsupportedError";
  }
}
