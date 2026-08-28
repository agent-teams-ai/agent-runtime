export type { TrustedRuntimeAccessScope } from "../application/trusted-runtime-access-scope.js";

import type { TrustedRuntimeAccessScope } from "../application/trusted-runtime-access-scope.js";

const copyTrustedClaudeCodeSetupScope = (
  scope: NonNullable<TrustedRuntimeAccessScope["claudeCodeSetup"]>,
) => Object.freeze({
  dialect: scope.dialect,
  explicitExecutablePaths: Object.freeze([...scope.explicitExecutablePaths]),
  homeRoot: scope.homeRoot,
  observationEpoch: scope.observationEpoch,
  pathEntries: Object.freeze([...scope.pathEntries]),
  scopeId: scope.scopeId,
  workspaceRoot: scope.workspaceRoot,
  workspaceTrusted: scope.workspaceTrusted,
});

export const copyTrustedRuntimeAccessScope = (
  scope: TrustedRuntimeAccessScope,
): TrustedRuntimeAccessScope =>
  Object.freeze({
    ...(scope.claudeCodeSetup === undefined
      ? {}
      : { claudeCodeSetup: copyTrustedClaudeCodeSetupScope(scope.claudeCodeSetup) }),
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
