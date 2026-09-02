import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createSourceDependenciesCapability } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { loadCapabilityConfig } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/contract/config.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const configPath = "architecture/foundation/source-dependencies.yaml";
const configSource = await readFile(join(repositoryRoot, configPath), "utf8");
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const policy = await loadCapabilityConfig(repositoryRoot, configPath);
const boundariesById = new Map(policy.boundaries.map(boundary => [boundary.id, boundary]));

const paths = {
  claude: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/negative-fixture.ts",
  composition: "packages/contexts/agent-execution/src/composition.ts",
  core: "packages/contexts/agent-execution/src/features/contained-agent-turn/application/negative-fixture.ts",
  docker: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/negative-fixture.ts",
  dockerBarrel: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.ts",
  dockerFake: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/fake-docker-engine.ts",
  dockerNode: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/node-unix-socket-docker-engine.ts",
  dockerPort: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.ts",
  host: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.ts",
  hostNode: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.ts",
  legacy: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/legacy/legacy-contained-turn-ports.ts",
  providerDelegation: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/provider-delegation-ports/contained-turn-provider-delegation-port.ts",
  privateDirectoryCustody: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/provider-delegation-ports/private-directory-custody-port.ts",
};

const writeFixtureFile = async (root, path, source = "export {};\n") => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), source);
};

const analyzeFixture = async files => {
  const root = await mkdtemp(join(tmpdir(), "ar-foundation-boundaries-"));
  try {
    for (const governedRoot of policy.governedRoots) {
      await mkdir(join(root, governedRoot), { recursive: true });
    }
    await writeFixtureFile(root, "package.json", JSON.stringify({
      dependencies: { "@anthropic-ai/claude-agent-sdk": "1.0.0" },
      name: "foundation-boundary-fixture",
      private: true,
      type: "module",
    }));
    await writeFixtureFile(root, "pnpm-workspace.yaml", "packages: []\n");
    await writeFixtureFile(root, configPath, configSource);
    for (const boundary of policy.boundaries) {
      for (const entrypoint of boundary.entrypoints) {
        await writeFixtureFile(root, entrypoint);
      }
    }
    for (const [path, source] of Object.entries(files)) {
      await writeFixtureFile(root, path, source);
    }

    const report = await createSourceDependenciesCapability().run({
      configPath,
      consumerRoot: root,
    });
    assert.ok(
      report.outcome === "passed" || report.outcome === "violations",
      JSON.stringify(report, null, 2),
    );
    return report.diagnostics;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const rules = diagnostics => diagnostics.map(diagnostic => diagnostic.ruleId);

test("the named negative suite runs exactly once through every Foundation gate", () => {
  assert.equal(
    manifest.scripts["foundation:boundaries:negative"],
    "node --test scripts/architecture/source-dependency-adapter-boundaries.test.mjs",
  );
  assert.equal(
    manifest.scripts["foundation:check"].split("pnpm foundation:boundaries:negative").length - 1,
    1,
  );
  for (const script of ["check", "check:fast"]) {
    assert.equal(manifest.scripts[script].split("pnpm foundation:check").length - 1, 1, script);
  }
  assert.ok(!manifest.scripts["foundation:check"].includes("|| true"));
  assert.ok(!manifest.scripts["foundation:check"].includes("allow-diagnostics"));
});

test("contained-turn domain and application remain dependency-free core", async () => {
  const core = boundariesById.get("core.agent-execution.contained-turn");
  assert.deepEqual(core.allowedBoundaries, []);
  assert.deepEqual(core.allowedBuiltins, []);
  assert.deepEqual(core.allowedPackages, []);
  assert.deepEqual(core.allowedRuntimeReferences, []);

  assert.deepEqual(rules(await analyzeFixture({
    [paths.core]: "import 'node:fs';\n",
  })), ["architecture.source-dependencies.forbidden-builtin-dependency"]);
  assert.ok(rules(await analyzeFixture({
    [paths.core]: "import type {} from '@anthropic-ai/claude-agent-sdk';\n",
  })).includes("architecture.source-dependencies.forbidden-package-dependency"));
});

test("transitional boundaries and adapter permissions remain exact", () => {
  const legacy = boundariesById.get("adapter.agent-execution.legacy-contained-turn-ports");
  const claude = boundariesById.get("adapter.agent-execution.claude-agent-sdk");
  const delegation = boundariesById.get("adapter.agent-execution.provider-delegation-ports");
  const production = boundariesById.get("production.agent-execution");

  assert.deepEqual(legacy.roots, [dirname(paths.legacy)]);
  assert.deepEqual(legacy.entrypoints, [paths.legacy]);
  assert.deepEqual(legacy.allowedBoundaries, ["core.agent-execution.contained-turn"]);
  assert.deepEqual(legacy.allowedPackages, []);
  assert.deepEqual(legacy.allowedBuiltins, []);
  assert.deepEqual(legacy.allowedRuntimeReferences, []);
  assert.deepEqual(claude.allowedBoundaries, [
    "adapter.agent-execution.provider-delegation-ports",
    "core.agent-execution.contained-turn",
  ]);
  assert.deepEqual(delegation.entrypoints, [paths.providerDelegation, paths.privateDirectoryCustody]);
  assert.deepEqual(delegation.allowedBoundaries, [
    "adapter.agent-execution.host-custody",
    "adapter.agent-execution.legacy-contained-turn-ports",
  ]);
  assert.deepEqual(delegation.allowedPackages, []);
  assert.deepEqual(delegation.allowedBuiltins, []);
  assert.deepEqual(delegation.allowedRuntimeReferences, []);
  assert.ok(!claude.allowedBoundaries.includes("adapter.agent-execution.host-custody"));
  assert.ok(!claude.allowedBoundaries.includes("adapter.agent-execution.legacy-contained-turn-ports"));
  assert.ok(!claude.allowedBoundaries.includes("production.agent-execution"));
  assert.deepEqual(production.allowedBoundaries, [
    "adapter.agent-execution.claude-agent-sdk",
    "adapter.agent-execution.host-custody",
    "adapter.agent-execution.legacy-contained-turn-ports",
    "adapter.agent-execution.provider-delegation-ports",
    "core.agent-execution.contained-turn",
  ]);
  assert.ok(!production.entrypoints.includes(paths.legacy));
});

test("Docker custody has only the port-only engine entrypoint", () => {
  const engine = boundariesById.get("adapter.agent-execution.docker-engine");
  const custody = boundariesById.get("adapter.agent-execution.docker-custody");

  assert.deepEqual(engine.entrypoints, [paths.dockerPort]);
  assert.deepEqual(engine.allowedBoundaries, []);
  assert.deepEqual(engine.allowedPackages, []);
  assert.deepEqual(engine.allowedRuntimeReferences, []);
  assert.deepEqual(custody.allowedBoundaries, ["adapter.agent-execution.docker-engine"]);
  assert.ok(!engine.entrypoints.includes(paths.dockerBarrel));
  assert.ok(!engine.entrypoints.includes(paths.dockerFake));
  assert.ok(!engine.entrypoints.includes(paths.dockerNode));
});

test("installed Foundation parser detects a nonliteral runtime reference", async () => {
  const diagnostics = await analyzeFixture({
    [paths.claude]: "const hidden = '../legacy/legacy-contained-turn-ports.js';\nvoid import(hidden);\n",
  });
  assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.unresolved-runtime-reference"]);
});

test("a forbidden boundary cannot import a legal target entrypoint", async () => {
  const diagnostics = await analyzeFixture({
    [paths.core]: "import type {} from '../adapters/outbound/legacy/legacy-contained-turn-ports.js';\n",
    [paths.legacy]: "export {};\n",
  });
  assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.forbidden-boundary-dependency"]);
});

test("existing Host and SDK capabilities retain their exact ownership", async () => {
  const host = boundariesById.get("adapter.agent-execution.host-custody");
  assert.deepEqual(host.entrypoints, [
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-cooperative-process-custody.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.ts",
  ]);

  for (const builtin of ["node:os", "node:stream"]) {
    assert.deepEqual(await analyzeFixture({
      [`${host.roots[0]}/owned-import.ts`]: `import '${builtin}';\n`,
    }), []);
  }
  assert.deepEqual(await analyzeFixture({
    [paths.claude]: "import 'node:perf_hooks';\nimport type {} from '@anthropic-ai/claude-agent-sdk';\n",
  }), []);
});

test("Claude may import only narrow provider-delegation and private-directory ports", async () => {
  assert.deepEqual(await analyzeFixture({
    [paths.claude]: [
      "import type {} from '../provider-delegation-ports/contained-turn-provider-delegation-port.js';",
      "import type {} from '../provider-delegation-ports/private-directory-custody-port.js';",
    ].join("\n"),
  }), []);

  for (const [targetPath, specifier] of [
    [paths.legacy, "../legacy/legacy-contained-turn-ports.js"],
    [paths.host, "../host-custody/custodied-provider-process.js"],
    [paths.hostNode, "../host-custody/node-provider-process-custody.js"],
  ]) {
    const diagnostics = await analyzeFixture({
      [paths.claude]: `import type {} from '${specifier}';\n`,
      [targetPath]: "export {};\n",
    });
    assert.deepEqual(
      rules(diagnostics),
      ["architecture.source-dependencies.forbidden-boundary-dependency"],
      specifier,
    );
  }

  const diagnostics = await analyzeFixture({
    [paths.claude]: "import '../../../../../composition.js';\n",
    [paths.composition]: "export {};\n",
  });
  assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.forbidden-boundary-dependency"]);

  assert.deepEqual(await analyzeFixture({
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/negative-fixture.ts":
      "import type {} from '../legacy/legacy-contained-turn-ports.js';\n",
    [paths.legacy]: "export {};\n",
  }), []);
});

test("Docker custody may import the port but not concrete engines or the barrel", async () => {
  assert.deepEqual(await analyzeFixture({
    [paths.docker]: "import type {} from './engine/docker-engine-port.js';\n",
    [paths.dockerPort]: "export {};\n",
  }), []);

  for (const [targetPath, specifier] of [
    [paths.dockerFake, "./engine/fake-docker-engine.js"],
    [paths.dockerNode, "./engine/node-unix-socket-docker-engine.js"],
    [paths.dockerBarrel, "./engine/index.js"],
  ]) {
    const diagnostics = await analyzeFixture({
      [paths.docker]: `import type {} from '${specifier}';\n`,
      [targetPath]: "export {};\n",
    });
    assert.deepEqual(
      rules(diagnostics),
      ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"],
      specifier,
    );
  }
});
