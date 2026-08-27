export interface TrustedRuntimeAccessScope {
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
  readonly platform: string;
  readonly roots: readonly {
    readonly absolutePath: string;
    readonly kind: "home" | "system" | "workspace";
  }[];
  readonly scopeId: string;
}
