export interface TrustedRuntimeAccessScope {
  readonly configurationSources: readonly {
    readonly absolutePath: string;
    readonly kind: "user" | "workspace";
    readonly workspaceTrusted: boolean;
  }[];
  readonly explicitCodexExecutablePaths: readonly string[];
  readonly knownExecutableDirectories: readonly string[];
  readonly observationEpoch: string;
  readonly pathEntries: readonly string[];
  readonly platform: string;
  readonly roots: readonly {
    readonly absolutePath: string;
    readonly displayName: string;
    readonly kind: "home" | "system" | "workspace";
  }[];
  readonly scopeId: string;
}
