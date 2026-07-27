export type ProviderId = "claude" | "codex" | "opencode";

export interface ProviderExecutable {
  readonly id: ProviderId;
  readonly candidates: readonly string[];
  readonly versionArgs: readonly string[];
}

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface ExecutableInventory {
  readonly provider: ProviderId;
  readonly available: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly versionProbe?: Omit<CommandResult, "stdout" | "stderr">;
}

export interface StateRootInventory {
  readonly owner: ProviderId | "shared";
  readonly path: string;
  readonly exists: boolean;
  readonly kind?: "directory" | "file" | "symlink" | "other";
  readonly fileCount?: number;
  readonly directoryCount?: number;
}

export interface HostInventory {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly hostname: string;
  readonly providerExecutables: readonly ExecutableInventory[];
  readonly stateRoots: readonly StateRootInventory[];
  readonly environmentPresence: Readonly<Record<string, boolean>>;
  readonly tracing: {
    readonly strace: boolean;
  };
}

export interface FileSnapshotEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  readonly size: number;
  readonly contentHash?: string;
  readonly symlinkTarget?: string;
}

export interface FileSnapshot {
  readonly root: string;
  readonly entries: readonly FileSnapshotEntry[];
}

export interface FileSnapshotDiff {
  readonly added: readonly FileSnapshotEntry[];
  readonly removed: readonly FileSnapshotEntry[];
  readonly changed: readonly {
    readonly before: FileSnapshotEntry;
    readonly after: FileSnapshotEntry;
  }[];
}

export interface TraceSummary {
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly executePaths: readonly string[];
  readonly traceFileCount: number;
}

export interface ObservationAssertion {
  readonly id: string;
  readonly passed: boolean;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly detail?: string;
}

export interface ScenarioEvidence {
  readonly schemaVersion: 1;
  readonly scenarioId: string;
  readonly provider: ProviderId;
  readonly capturedAt: string;
  readonly command: {
    readonly executable: string;
    readonly args: readonly string[];
  };
  readonly result: CommandResult;
  readonly filesystem: FileSnapshotDiff;
  readonly trace: TraceSummary;
  readonly safety: {
    readonly syntheticHome: true;
    readonly syntheticWorkspace: true;
    readonly syscallTrace: boolean;
    readonly inheritedSensitiveEnvironmentKeys: readonly string[];
  };
  readonly verification?: Readonly<Record<string, unknown>>;
  readonly assertions?: readonly ObservationAssertion[];
}
