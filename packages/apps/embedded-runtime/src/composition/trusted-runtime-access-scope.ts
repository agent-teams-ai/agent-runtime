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

export const copyTrustedRuntimeAccessScope = (
  scope: TrustedRuntimeAccessScope,
): TrustedRuntimeAccessScope =>
  Object.freeze({
    configurationSources: Object.freeze(
      scope.configurationSources.map(source => Object.freeze({ ...source })),
    ),
    explicitCodexExecutablePaths: Object.freeze([
      ...scope.explicitCodexExecutablePaths,
    ]),
    knownExecutableDirectories: Object.freeze([
      ...scope.knownExecutableDirectories,
    ]),
    observationEpoch: scope.observationEpoch,
    pathEntries: Object.freeze([...scope.pathEntries]),
    platform: scope.platform,
    roots: Object.freeze(scope.roots.map(root => Object.freeze({ ...root }))),
    scopeId: scope.scopeId,
  });
