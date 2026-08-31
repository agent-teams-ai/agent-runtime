import assert from "node:assert/strict";
import test from "node:test";

import { evaluateResolvedSourceDependency } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/application/policies/evaluate-resolved-source-dependency.js";
import { evaluateSourceDependencies } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/application/policies/evaluate-source-dependencies.js";
import { loadCapabilityConfig } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/contract/config.js";

const root = new URL("../../", import.meta.url).pathname;
const policy = await loadCapabilityConfig(root, "architecture/foundation/source-dependencies.yaml");
const boundariesById = new Map(policy.boundaries.map(boundary => [boundary.id, boundary]));
const developmentBoundariesByPackage = new Map();
const packageName = "@agent-teams/agent-execution";
const manifestPath = "packages/contexts/agent-execution/package.json";

const edge = ({ fromBoundaryId, fromPath, resolution, specifier = "./target.js" }) => ({
  fromBoundaryId,
  fromPath,
  fromWorkspacePackageManifestPath: manifestPath,
  fromWorkspacePackageName: packageName,
  kind: specifier.startsWith("node:") ? "static" : "static-type",
  mode: specifier.startsWith("node:") ? "runtime" : "type-only",
  resolution,
  specifier,
  start: 0,
  end: specifier.length,
});

const local = (fromBoundaryId, fromPath, targetBoundaryId, path) => edge({
  fromBoundaryId,
  fromPath,
  resolution: {
    kind: "local-file",
    path,
    targetBoundaryId,
    workspacePackageManifestPath: manifestPath,
    workspacePackageName: packageName,
  },
});

const evaluate = observedEdge => evaluateResolvedSourceDependency({
  boundariesById,
  developmentBoundariesByPackage,
  edge: observedEdge,
  policy,
});

const rules = diagnostics => diagnostics.map(diagnostic => diagnostic.ruleId);

test("contained-turn domain and application remain dependency-free core", () => {
  const core = boundariesById.get("core.agent-execution.contained-turn");
  assert.deepEqual(core.allowedBoundaries, []);
  assert.deepEqual(core.allowedBuiltins, []);
  assert.deepEqual(core.allowedPackages, []);
  assert.deepEqual(core.allowedRuntimeReferences, []);

  const builtinDiagnostics = evaluate(edge({
    fromBoundaryId: core.id,
    fromPath: `${core.roots[0]}/future-node-import.ts`,
    resolution: { kind: "builtin", specifier: "node:fs" },
    specifier: "node:fs",
  }));
  assert.deepEqual(rules(builtinDiagnostics), ["architecture.source-dependencies.forbidden-builtin-dependency"]);

  const sdkDiagnostics = evaluate(edge({
    fromBoundaryId: core.id,
    fromPath: `${core.roots[1]}/future-sdk-import.ts`,
    resolution: {
      declaration: "runtime",
      kind: "external-package",
      packageName: "@anthropic-ai/claude-agent-sdk",
    },
    specifier: "@anthropic-ai/claude-agent-sdk",
  }));
  assert.deepEqual(rules(sdkDiagnostics), ["architecture.source-dependencies.forbidden-package-dependency"]);
});

test("only exact Host and Docker adapter entrypoints admit cross-adapter imports", () => {
  const host = boundariesById.get("adapter.agent-execution.host-custody");
  const docker = boundariesById.get("adapter.agent-execution.docker-custody");
  const engine = boundariesById.get("adapter.agent-execution.docker-engine");
  const production = boundariesById.get("production.agent-execution");
  const claude = boundariesById.get("adapter.agent-execution.claude-agent-sdk");

  assert.deepEqual(evaluate(local(
    claude.id,
    `${claude.roots[0]}/future-current-kernel-adapter.ts`,
    host.id,
    host.entrypoints[0],
  )), []);
  assert.deepEqual(evaluate(local(
    docker.id,
    `${docker.roots[0]}/future-attach-bridge.ts`,
    engine.id,
    engine.entrypoints[0],
  )), []);
  assert.deepEqual(evaluate(local(
    docker.id,
    `${docker.roots[0]}/init/future-init-bridge.ts`,
    docker.id,
    `${docker.roots[0]}/docker-host-custody-lifecycle.ts`,
  )), []);

  const hostPrivate = evaluate(local(
    production.id,
    "packages/contexts/agent-execution/src/features/contained-agent-turn/future-private-import.ts",
    host.id,
    `${host.roots[0]}/host-custody-stable-guardian.ts`,
  ));
  assert.deepEqual(rules(hostPrivate), ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);

  const enginePrivate = evaluate(local(
    docker.id,
    `${docker.roots[0]}/journal/future-private-import.ts`,
    engine.id,
    `${engine.roots[0]}/docker-engine-port.ts`,
  ));
  assert.deepEqual(rules(enginePrivate), ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);
});

test("Node and SDK capabilities stay exact to their outer adapters", () => {
  for (const [boundaryId, builtin] of [
    ["adapter.agent-execution.host-custody", "node:os"],
    ["adapter.agent-execution.host-custody", "node:stream"],
    ["adapter.agent-execution.claude-agent-sdk", "node:perf_hooks"],
  ]) {
    assert.deepEqual(evaluate(edge({
      fromBoundaryId: boundaryId,
      fromPath: `${boundariesById.get(boundaryId).roots[0]}/owned-import.ts`,
      resolution: { kind: "builtin", specifier: builtin },
      specifier: builtin,
    })), []);
  }

  const claude = boundariesById.get("adapter.agent-execution.claude-agent-sdk");
  assert.deepEqual(evaluate(edge({
    fromBoundaryId: claude.id,
    fromPath: `${claude.roots[0]}/claude-agent-sdk-contained-turn-provider.ts`,
    resolution: {
      declaration: "runtime",
      kind: "external-package",
      packageName: "@anthropic-ai/claude-agent-sdk",
    },
    specifier: "@anthropic-ai/claude-agent-sdk",
  })), []);

  const unresolved = evaluateSourceDependencies({
    policy,
    graph: {
      edges: [],
      nodes: policy.boundaries.flatMap(boundary => boundary.entrypoints.map(path => ({
        boundaryId: boundary.id,
        path,
        workspacePackageManifestPath: manifestPath,
        workspacePackageName: packageName,
      }))),
      parseFailures: [],
      unclassifiedSourcePaths: [],
      unresolvedRuntimeReferences: [{
        boundaryId: claude.id,
        kind: "dynamic",
        path: `${claude.roots[0]}/future-hidden-loader.ts`,
        start: 0,
        end: 12,
      }],
    },
  });
  assert.ok(rules(unresolved).includes("architecture.source-dependencies.unresolved-runtime-reference"));
});
