import assert from "node:assert/strict";
import test from "node:test";

import {
  copyTrustedClaudeCodeSetupScope,
  copyTrustedCodexSetupScope,
  copyTrustedContainedTurnScope,
  TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS,
} from "../dist/composition/trusted-runtime-access-scope.js";

const values = (length: number, prefix: string): string[] =>
  Array.from({ length }, (_, index) => `/${prefix}-${index}`);

const withMutatingLength = <T>(items: T[]): readonly T[] => {
  let lengthReads = 0;
  return new Proxy(items, {
    get(target, property, receiver) {
      if (property === "length") {
        lengthReads += 1;
        return lengthReads === 1 ? target.length : target.length + 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
};

const codexScope = () => ({
  configurationDialect: "codex-0.134" as const,
  configurationSources: Array.from(
    { length: TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.configurationSources },
    (_, index) => ({
      absolutePath: `/configuration-${index}`,
      kind: "user" as const,
      workspaceTrusted: true,
    }),
  ),
  explicitCodexExecutablePaths: values(
    TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.explicitExecutablePaths,
    "explicit",
  ),
  knownExecutableDirectories: values(
    TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.knownExecutableDirectories,
    "known",
  ),
  observationEpoch: "epoch",
  pathEntries: values(TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.pathEntries, "path"),
  roots: Array.from(
    { length: TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.roots },
    (_, index) => ({ absolutePath: `/root-${index}`, kind: "home" as const }),
  ),
  scopeId: "scope",
});

const claudeScope = () => ({
  dialect: "claude-code-settings@2026-08-28" as const,
  explicitExecutablePaths: values(
    TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.explicitExecutablePaths,
    "claude-explicit",
  ),
  homeRoot: "/home",
  observationEpoch: "epoch",
  pathEntries: values(
    TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.pathEntries,
    "claude-path",
  ),
  scopeId: "scope",
  workspaceRoot: "/workspace",
  workspaceTrusted: true,
});

const isDeeplyFrozen = (value: unknown): boolean =>
  typeof value !== "object" || value === null ||
  (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen));

test("copies every trusted collection at its owner-local limit without using iterators", () => {
  const codex = codexScope();
  const claude = claudeScope();
  for (const collection of [
    codex.configurationSources,
    codex.explicitCodexExecutablePaths,
    codex.knownExecutableDirectories,
    codex.pathEntries,
    codex.roots,
    claude.explicitExecutablePaths,
    claude.pathEntries,
  ]) {
    Object.defineProperty(collection, Symbol.iterator, {
      value: () => { throw new Error("bounded copying must not use an iterator"); },
    });
  }

  const copiedCodex = copyTrustedCodexSetupScope(codex);
  const copiedClaude = copyTrustedClaudeCodeSetupScope(claude);
  assert.ok(copiedCodex !== undefined && isDeeplyFrozen(copiedCodex));
  assert.ok(copiedClaude !== undefined && isDeeplyFrozen(copiedClaude));
});

test("accepts every bounded path, profile, epoch, and scope string at its limit", () => {
  const codex = codexScope();
  const codexText = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.text;
  Object.assign(codex.configurationSources[0]!, {
    absolutePath: "p".repeat(codexText.path),
    kind: "external-profile",
    profileName: "n".repeat(codexText.profileName),
    workspaceTrusted: true,
  });
  codex.explicitCodexExecutablePaths[0] = "e".repeat(codexText.path);
  codex.knownExecutableDirectories[0] = "k".repeat(codexText.path);
  codex.pathEntries[0] = "v".repeat(codexText.path);
  codex.roots[0] = { absolutePath: "r".repeat(codexText.path), kind: "home" };
  codex.observationEpoch = "o".repeat(codexText.observationEpoch);
  codex.scopeId = "s".repeat(codexText.scopeId);

  const claude = claudeScope();
  const claudeText = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.text;
  claude.explicitExecutablePaths[0] = "e".repeat(claudeText.path);
  claude.homeRoot = "h".repeat(claudeText.path);
  claude.observationEpoch = "o".repeat(claudeText.observationEpoch);
  claude.pathEntries[0] = "p".repeat(claudeText.path);
  claude.scopeId = "s".repeat(claudeText.scopeId);
  claude.workspaceRoot = "w".repeat(claudeText.path);

  assert.ok(copyTrustedCodexSetupScope(codex) !== undefined);
  assert.ok(copyTrustedClaudeCodeSetupScope(claude) !== undefined);
  const containedText = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.containedTurn.text;
  const contained = copyTrustedContainedTurnScope({
    projectId: "p".repeat(containedText.projectId),
    tenantId: "t".repeat(containedText.tenantId),
  });
  assert.ok(contained !== undefined && isDeeplyFrozen(contained));
});

test("copies contained-turn scope once and preserves valid opaque references", () => {
  let projectReads = 0;
  let tenantReads = 0;
  const scope = Object.defineProperties({}, {
    projectId: {
      enumerable: true,
      get() {
        projectReads += 1;
        return projectReads === 1 ? "project:opaque/reference" : "changed";
      },
    },
    tenantId: {
      enumerable: true,
      get() {
        tenantReads += 1;
        return tenantReads === 1 ? "tenant:opaque/reference" : "changed";
      },
    },
  });
  assert.deepEqual(copyTrustedContainedTurnScope(scope as never), {
    projectId: "project:opaque/reference",
    tenantId: "tenant:opaque/reference",
  });
  assert.equal(projectReads, 1);
  assert.equal(tenantReads, 1);
  for (const invalid of [
    { projectId: "", tenantId: "tenant" },
    { projectId: "project", tenantId: "" },
    { projectId: "project\u0000secret", tenantId: "tenant" },
    { projectId: "project", tenantId: "tenant\u0000secret" },
    {
      projectId: "p".repeat(TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.containedTurn.text.projectId + 1),
      tenantId: "tenant",
    },
  ]) {
    assert.equal(copyTrustedContainedTurnScope(invalid), undefined);
  }
});

test("rejects each over-limit collection before reading an element", () => {
  const cases = [
    ["configurationSources", TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.configurationSources],
    ["explicitCodexExecutablePaths", TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.explicitExecutablePaths],
    ["knownExecutableDirectories", TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.knownExecutableDirectories],
    ["pathEntries", TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.pathEntries],
    ["roots", TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.roots],
  ] as const;
  for (const [field, limit] of cases) {
    const scope = codexScope();
    Object.assign(scope, { [field]: new Proxy(values(limit + 1, "sensitive"), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) {
          throw new Error("over-limit collection element was read");
        }
        return Reflect.get(target, property, receiver);
      },
    }) });
    assert.equal(copyTrustedCodexSetupScope(scope), undefined, field);
  }

  for (const [field, limit] of [
    ["explicitExecutablePaths", TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.explicitExecutablePaths],
    ["pathEntries", TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.pathEntries],
  ] as const) {
    const scope = claudeScope();
    Object.assign(scope, { [field]: new Proxy(values(limit + 1, "sensitive"), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) {
          throw new Error("over-limit collection element was read");
        }
        return Reflect.get(target, property, receiver);
      },
    }) });
    assert.equal(copyTrustedClaudeCodeSetupScope(scope), undefined, field);
  }
});

test("rejects every over-limit path, profile, epoch, and scope string", () => {
  const codexText = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.codexSetup.text;
  const codexCases = [
    (scope: ReturnType<typeof codexScope>) => {
      Object.assign(scope.configurationSources[0]!, {
        absolutePath: "x".repeat(codexText.path + 1), kind: "user", workspaceTrusted: true,
      });
    },
    (scope: ReturnType<typeof codexScope>) => {
      Object.assign(scope.configurationSources[0]!, {
        absolutePath: "/valid", kind: "external-profile",
        profileName: "x".repeat(codexText.profileName + 1), workspaceTrusted: true,
      });
    },
    (scope: ReturnType<typeof codexScope>) => {
      scope.explicitCodexExecutablePaths[0] = "x".repeat(codexText.path + 1);
    },
    (scope: ReturnType<typeof codexScope>) => {
      scope.knownExecutableDirectories[0] = "x".repeat(codexText.path + 1);
    },
    (scope: ReturnType<typeof codexScope>) => {
      scope.pathEntries[0] = "x".repeat(codexText.path + 1);
    },
    (scope: ReturnType<typeof codexScope>) => {
      scope.roots[0] = { absolutePath: "x".repeat(codexText.path + 1), kind: "home" };
    },
    (scope: ReturnType<typeof codexScope>) => {
      scope.observationEpoch = "x".repeat(codexText.observationEpoch + 1);
    },
    (scope: ReturnType<typeof codexScope>) => {
      scope.scopeId = "x".repeat(codexText.scopeId + 1);
    },
  ];
  for (const mutate of codexCases) {
    const scope = codexScope();
    mutate(scope);
    assert.equal(copyTrustedCodexSetupScope(scope), undefined);
  }

  const claudeText = TRUSTED_RUNTIME_ACCESS_SCOPE_LIMITS.claudeCodeSetup.text;
  const claudeCases = [
    (scope: ReturnType<typeof claudeScope>) => {
      scope.explicitExecutablePaths[0] = "x".repeat(claudeText.path + 1);
    },
    (scope: ReturnType<typeof claudeScope>) => {
      scope.homeRoot = "x".repeat(claudeText.path + 1);
    },
    (scope: ReturnType<typeof claudeScope>) => {
      scope.observationEpoch = "x".repeat(claudeText.observationEpoch + 1);
    },
    (scope: ReturnType<typeof claudeScope>) => {
      scope.pathEntries[0] = "x".repeat(claudeText.path + 1);
    },
    (scope: ReturnType<typeof claudeScope>) => {
      scope.scopeId = "x".repeat(claudeText.scopeId + 1);
    },
    (scope: ReturnType<typeof claudeScope>) => {
      scope.workspaceRoot = "x".repeat(claudeText.path + 1);
    },
  ];
  for (const mutate of claudeCases) {
    const scope = claudeScope();
    mutate(scope);
    assert.equal(copyTrustedClaudeCodeSetupScope(scope), undefined);
  }
});

test("rejects a collection whose length mutates between precheck and copy", () => {
  const codex = codexScope();
  codex.pathEntries = withMutatingLength(codex.pathEntries);
  assert.equal(copyTrustedCodexSetupScope(codex), undefined);

  const claude = claudeScope();
  claude.pathEntries = withMutatingLength(claude.pathEntries);
  assert.equal(copyTrustedClaudeCodeSetupScope(claude), undefined);
});
