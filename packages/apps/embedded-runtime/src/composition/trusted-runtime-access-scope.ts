export type { TrustedRuntimeAccessScope } from "../application/trusted-runtime-access-scope.js";

import type { TrustedRuntimeAccessScope } from "../application/trusted-runtime-access-scope.js";

export const copyTrustedRuntimeAccessScope = (
  scope: TrustedRuntimeAccessScope,
): TrustedRuntimeAccessScope =>
  Object.freeze({
    configurationDialect: scope.configurationDialect,
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
    roots: Object.freeze(scope.roots.map(root => Object.freeze({ ...root }))),
    scopeId: scope.scopeId,
  });
