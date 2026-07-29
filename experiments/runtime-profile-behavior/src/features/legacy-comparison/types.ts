export interface ComparisonFixture {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly temp: string;
  readonly xdgConfig: string;
  readonly xdgData: string;
  readonly xdgState: string;
  readonly xdgCache: string;
}

export interface ResolvedConfigSummary {
  readonly model: string | null;
  readonly smallModel: string | null;
  readonly username: string | null;
  readonly commands: readonly string[];
  readonly mcpServers: readonly string[];
  readonly providers: readonly string[];
}

export interface SkillSummary {
  readonly id: string;
  readonly marker: string | null;
  readonly location: string | null;
}

export interface DesktopOverlaySummary {
  readonly appMcpServerName: string;
  readonly env: NodeJS.ProcessEnv;
  readonly preservedSources: readonly {
    readonly kind: string;
    readonly exists: boolean;
    readonly fingerprint: string | null;
    readonly fileCount: number;
  }[];
  readonly diagnostics: readonly string[];
  readonly declaredMcpNames: readonly string[];
}

export interface OpenCodeInspection {
  readonly config: ResolvedConfigSummary;
  readonly skills: readonly SkillSummary[];
  readonly configExitCode: number | null;
  readonly skillExitCode: number | null;
}

export interface LegacyPreparedProfileSummary {
  readonly profileRootKey: string;
  readonly profileRootPath: string;
  readonly projectBehaviorFingerprint: string;
  readonly behaviorSources: readonly string[];
  readonly managedConfigFingerprint: string;
  readonly managedConfig: Readonly<Record<string, unknown>>;
  readonly paths: {
    readonly home: string;
    readonly temp: string;
    readonly xdgConfig: string;
    readonly xdgData: string;
    readonly xdgCache: string;
  };
}

export interface TargetInvariantEvaluation {
  readonly accepted: boolean;
  readonly sourceRevision: string;
  readonly duplicateMcpNames: readonly string[];
  readonly duplicateSkillIds: readonly string[];
  readonly diagnostics: readonly string[];
}
