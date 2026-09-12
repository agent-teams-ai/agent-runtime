import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDocument } from "yaml";

import { parseSync } from "oxc-parser";

const foundationManifestPath = fileURLToPath(import.meta.resolve("@agent-teams/engineering-foundation/package.json"));
const foundationManifest = JSON.parse(await readFile(foundationManifestPath, "utf8"));
const foundationCli = join(dirname(foundationManifestPath), foundationManifest.bin["agent-teams-foundation"]);

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const configPath = "architecture/foundation/source-dependencies.yaml";
const configSource = await readFile(join(repositoryRoot, configPath), "utf8");
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const document = parseDocument(configSource, { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const rawPolicy = document.toJS();
const policy = {
  ...rawPolicy,
  boundaries: rawPolicy.boundaries.map(boundary => ({
    ...boundary,
    allowedBoundaries: boundary.allow.boundaries ?? [],
    allowedBuiltins: boundary.allow.builtins ?? [],
    allowedPackages: boundary.allow.packages ?? [],
    allowedRuntimeReferences: boundary.allow.runtimeReferences ?? [],
  })),
};
const boundariesById = new Map(policy.boundaries.map(boundary => [boundary.id, boundary]));

const paths = {
  claude: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/negative-fixture.ts",
  composition: "packages/contexts/agent-execution/src/composition.ts",
  core: "packages/contexts/agent-execution/src/features/contained-agent-turn/application/negative-fixture.ts",
  docker: "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.ts",
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

const livePathIsFile = async path => {
  try {
    return (await lstat(join(repositoryRoot, path))).isFile();
  } catch {
    return /\.(?:[cm]?[jt]s)$/u.test(path);
  }
};

const copyWorkspacePackageManifests = async root => {
  for (const packageRoot of Object.keys({
    "packages/apps/embedded-runtime": true,
    "packages/contexts/agent-execution": true,
    "packages/contexts/provider-access": true,
    "packages/contexts/runtime-configuration": true,
    "packages/contexts/runtime-security": true,
    "packages/platform/filesystem-custody": true,
  })) {
    await writeFixtureFile(
      root,
      `${packageRoot}/package.json`,
      await readFile(join(repositoryRoot, packageRoot, "package.json"), "utf8"),
    );
  }
};

const analyzeFixture = async files => {
  const root = await mkdtemp(join(tmpdir(), "ar-foundation-boundaries-"));
  try {
    for (const governedRoot of policy.governedRoots) {
      await mkdir(join(root, governedRoot), { recursive: true });
    }
    for (const boundary of policy.boundaries) {
      for (const path of boundary.roots) {
        if (await livePathIsFile(path)) {
          await writeFixtureFile(root, path);
        } else {
          await mkdir(join(root, path), { recursive: true });
          if ((boundary.packageExports ?? []).length > 0) {
            await writeFixtureFile(root, `${path}/__boundary-package-owner__.js`);
          }
        }
      }
    }
    await writeFixtureFile(root, "package.json", JSON.stringify({
      dependencies: { "@anthropic-ai/claude-agent-sdk": "1.0.0", "@get-modular/core": "0.1.0", "@get-modular/assembly": "0.1.0" },
      name: "@vioxen/agent-runtime",
      private: true,
      type: "module",
    }));
    await writeFixtureFile(root, "pnpm-workspace.yaml", [
      "packages:",
      '  - "packages/apps/*"',
      '  - "packages/contexts/*"',
      '  - "packages/platform/*"',
      "",
    ].join("\n"));
    await copyWorkspacePackageManifests(root);
    await writeFixtureFile(root, configPath, configSource);
    for (const boundary of policy.boundaries) {
      for (const entrypoint of boundary.entrypoints) {
        await writeFixtureFile(root, entrypoint);
      }
    }
    for (const [path, source] of Object.entries(files)) {
      await writeFixtureFile(root, path, source);
    }

    await writeFixtureFile(root, "foundation.config.yaml", JSON.stringify({
      schemaVersion: 1,
      project: { id: "foundation-boundary-fixture" },
      capabilities: { "architecture.source-dependencies": { configPath } },
    }));
    const result = spawnSync(process.execPath, [foundationCli, "check",
      "architecture.source-dependencies", "--consumer", root, "--json"],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.capabilities.length, 1, JSON.stringify(envelope));
    const [report] = envelope.capabilities;
    assert.equal(report.capabilityId, "architecture.source-dependencies");
    assert.ok(report.outcome === "passed" || report.outcome === "violations", JSON.stringify(envelope));
    assert.equal(result.status, report.outcome === "passed" ? 0 : 1, result.stderr);
    return report.diagnostics;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const rules = diagnostics => diagnostics.map(diagnostic => diagnostic.ruleId);

test("the named negative suite runs exactly once through every Foundation gate", () => {
  assert.equal(
    manifest.scripts["foundation:boundaries:negative"],
    "node --test scripts/architecture/source-dependency-adapter-boundaries.test.mjs scripts/docs/runtime-builtin-permissions.test.mjs",
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
  const host = "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody";
  for (const [path, builtins] of [
    [`${composition}/agent-runtime-host.ts`, ["node:crypto", "node:util"]],
    [`${composition}/contained-turn-access-authority.ts`, ["node:util"]],
    [`${composition}/contained-turn-authority-capability.ts`, ["node:util"]],
    ["packages/apps/embedded-runtime/src/features/contained-turn-route-qualification/contained-turn-route-qualification.ts", ["node:fs"]],
    ["packages/apps/embedded-runtime/src/features/trusted-runtime-access-scope/trusted-runtime-access-scope.ts", ["node:util"]],
    [`${host}/egress/node-tls-http-egress-transport-support.ts`,
      ["node:buffer", "node:crypto", "node:net", "node:tls"]],
    [`${host}/docker/node-linux-exclusive-route.ts`,
      ["node:child_process", "node:crypto", "node:fs", "node:timers"]],
    ["packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-config-wire.ts",
      ["node:crypto", "node:util"]],
  ]) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    const parsed = parseSync(path, source);
    assert.deepEqual(parsed.errors, [], path);
    assert.deepEqual(parsed.module.dynamicImports, [], path);
    const observed = parsed.module.staticImports
      .map(reference => reference.moduleRequest.value)
      .filter(specifier => specifier.startsWith("node:"));
    assert.deepEqual(observed.toSorted(), builtins, path);
    assert.deepEqual(await analyzeFixture({
      [path]: observed.map(specifier => `import '${specifier}';`).join("\n"),
    }), [], path);
  }
});

test("Node permissions do not follow imports moved into core or undeclared adapter locations", async () => {
  const classified = [
    "packages/contexts/agent-execution/src/features/contained-agent-turn/domain/moved-node-dependency.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/application/moved-node-dependency.ts",
  ];
  const unclassified = [
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/undeclared/moved-node-dependency.ts",
    "packages/apps/embedded-runtime/src/domain/moved-node-dependency.ts",
    "packages/apps/embedded-runtime/src/application/moved-node-dependency.ts",
    "packages/apps/embedded-runtime/src/adapters/undeclared/moved-node-dependency.ts",
  ];
  for (const builtin of ["node:buffer", "node:timers", "node:util"]) {
    for (const path of classified) {
      const diagnostics = await analyzeFixture({ [path]: `import '${builtin}';\n` });
      assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.forbidden-builtin-dependency"], path);
      assert.equal(diagnostics[0].location.path, path);
      assert.deepEqual(diagnostics[0].evidence, [{ kind: "specifier", value: builtin }]);
    }
    for (const path of unclassified) {
      const diagnostics = await analyzeFixture({ [path]: `import '${builtin}';\n` });
      assert.deepEqual(rules(diagnostics), ["architecture.source-dependencies.unclassified-source-file"], path);
    }
  }
});

test("Embedded Runtime Node utility permission belongs only to composition", () => {
  const composition = boundariesById.get("composition.embedded-runtime");
  assert.deepEqual(composition.roots, [
    "packages/apps/embedded-runtime/src/composition.ts",
    "packages/apps/embedded-runtime/src/composition/agent-runtime-host-creation-error.ts",
    "packages/apps/embedded-runtime/src/composition/default-agent-runtime-host.ts",
    "packages/apps/embedded-runtime/src/composition/host-custodied-agent-runtime-host.ts",
    "packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts",
  ]);
  // composition.ts re-exports the linux-codex/http-egress/darwin routing
  // cluster, the contained-turn and contained-turn-support roles, and
  // access-contracts; PR69 grew this directory well beyond a single
  // entrypoint file. agent-runtime-host.ts (the only remaining real
  // getBuiltinModule("node:util") consumer under this root) moved into its
  // own role so this catch-all root itself no longer grants node:util.
  assert.deepEqual(composition.allowedBoundaries, [
    "production.embedded-runtime",
    "composition.embedded-runtime.contained-turn",
    "composition.embedded-runtime.contained-turn-support",
    "composition.embedded-runtime.contained-turn-routing",
    "composition.embedded-runtime.agent-runtime-host",
    "core.embedded-runtime.access-contracts",
  ]);
  // The async-assembly-adapter Assembly root (runtime-setup-assembly.ts,
  // default-agent-runtime-host.ts, agent-runtime-host-creation-error.ts) uses
  // node:crypto directly and isn't yet carved into its own narrower role.
  assert.deepEqual(composition.allowedBuiltins, ["node:crypto"]);
  assert.deepEqual(composition.allowedRuntimeReferences, []);
  const production = boundariesById.get("production.embedded-runtime");
  // build-claude-code-setup-view.ts/build-codex-setup-view.ts reach the
  // contained-turn, contained-turn-support and access-contracts entrypoints.
  assert.deepEqual(production.allowedBoundaries, [
    "composition.embedded-runtime.contained-turn",
    "composition.embedded-runtime.contained-turn-support",
    "core.embedded-runtime.access-contracts",
  ]);
  // The two setup-view builders derive opaque reference digests through an
  // injected port now; node:crypto moved to the composition-owned adapter
  // (agent-runtime-host role), so application no longer needs it directly.
  assert.deepEqual(production.allowedBuiltins, ["node:timers/promises"]);
});

test("transitional boundaries and adapter permissions remain exact", () => {
  const legacy = boundariesById.get("adapter.agent-execution.legacy-contained-turn-ports");
  const claude = boundariesById.get("adapter.agent-execution.claude-agent-sdk");
  const delegation = boundariesById.get("adapter.agent-execution.provider-delegation-ports");
  const production = boundariesById.get("production.agent-execution");
  const composition = boundariesById.get("composition.agent-execution.contained-turn");

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
  // accepted-authority-anti-corruption.ts and authority-owner-boundary.ts import
  // provider-access-anti-corruption.ts, which imports both of them back (a real
  // reciprocal cycle once PR69's provider-access wiring is counted), so they
  // moved into composition.agent-execution.boundary-data alongside it. Only
  // host-post-claim-preparation.ts (no such cycle) remains in this role.
  assert.deepEqual(composition.roots, [
    "packages/contexts/agent-execution/src/features/contained-agent-turn/composition/host-post-claim-preparation.ts",
  ]);
  assert.deepEqual(composition.entrypoints, composition.roots);
  assert.deepEqual(composition.allowedBoundaries, [
    "adapter.agent-execution.host-custody",
    "core.agent-execution.contained-turn",
  ]);
  assert.deepEqual(composition.allowedPackages, []);
  assert.deepEqual(composition.allowedBuiltins, ["node:util"]);
  assert.deepEqual(composition.allowedRuntimeReferences, []);
  assert.deepEqual(production.allowedBoundaries, [
    "adapter.agent-execution.claude-agent-sdk",
    "adapter.agent-execution.codex-app-server",
    "adapter.agent-execution.docker-custody",
    "adapter.agent-execution.host-custody",
    "adapter.agent-execution.legacy-contained-turn-ports",
    "adapter.agent-execution.provider-delegation-ports",
    "composition.agent-execution.contained-turn",
    "core.agent-execution.contained-turn",
    "adapter.agent-execution.codex-data",
    "adapter.agent-execution.codex-primitives",
    "adapter.agent-execution.codex-primitives-leaves",
    "adapter.agent-execution.codex-native-broker",
    "composition.agent-execution.boundary-data",
    "composition.agent-execution.dispatch-grant",
  ]);
  assert.ok(!production.allowedBuiltins.includes("node:util"));
  assert.ok(!production.entrypoints.includes(paths.legacy));
});

test("Docker custody uses only the engine port and explicit residue construction entrypoint", () => {
  const engine = boundariesById.get("adapter.agent-execution.docker-engine");
  const custody = boundariesById.get("adapter.agent-execution.docker-custody");
  const json = boundariesById.get("adapter.agent-execution.docker-json");

  assert.deepEqual(engine.entrypoints, [paths.dockerPort, paths.dockerConstruction]);
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
    // internal.ts consumes the exact Darwin route readback directly.
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-route-durable-storage.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/native-host-custody-workspace-entrypoint.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-open-attempts.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-bridge.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-selection.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-singleton-custody-owner.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-admission-guard.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/egress/prepared-http-request-v1.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-finalizable-plan.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/native-host-custody-workspace-authority.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-core.ts",
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.ts",
  ]);

  assert.deepEqual(host.allowedBuiltins, [
    "node:buffer", "node:child_process", "node:crypto", "node:dns/promises",
    "node:events", "node:fs", "node:fs/promises", "node:net", "node:os",
    "node:path", "node:stream", "node:timers/promises", "node:tls", "node:util",
  ]);

  for (const builtin of ["node:dns/promises", "node:net", "node:os", "node:stream", "node:tls"]) {
    assert.deepEqual(await analyzeFixture({
      [paths.hostNode]: `import '${builtin}';\n`,
    }), []);
  }
  assert.deepEqual(await analyzeFixture({
    [paths.claude]: "import 'node:perf_hooks';\nimport type {} from '@anthropic-ai/claude-agent-sdk';\n",
  }), []);
});

test("Darwin retained-owner consumers use the narrow workspace entrypoint", async () => {
  const internal = "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-io.ts";
  assert.deepEqual(await analyzeFixture({
    [paths.composition]: `import type {DarwinAttemptRetainedOwners} from './features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-workspace-entrypoint.js';\n`,
  }), []);
  assert.deepEqual(rules(await analyzeFixture({
    [paths.composition]: `import type {DarwinAttemptRetainedOwners} from './features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-io.js';\n`,
    [internal]: "export interface DarwinAttemptRetainedOwners {}\n",
  })), ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);
});

test("Codex evidence utilities do not grant spawn or network ownership", async () => {
  const path = "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-notification-evidence.ts";
  const hostInternal = "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-contracts.ts";
  // The former direct getBuiltinModule("node:util") consumers under this root
  // (effect-custody/permission-boundary/platform-tuple/config-wire/native
  // -broker-recipe) moved into the narrower codex-primitives/codex-primitives
  // -leaves/codex-native-broker roles; remaining codex-app-server internals
  // do not inherit node:util from that split.
  assert.deepEqual(rules(await analyzeFixture({ [path]: "import 'node:util';\n" })),
    ["architecture.source-dependencies.forbidden-builtin-dependency"]);
  for (const builtin of ["node:child_process", "node:dns/promises", "node:http", "node:net", "node:tls", "node:timers"]) {
    assert.deepEqual(rules(await analyzeFixture({ [path]: `import '${builtin}';\n` })),
      ["architecture.source-dependencies.forbidden-builtin-dependency"]);
  }
  assert.deepEqual(rules(await analyzeFixture({
    [path]: "import '../host-custody/contained-turn-kernel-custody-contracts.js';\n",
    [hostInternal]: "export {};\n",
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
    "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-active-turn.ts":
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
    entry.replace("docker-http-listener-entrypoint.ts", "docker-provider-process-entrypoint.ts"),
    entry.replace("docker-http-listener-entrypoint.ts", "node-linux-route-privilege.ts")]);
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
  const parsed = parseSync(composition, source);
  assert.deepEqual(parsed.errors, []);
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
  const owners = new Set(["composition.embedded-runtime", "test.embedded-runtime"]);
  for (const boundary of policy.boundaries) {
    assert.deepEqual(boundary.allowedPackages.filter(name => packages.includes(name)).toSorted(),
      owners.has(boundary.id) ? packages.toSorted() : [], boundary.id);
  }
  for (const pkg of packages) {
    for (const statement of [`import '${pkg}';`, `import type {} from '${pkg}';`]) {
      assert.deepEqual(await analyzeFixture({
        "packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts": statement,
      }), []);
      for (const root of [
        "packages/contexts/agent-execution/src/features/contained-agent-turn",
        "packages/contexts/runtime-configuration/src",
        "packages/contexts/runtime-security/src",
      ]) {
        for (const layer of ["application", "contracts", "domain"]) {
          const path = `${root}/${layer}/negative-get-modular.ts`;
          const diagnostics = await analyzeFixture({ [path]: statement });
          assert.ok(
            rules(diagnostics).includes("architecture.source-dependencies.forbidden-package-dependency"),
            `${path}: ${JSON.stringify(rules(diagnostics))}`,
          );
          assert.equal(
            diagnostics.find(d => d.ruleId === "architecture.source-dependencies.forbidden-package-dependency").location.path,
            path,
          );
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


test("Darwin native launch consumers use declared custody and Codex entrypoints", async () => {
  const base = "packages/contexts/agent-execution/src/features/contained-agent-turn";
  const cases = [
    {consumer: `${base}/adapters/outbound/codex-app-server/codex-app-server-launch-plan.ts`,
      prefix: "../host-custody/", owner: `${base}/adapters/outbound/host-custody/`,
      entry: "contained-turn-kernel-custody-entrypoint", internal: "contained-turn-kernel-custody-contracts"},
    {consumer: `${base}/composition/darwin-codex-host-post-claim-preparation.ts`,
      prefix: "../adapters/outbound/codex-app-server/", owner: `${base}/adapters/outbound/codex-app-server/`,
      entry: "codex-app-server-launch-plan", internal: "codex-app-server-notification-evidence"},
  ];
  for (const {consumer, prefix, owner, entry, internal} of cases) {
    assert.deepEqual(await analyzeFixture({[consumer]: `import '${prefix}${entry}.js';\n`}), []);
    assert.deepEqual(rules(await analyzeFixture({
      [consumer]: `import '${prefix}${internal}.js';\n`,
      [`${owner}${internal}.ts`]: "export {};\n",
    })), ["architecture.source-dependencies.cross-boundary-local-import-not-entrypoint"]);
  }
});

test("source v3 rejects includeRootPackage as an unknown public field", async () => {
  const root = await mkdtemp(join(tmpdir(), "ar-foundation-include-root-"));
  try {
    await writeFixtureFile(root, "package.json", JSON.stringify({
      name: "@vioxen/agent-runtime",
      private: true,
      type: "module",
    }));
    await writeFixtureFile(root, "pnpm-workspace.yaml", "packages: []\n");
    await writeFixtureFile(root, configPath, `${configSource}\nincludeRootPackage: true\n`);
    await writeFixtureFile(root, "foundation.config.yaml", JSON.stringify({
      schemaVersion: 1,
      project: { id: "foundation-include-root-fixture" },
      capabilities: { "architecture.source-dependencies": { configPath } },
    }));
    const result = spawnSync(process.execPath, [foundationCli, "check",
      "architecture.source-dependencies", "--consumer", root, "--json"],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    const envelope = JSON.parse(result.stdout);
    assert.notEqual(envelope.outcome, "passed", JSON.stringify(envelope));
    assert.match(JSON.stringify(envelope), /includeRootPackage|unknown property|invalid-input/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
