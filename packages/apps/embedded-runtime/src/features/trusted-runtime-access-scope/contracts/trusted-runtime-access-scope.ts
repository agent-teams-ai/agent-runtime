export interface TrustedClaudeCodeSetupScope {
  readonly dialect: "claude-code-settings@2026-08-28";
  readonly explicitExecutablePaths: readonly string[];
  readonly homeRoot: string;
  readonly observationEpoch: string;
  readonly pathEntries: readonly string[];
  readonly scopeId: string;
  readonly workspaceRoot: string;
  readonly workspaceTrusted: boolean;
}

export interface TrustedCodexSetupScope {
  readonly configurationSources: readonly {
    readonly absolutePath: string;
    readonly kind: "external-profile" | "user" | "workspace";
    readonly profileName?: string;
    readonly workspaceLayer?: number;
    readonly workspaceTrusted: boolean;
  }[];
  readonly configurationDialect: "codex-0.134";
  readonly explicitCodexExecutablePaths: readonly string[];
  readonly knownExecutableDirectories: readonly string[];
  readonly observationEpoch: string;
  readonly pathEntries: readonly string[];
  readonly roots: readonly {
    readonly absolutePath: string;
    readonly kind: "home" | "system" | "workspace";
  }[];
  readonly scopeId: string;
}

export interface ContainedTurnCompositionScope {
  readonly projectId: string;
  readonly tenantId: string;
}

export interface TrustedRuntimeAccessScope {
  readonly claudeCodeSetup?: TrustedClaudeCodeSetupScope;
  readonly codexSetup?: TrustedCodexSetupScope;
  readonly containedTurn?: ContainedTurnCompositionScope;
}

export const TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS = Object.freeze({
  claudeCodeSetup: Object.freeze({
    explicitExecutablePaths: 16,
    pathEntries: 64,
    text: Object.freeze({
      observationEpoch: 128,
      path: 16_384,
      scopeId: 128,
    }),
  }),
  codexSetup: Object.freeze({
    configurationSources: 64,
    explicitExecutablePaths: 16,
    knownExecutableDirectories: 16,
    pathEntries: 64,
    roots: 16,
    text: Object.freeze({
      observationEpoch: 256,
      path: 16_384,
      profileName: 64,
      scopeId: 256,
    }),
  }),
  containedTurn: Object.freeze({
    text: Object.freeze({
      projectId: 512,
      tenantId: 512,
    }),
  }),
});

