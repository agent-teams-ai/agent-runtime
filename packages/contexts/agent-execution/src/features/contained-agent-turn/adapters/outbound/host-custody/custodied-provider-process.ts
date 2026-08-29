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

export interface HostCustodyLaunchPlan {
  readonly arguments: readonly string[];
  readonly binaryRevision: string;
  readonly containmentProfile: "cooperative-posix";
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly provider: "claude" | "codex";
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
