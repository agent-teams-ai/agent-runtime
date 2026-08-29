import type { ContainedTurnScope } from "@agent-teams/agent-execution";

import type { TrustedClaudeCodeSetupScope } from "../application/trusted-claude-code-setup-scope.js";
import type { TrustedCodexSetupScope } from "../application/trusted-runtime-access-scope.js";

export type { TrustedCodexSetupScope } from "../application/trusted-runtime-access-scope.js";

export interface TrustedRuntimeAccessScope {
  readonly claudeCodeSetup?: TrustedClaudeCodeSetupScope;
  readonly codexSetup?: TrustedCodexSetupScope;
  readonly containedTurn?: ContainedTurnScope;
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

const copyBoundedText = (value: string, limit: number): string | undefined =>
  typeof value === "string" && value.length <= limit ? value : undefined;

const copyBoundedIdentifier = (value: string, limit: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= limit &&
    /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._/-]/u.test(value)
    ? value
    : undefined;

const copyContainedTurnReference = (value: string, limit: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\u0000")
    ? value
    : undefined;

export const copyTrustedContainedTurnScope = (
  scope: ContainedTurnScope,
): ContainedTurnScope | undefined => {
  try {
    const limits = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.containedTurn.text;
    const projectId = copyContainedTurnReference(scope.projectId, limits.projectId);
    const tenantId = copyContainedTurnReference(scope.tenantId, limits.tenantId);
    return projectId === undefined || tenantId === undefined
      ? undefined
      : Object.freeze({ projectId, tenantId });
  } catch {
    return undefined;
  }
};

const copyBounded = <Input, Output>(
  values: readonly Input[],
  limit: number,
  copy: (value: Input) => Output | undefined,
): readonly Output[] | undefined => {
  const length = values.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
    return undefined;
  }
  const result: Output[] = [];
  for (let index = 0; index < length; index += 1) {
    const copied = copy(values[index]!);
    if (copied === undefined) {
      return undefined;
    }
    result.push(copied);
  }
  return values.length === length ? Object.freeze(result) : undefined;
};

const hasBoundedLength = (values: readonly unknown[], limit: number): boolean => {
  const length = values.length;
  return Number.isSafeInteger(length) && length >= 0 && length <= limit;
};

export const copyTrustedClaudeCodeSetupScope = (
  scope: TrustedClaudeCodeSetupScope,
): TrustedClaudeCodeSetupScope | undefined => {
  try {
    const limits = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup;
    const explicitExecutablePathValues = scope.explicitExecutablePaths;
    const pathEntryValues = scope.pathEntries;
    if (!hasBoundedLength(
      explicitExecutablePathValues,
      limits.explicitExecutablePaths,
    ) || !hasBoundedLength(pathEntryValues, limits.pathEntries)) {
      return undefined;
    }
    const explicitExecutablePaths = copyBounded(
      explicitExecutablePathValues,
      limits.explicitExecutablePaths,
      value => copyBoundedText(value, limits.text.path),
    );
    const pathEntries = copyBounded(
      pathEntryValues,
      limits.pathEntries,
      value => copyBoundedText(value, limits.text.path),
    );
    const homeRoot = copyBoundedText(scope.homeRoot, limits.text.path);
    const observationEpoch = copyBoundedIdentifier(
      scope.observationEpoch,
      limits.text.observationEpoch,
    );
    const scopeId = copyBoundedIdentifier(scope.scopeId, limits.text.scopeId);
    const workspaceRoot = copyBoundedText(scope.workspaceRoot, limits.text.path);
    return explicitExecutablePaths === undefined || pathEntries === undefined ||
      homeRoot === undefined || observationEpoch === undefined || scopeId === undefined ||
      workspaceRoot === undefined
      ? undefined
      : Object.freeze({
        dialect: scope.dialect,
        explicitExecutablePaths,
        homeRoot,
        observationEpoch,
        pathEntries,
        scopeId,
        workspaceRoot,
        workspaceTrusted: scope.workspaceTrusted,
      });
  } catch {
    return undefined;
  }
};

export const copyTrustedCodexSetupScope = (
  scope: TrustedCodexSetupScope,
): TrustedCodexSetupScope | undefined => {
  try {
    const limits = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup;
    const configurationSourceValues = scope.configurationSources;
    const explicitCodexExecutablePathValues = scope.explicitCodexExecutablePaths;
    const knownExecutableDirectoryValues = scope.knownExecutableDirectories;
    const pathEntryValues = scope.pathEntries;
    const rootValues = scope.roots;
    if (!hasBoundedLength(configurationSourceValues, limits.configurationSources) ||
      !hasBoundedLength(
        explicitCodexExecutablePathValues,
        limits.explicitExecutablePaths,
      ) ||
      !hasBoundedLength(
        knownExecutableDirectoryValues,
        limits.knownExecutableDirectories,
      ) ||
      !hasBoundedLength(pathEntryValues, limits.pathEntries) ||
      !hasBoundedLength(rootValues, limits.roots)) {
      return undefined;
    }
    const configurationSources = copyBounded(
      configurationSourceValues,
      limits.configurationSources,
      source => {
        const absolutePath = copyBoundedText(source.absolutePath, limits.text.path);
        const profileName = source.profileName === undefined
          ? undefined
          : copyBoundedText(source.profileName, limits.text.profileName);
        if (absolutePath === undefined ||
          (source.profileName !== undefined && profileName === undefined)) {
          return;
        }
        return Object.freeze({
          absolutePath,
          kind: source.kind,
          ...(profileName === undefined ? {} : { profileName }),
          ...(source.workspaceLayer === undefined
            ? {}
            : { workspaceLayer: source.workspaceLayer }),
          workspaceTrusted: source.workspaceTrusted,
        });
      },
    );
    const explicitCodexExecutablePaths = copyBounded(
      explicitCodexExecutablePathValues,
      limits.explicitExecutablePaths,
      value => copyBoundedText(value, limits.text.path),
    );
    const knownExecutableDirectories = copyBounded(
      knownExecutableDirectoryValues,
      limits.knownExecutableDirectories,
      value => copyBoundedText(value, limits.text.path),
    );
    const pathEntries = copyBounded(
      pathEntryValues,
      limits.pathEntries,
      value => copyBoundedText(value, limits.text.path),
    );
    const roots = copyBounded(
      rootValues,
      limits.roots,
      root => {
        const absolutePath = copyBoundedText(root.absolutePath, limits.text.path);
        return absolutePath === undefined
          ? undefined
          : Object.freeze({ absolutePath, kind: root.kind });
      },
    );
    const observationEpoch = copyBoundedText(
      scope.observationEpoch,
      limits.text.observationEpoch,
    );
    const scopeId = copyBoundedText(scope.scopeId, limits.text.scopeId);
    return configurationSources === undefined ||
      explicitCodexExecutablePaths === undefined ||
      knownExecutableDirectories === undefined ||
      pathEntries === undefined || roots === undefined || observationEpoch === undefined ||
      scopeId === undefined
      ? undefined
      : Object.freeze({
        configurationDialect: scope.configurationDialect,
        configurationSources,
        explicitCodexExecutablePaths,
        knownExecutableDirectories,
        observationEpoch,
        pathEntries,
        roots,
        scopeId,
      });
  } catch {
    return undefined;
  }
};
