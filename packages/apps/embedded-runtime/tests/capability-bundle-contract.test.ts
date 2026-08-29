import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRuntimeHost,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";

const unavailable = (): never => {
  throw new Error("unsupported capability must not be invoked");
};

const claudeCodeSetup = Object.freeze({
  authorizeClaudeCodeSetupInspection: { execute: unavailable },
  discoverClaudeCodeInstallations: { execute: unavailable },
  inspectClaudeCodeConfiguration: { execute: unavailable },
  planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux"),
});

const codexSetup = Object.freeze({
  authorizeSetupInspection: { execute: unavailable },
  discoverCodexInstallations: { execute: unavailable },
  inspectCodexConfiguration: { execute: unavailable },
  planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
});

const containedTurn = Object.freeze({
  cancel: { execute: unavailable },
  observe: { execute: unavailable },
  submit: { execute: unavailable },
});

test("rejects missing, partial, malformed, and unknown capability bindings synchronously", () => {
  const invalidDependencies: readonly unknown[] = [
    {},
    { claudeCodeSetup },
    {
      claudeCodeSetup: {
        authorizeClaudeCodeSetupInspection:
          claudeCodeSetup.authorizeClaudeCodeSetupInspection,
      },
      codexSetup,
    },
    {
      claudeCodeSetup,
      codexSetup: {
        ...codexSetup,
        unknownCapabilityBinding: { execute: unavailable },
      },
    },
    {
      claudeCodeSetup,
      codexSetup: {
        ...codexSetup,
        authorizeSetupInspection: { execute: "not a function" },
      },
    },
    {
      claudeCodeSetup,
      codexSetup,
      containedTurn: { ...containedTurn, unknownCapabilityBinding: { execute: unavailable } },
    },
    {
      claudeCodeSetup,
      codexSetup,
      containedTurn: { ...containedTurn, submit: { execute: "not a function" } },
    },
  ];

  for (const dependencies of invalidDependencies) {
    assert.throws(() => createAgentRuntimeHost(dependencies as never), TypeError);
  }
});

test("snapshots the optional contained-turn capability and its methods exactly once", async t => {
  let bundleReads = 0;
  let submitMethodReads = 0;
  const accessorBackedContainedTurn = Object.defineProperty(
    { ...containedTurn },
    "submit",
    {
      enumerable: true,
      get() {
        return Object.defineProperty({}, "execute", {
          enumerable: true,
          get() {
            submitMethodReads += 1;
            return submitMethodReads === 1 ? unavailable : "malformed second read";
          },
        });
      },
    },
  );
  const dependencies = Object.defineProperties({}, {
    claudeCodeSetup: { enumerable: true, value: claudeCodeSetup },
    codexSetup: { enumerable: true, value: codexSetup },
    containedTurn: {
      enumerable: true,
      get() {
        bundleReads += 1;
        return bundleReads === 1 ? accessorBackedContainedTurn : {};
      },
    },
  });

  const host = createAgentRuntimeHost(dependencies as never);
  t.after(() => host.dispose());
  assert.equal(bundleReads, 1);
  assert.equal(submitMethodReads, 1);
});

test("snapshots accessor-backed capability bundles and binding methods exactly once", async t => {
  let codexBundleReads = 0;
  let authorizationMethodReads = 0;
  const accessorBackedCodexSetup = Object.defineProperty(
    { ...codexSetup },
    "authorizeSetupInspection",
    {
      enumerable: true,
      get() {
        return Object.defineProperty({}, "execute", {
          enumerable: true,
          get() {
            authorizationMethodReads += 1;
            return authorizationMethodReads === 1 ? unavailable : "malformed second read";
          },
        });
      },
    },
  );
  const dependencies = Object.defineProperties({}, {
    claudeCodeSetup: { enumerable: true, value: claudeCodeSetup },
    codexSetup: {
      enumerable: true,
      get() {
        codexBundleReads += 1;
        return codexBundleReads === 1 ? accessorBackedCodexSetup : {};
      },
    },
  });

  const host = createAgentRuntimeHost(dependencies as never);
  t.after(() => host.dispose());
  const access = host.bindAccess({
    codexSetup: {
      configurationDialect: "codex-0.134",
      configurationSources: [],
      explicitCodexExecutablePaths: [],
      knownExecutableDirectories: [],
      observationEpoch: "accessor-snapshot-epoch",
      pathEntries: [],
      roots: [],
      scopeId: "accessor-snapshot-scope",
    },
  });

  assert.deepEqual(await access.codexSetup.inspect({}), {
    diagnostics: [],
    status: "unsupported",
  });
  assert.equal(codexBundleReads, 1);
  assert.equal(authorizationMethodReads, 1);
});
