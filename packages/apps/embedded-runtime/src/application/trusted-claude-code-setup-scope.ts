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
