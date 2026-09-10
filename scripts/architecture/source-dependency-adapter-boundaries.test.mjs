import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createSourceDependenciesCapability } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { loadCapabilityConfig } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/contract/config.js";
import { OxcSourceDependencyParser } from "../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/adapters/outbound/oxc/oxc-source-dependency-parser.js";

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
  dockerConstruction: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-composition.ts",
  dockerJson: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/serialization/strict-json.ts",
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
      dependencies: { "@anthropic-ai/claude-agent-sdk": "1.0.0", "@get-modular/core": "0.1.0", "@get-modular/assembly": "0.1.0" },
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

test("the real parser observes every retained Node import in composition and TLS support", async () => {
  const composition = "packages/apps/embedded-runtime/src/composition";
  const host = boundariesById.get("adapter.agent-execution.host-custody");
  const parser = new OxcSourceDependencyParser();
  for (const [path, builtins] of [
    [`${composition}/agent-runtime-host.ts`, ["node:crypto", "node:util"]],
    [`${composition}/contained-turn-access-authority.ts`, ["node:util"]],
    [`${composition}/contained-turn-authority-capability.ts`, ["node:util"]],
    [`${composition}/contained-turn-route-qualification.ts`, ["node:fs"]],
    [`${composition}/trusted-runtime-access-scope.ts`, ["node:util"]],
    [`${host.roots[0]}/egress/node-tls-http-egress-transport-support.ts`,
      ["node:buffer", "node:crypto", "node:net", "node:tls"]],
    [`${host.roots[0]}/docker/node-linux-exclusive-route.ts`,
      ["node:child_process", "node:crypto", "node:fs", "node:timers"]],
    ["packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-config-wire.ts",
      ["node:crypto", "node:util"]],
  ]) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    const parsed = parser.parse({ path, source });
    assert.equal(parsed.parseErrorCount, 0, path);
    assert.deepEqual(parsed.unresolved, [], path);
    const observed = parsed.references.filter(reference => reference.specifier.startsWith("node:"));
    assert.deepEqual(observed.map(reference => reference.specifier).toSorted(), builtins, path);
    assert.ok(observed.every(reference => reference.kind === "static"), path);
    assert.deepEqual(await analyzeFixture({
      [path]: observed.map(reference => `import '${reference.specifier}';`).join("\n"),
    }), [], path);
  }
});

test("Node permissions do not follow imports moved into core or undeclared adapter locations", async () => {
  for (const root of [
    "packages/contexts/agent-execution/src/features/contained-agent-turn",
    "packages/apps/embedded-runtime/src",
  ]) {
    for (const layer of ["domain", "application", "adapters/undeclared"]) {
      const path = `${root}/${layer}/moved-node-dependency.ts`;
      for (const builtin of ["node:buffer", "node:timers", "node:util"]) {
        const diagnostics = await analyzeFixture({ [path]: `import '${builtin}';\n` });
        assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.forbidden-builtin-dependency"], path);
        assert.equal(diagnostics[0].location.path, path);
        assert.deepEqual(diagnostics[0].evidence, [{ kind: "specifier", value: builtin }]);
      }
    }
  }
});

test("Embedded Runtime Node utility permission belongs only to composition", () => {
  const composition = boundariesById.get("composition.embedded-runtime");
  assert.deepEqual(composition.roots, [
    "packages/apps/embedded-runtime/src/composition",
    "packages/apps/embedded-runtime/src/composition.ts",
  ]);
  assert.deepEqual(composition.allowedBoundaries, ["production.embedded-runtime"]);
  assert.deepEqual(composition.allowedBuiltins, ["node:crypto", "node:fs", "node:timers/promises", "node:util"]);
  assert.deepEqual(composition.allowedRuntimeReferences, []);
  const production = boundariesById.get("production.embedded-runtime");
  assert.deepEqual(production.allowedBoundaries, []);
  assert.deepEqual(production.allowedBuiltins, ["node:crypto", "node:timers/promises"]);
});

test("transitional boundaries and adapter permissions remain exact", () => {
  const legacy = boundariesById.get("adapter.agent-execution.legacy-contained-turn-ports");
  const claude = boundariesById.get("adapter.agent-execution.claude-agent-sdk");
  const delegation = boundariesById.get("adapter.agent-execution.provider-delegation-ports");
  const production = boundariesById.get("production.agent-execution");

  assert.deepEqual(legacy.roots, [dirname(paths.legacy)]);
  assert.deepEqual(legacy.entrypoints, [paths.legacy]);
  assert.deepEqual(legacy.allowedBoundaries, [
    "adapter.agent-execution.host-custody",
    "core.agent-execution.contained-turn",
  ]);
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
    "adapter.agent-execution.codex-app-server",
    "adapter.agent-execution.docker-custody",
    "adapter.agent-execution.host-custody",
    "adapter.agent-execution.legacy-contained-turn-ports",
    "adapter.agent-execution.provider-delegation-ports",
    "core.agent-execution.contained-turn",
  ]);
  assert.ok(!production.entrypoints.includes(paths.legacy));
});

test("Docker custody uses only the engine port and explicit residue construction entrypoint", () => {
  const engine = boundariesById.get("adapter.agent-execution.docker-engine");
  const custody = boundariesById.get("adapter.agent-execution.docker-custody");
  const json = boundariesById.get("adapter.agent-execution.docker-json");

  assert.deepEqual(engine.entrypoints, [paths.dockerConstruction, paths.dockerPort]);
  assert.deepEqual(engine.allowedBoundaries, ["adapter.agent-execution.docker-json"]);
  assert.deepEqual(engine.allowedPackages, []);
  assert.deepEqual(engine.allowedRuntimeReferences, []);
  assert.deepEqual(custody.allowedBoundaries, ["adapter.agent-execution.docker-engine", "adapter.agent-execution.docker-json"]);
  assert.deepEqual(json.entrypoints, [paths.dockerJson]);
  assert.deepEqual(json.allowedBoundaries, []);
  assert.deepEqual(json.allowedPackages, []);
  assert.deepEqual(json.allowedBuiltins, []);
  assert.deepEqual(json.allowedRuntimeReferences, []);
  assert.deepEqual(custody.allowedPackages, ["@agent-teams/filesystem-custody"]);
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
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-workspace-entrypoint.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-cooperative-process-custody.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/native-host-custody-workspace-entrypoint.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.ts",
  ]);

  assert.deepEqual(host.allowedBuiltins, [
    "node:buffer",
    "node:child_process",
    "node:crypto",
    "node:dns/promises",
    "node:events",
    "node:fs",
    "node:fs/promises",
    "node:net",
    "node:os",
    "node:path",
    "node:stream",
    "node:timers/promises",
    "node:tls",
    "node:util",
  ]);

  for (const builtin of ["node:dns/promises", "node:net", "node:os", "node:stream", "node:tls"]) {
    assert.deepEqual(await analyzeFixture({
      [`${host.roots[0]}/owned-import.ts`]: `import '${builtin}';\n`,
    }), []);
  }
  assert.deepEqual(await analyzeFixture({
    [paths.claude]: "import 'node:perf_hooks';\nimport type {} from '@anthropic-ai/claude-agent-sdk';\n",
  }), []);
});

test("Darwin retained-owner consumers use the narrow workspace entrypoint", async () => {
  const hostRoot = boundariesById.get("adapter.agent-execution.host-custody").roots[0];
  assert.deepEqual(await analyzeFixture({
    [paths.composition]: `import type {DarwinAttemptRetainedOwners} from './features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-workspace-entrypoint.js';\n`,
  }), []);
  assert.deepEqual(rules(await analyzeFixture({
    [paths.composition]: `import type {DarwinAttemptRetainedOwners} from './features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-bridge.js';\n`,
    [`${hostRoot}/darwin-attempt-owner-bridge.ts`]: "export interface DarwinAttemptRetainedOwners {}\n",
  })), ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);
});

test("Codex evidence utilities do not grant spawn or network ownership", async () => {
  const codex = boundariesById.get("adapter.agent-execution.codex-app-server");
  const path = `${codex.roots[0]}/negative-fixture.ts`;
  assert.deepEqual(await analyzeFixture({ [path]: "import 'node:util';\n" }), []);
  for (const builtin of ["node:child_process", "node:dns/promises", "node:http", "node:net", "node:tls", "node:timers"]) {
    assert.deepEqual(rules(await analyzeFixture({ [path]: `import '${builtin}';\n` })),
      ["architecture.source-dependencies.forbidden-builtin-dependency"]);
  }
  assert.deepEqual(rules(await analyzeFixture({
    [path]: "import '../host-custody/node-provider-process-custody-core.js';\n",
    [`${boundariesById.get("adapter.agent-execution.host-custody").roots[0]}/node-provider-process-custody-core.ts`]: "export {};\n",
  })), ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);
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

test("Docker custody may import the port and construction boundary, but not engine internals", async () => {
  assert.deepEqual(await analyzeFixture({
    [paths.docker]: "import type {} from './engine/docker-engine-port.js';\n",
    [paths.dockerPort]: "export {};\n",
  }), []);
  assert.deepEqual(await analyzeFixture({
    [paths.docker]: "import {NodeUnixSocketDockerEngine} from './engine/docker-engine-composition.js';\nvoid NodeUnixSocketDockerEngine;\n",
    [paths.dockerConstruction]: "export {NodeUnixSocketDockerEngine} from './node-unix-socket-docker-engine.js';\n",
    [paths.dockerNode]: "export class NodeUnixSocketDockerEngine {}\n",
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

test("Docker JSON remains neutral and cannot import its engine consumer", async () => {
  const diagnostics = await analyzeFixture({
    [paths.dockerJson]: "import type {} from '../engine/docker-engine-port.js';\n",
    [paths.dockerPort]: "export {};\n",
  });
  assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.forbidden-boundary-dependency"]);
});


test("V4 listener composition uses one Docker entrypoint; Host still cannot import it", async () => {
  const entry = "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-listener-entrypoint.ts";
  assert.deepEqual(boundariesById.get("adapter.agent-execution.docker-custody").entrypoints, [entry,
    entry.replace("docker-http-listener-entrypoint.ts", "docker-provider-process-entrypoint.ts")]);
  assert.deepEqual(await analyzeFixture({[paths.composition]: "import './features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-listener-entrypoint.js';\n"}), []);
  assert.deepEqual(rules(await analyzeFixture({[paths.host]: "import './docker/docker-http-listener-entrypoint.js';\n"})), ["architecture.source-dependencies.forbidden-boundary-dependency"]);
  const internal = entry.replace("docker-http-listener-entrypoint.ts", "docker-http-listener-lifecycle.ts");
  assert.deepEqual(rules(await analyzeFixture({[paths.composition]: "import './features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-listener-lifecycle.js';\n", [internal]: "export {};\n"})), ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);
});

test("Docker process composition uses its narrow entrypoint and a type-only Host projection", async () => {
  const base = "packages/contexts/agent-execution/src/features/contained-agent-turn";
  const composition = `${base}/composition/docker-custodied-provider-process.ts`;
  const entry = `${base}/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.ts`;
  const internal = entry.replace("docker-provider-process-entrypoint.ts", "docker-provider-process-bridge.ts");
  const source = await readFile(join(repositoryRoot, composition), "utf8");
  const parsed = new OxcSourceDependencyParser().parse({path: composition, source});
  assert.equal(parsed.parseErrorCount, 0);
  assert.deepEqual(parsed.unresolved, []);
  assert.deepEqual(await analyzeFixture({[composition]: source}), []);
  assert.match(source, /import type \{CustodiedProviderProcess, CustodiedProviderProcessRegistry\}/u);
  assert.deepEqual(rules(await analyzeFixture({[paths.host]: "import './docker/docker-provider-process-entrypoint.js';\n"})),
    ["architecture.source-dependencies.forbidden-boundary-dependency"]);
  assert.deepEqual(rules(await analyzeFixture({[paths.docker]: "import '../custodied-provider-process.js';\n"})),
    ["architecture.source-dependencies.forbidden-boundary-dependency"]);
  assert.deepEqual(rules(await analyzeFixture({[composition]: "import '../adapters/outbound/host-custody/docker/docker-provider-process-bridge.js';\n", [internal]: "export {};\n"})),
    ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);
});


test("native abort subscriptions stay in physical adapters, never core or outer composition", async () => {
  for (const path of [paths.docker, paths.dockerNode, paths.hostNode]) {
    assert.deepEqual(await analyzeFixture({[path]: 'import {addAbortListener} from "node:events";\n'}), [], path);
  }
  for (const path of [paths.core, paths.composition]) {
    assert.deepEqual(rules(await analyzeFixture({[path]: 'import {addAbortListener} from "node:events";\n'})),
      ["architecture.source-dependencies.forbidden-builtin-dependency"], path);
  }
});


test("Get Modular belongs only to Embedded Runtime composition, including type imports", async () => {
  const packages = ["@get-modular/core", "@get-modular/assembly"];
  for (const boundary of policy.boundaries) {
    assert.deepEqual(boundary.allowedPackages.filter(name => packages.includes(name)).toSorted(),
      boundary.id === "composition.embedded-runtime" ? packages.toSorted() : [], boundary.id);
  }
  for (const pkg of packages) {
    for (const statement of [`import '${pkg}';`, `import type {} from '${pkg}';`]) {
      assert.deepEqual(await analyzeFixture({
        "packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts": statement,
      }), []);
      for (const root of ["packages/apps/embedded-runtime/src",
        "packages/contexts/agent-execution/src/features/contained-agent-turn",
        "packages/contexts/runtime-configuration/src",
        "packages/contexts/runtime-security/src"]) {
        for (const layer of ["application", "contracts", "domain"]) {
          const path = `${root}/${layer}/negative-get-modular.ts`;
          const diagnostics = await analyzeFixture({ [path]: statement });
          assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.forbidden-package-dependency"], path);
          assert.equal(diagnostics[0].location.path, path);
        }
      }
    }
  }
});

test("Host custody cannot import the filesystem workspace owner backwards", async () => {
  const owner = "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-workspace-owner.ts";
  for (const prefix of ["import", "import type {} from"]) {
    const diagnostics = await analyzeFixture({
      [paths.host]: `${prefix} '../filesystem/node-contained-turn-workspace-owner.js';\n`,
      [owner]: "export {};\n",
    });
    assert.deepEqual(rules(diagnostics).toSorted(), [
      "architecture.source-dependencies.cross-boundary-local-import-not-entrypoint",
      "architecture.source-dependencies.forbidden-boundary-dependency",
    ]);
  }
});
