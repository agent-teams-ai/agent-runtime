import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDocument } from "yaml";

// Run only in a disposable consumer with the actual installed Foundation.
const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = "architecture/foundation/source-dependencies.yaml";
const source = await readFile(join(root, configPath), "utf8");
const document = parseDocument(source, { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const policy = document.toJS();
const manifestPath = fileURLToPath(import.meta.resolve("@agent-teams/engineering-foundation/package.json"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const cli = join(dirname(manifestPath), manifest.bin["agent-teams-foundation"]);
const agent = "packages/contexts/agent-execution/src/features/contained-agent-turn/";
const embedded = "packages/apps/embedded-runtime/src/";
const provider = "packages/contexts/provider-access/src/features/contained-turn-access/";
const approved = [
  `${agent}adapters/outbound/codex-app-server/codex-app-server-provider-options.ts`,
  `${agent}adapters/outbound/codex-app-server/codex-app-server-receipt-identity.ts`,
  `${agent}composition/codex-credential-output-inventory.ts`,
  `${agent}composition/preparation-scope-anti-corruption.ts`,
  `${agent}composition/provider-access-anti-corruption.ts`,
  `${embedded}composition/contained-turn-feature-composition.ts`,
  `${provider}adapters/provider-access-data.ts`,
];
const forbidden = "architecture.source-dependencies.forbidden-builtin-dependency";

async function analyze(files, config = policy) {
  const consumer = await mkdtemp(join(tmpdir(), "runtime-builtin-counterexample-"));
  const write = async (path, content = "export {};\n") => {
    await mkdir(dirname(join(consumer, path)), { recursive: true });
    await writeFile(join(consumer, path), content);
  };
  try {
    for (const path of config.governedRoots) {
      await mkdir(join(consumer, path), { recursive: true });
    }
    for (const boundary of config.boundaries) {
      for (const path of boundary.roots) {
        if (path.endsWith(".ts")) {
          await write(path);
        } else {
          await mkdir(join(consumer, path), { recursive: true });
        }
      }
      for (const path of boundary.entrypoints) {
        await write(path);
      }
    }
    await write("package.json", JSON.stringify({ name: "runtime-builtin-counterexample", private: true, type: "module" }));
    await write("pnpm-workspace.yaml", "packages: []\n");
    await write(configPath, JSON.stringify(config));
    await write("foundation.config.yaml", JSON.stringify({
      schemaVersion: 1, project: { id: "runtime-builtin-counterexample" },
      capabilities: { "architecture.source-dependencies": { configPath } },
    }));
    for (const [path, content] of Object.entries(files)) {
      await write(path, content);
    }
    const result = spawnSync(process.execPath, [cli, "check", "architecture.source-dependencies",
      "--consumer", consumer, "--json"], { cwd: consumer, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.foundationVersion, "1.2.0");
    assert.equal(envelope.capabilities.length, 1);
    const [report] = envelope.capabilities;
    assert.equal(report.capabilityConfigSchemaVersion, 1);
    assert.ok(["passed", "violations"].includes(report.outcome), result.stdout);
    assert.equal(result.status, report.outcome === "passed" ? 0 : 1, result.stderr);
    return report.diagnostics;
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function expectForbidden(diagnostics, paths) {
  assert.deepEqual(diagnostics.map(d => d.ruleId), paths.map(() => forbidden));
  assert.deepEqual(diagnostics.map(d => d.location.path).toSorted(), [...paths].toSorted());
}

test("all seven actual getBuiltinModule roles pass; removing util reproduces exactly seven failures", async () => {
  assert.equal(policy.schemaVersion, 1);
  const files = Object.fromEntries(await Promise.all(approved.map(async path => {
    const actual = await readFile(join(root, path), "utf8");
    assert.match(actual, /process\.getBuiltinModule\("node:util"\)/u, path);
    assert.match(actual, /isProxy/u, path);
    return [path, 'const types = process.getBuiltinModule("node:util").types;\nexport const rejectProxy = types.isProxy;\n'];
  })));
  assert.deepEqual(await analyze(files), []);
  const withoutApproval = structuredClone(policy);
  for (const boundary of withoutApproval.boundaries) {
    if (boundary.roots.some(path => approved.includes(path))) {
      boundary.allow.builtins = boundary.allow.builtins.filter(name => name !== "node:util");
    }
  }
  expectForbidden(await analyze(files, withoutApproval), approved);
});

test("approved roles still reject another builtin through both ambient lookup and import", async () => {
  for (const content of ['void process.getBuiltinModule("node:vm");\n', 'import "node:vm";\n']) {
    expectForbidden(await analyze(Object.fromEntries(approved.map(path => [path, content]))), approved);
  }
});

test("domain, application, sibling adapters and sibling composition never inherit util", async () => {
  const paths = [
    `${agent}domain/builtin-counterexample.ts`, `${agent}application/builtin-counterexample.ts`,
    `${provider}domain/builtin-counterexample.ts`, `${provider}application/builtin-counterexample.ts`,
    `${embedded}domain/builtin-counterexample.ts`, `${embedded}application/builtin-counterexample.ts`,
    `${agent}adapters/outbound/codex-app-server/builtin-counterexample.ts`,
    `${agent}composition/builtin-counterexample.ts`, `${embedded}composition/builtin-counterexample.ts`,
    `${provider}adapters/builtin-counterexample.ts`,
    `${provider}domain/provider-access-binding.ts`,
    `${provider}application/ports/outbound/provider-access-binding-repository.ts`,
    `${embedded}application/trusted-claude-code-setup-scope.ts`,
    `${agent}composition/dispatch-grant-anti-corruption.ts`,
    `${agent}adapters/outbound/codex-app-server/codex-app-server-jsonl.ts`,
    `${embedded}composition/contained-turn-runtime-access.ts`,
  ];
  for (const content of ['void process.getBuiltinModule("node:util");\n', 'import "node:util";\n']) {
    expectForbidden(await analyze(Object.fromEntries(paths.map(path => [path, content]))), paths);
  }
});

test("nonliteral builtin lookup and core-to-adapter access remain errors", async () => {
  const diagnostics = await analyze({
    [approved[0]]: 'const builtin = "node:util"; void process.getBuiltinModule(builtin);\n',
    [`${agent}domain/builtin-counterexample.ts`]: 'import "../adapters/outbound/codex-app-server/codex-app-server-provider-options.js";\n',
  });
  assert.deepEqual(diagnostics.map(d => d.ruleId).toSorted(), [
    "architecture.source-dependencies.forbidden-boundary-dependency",
    "architecture.source-dependencies.unresolved-runtime-reference",
  ]);
});

test("V1 requires reciprocal feature/selection composition to share one boundary", async () => {
  const feature = approved[5];
  const selection = `${embedded}composition/contained-turn-provider-selection.ts`;
  const files = {
    [feature]: 'import { select } from "./contained-turn-provider-selection.js"; export interface Options {} export const use = select;\n',
    [selection]: 'import type { Options } from "./contained-turn-feature-composition.js"; export const select = (value: Options) => value;\n',
  };
  assert.deepEqual(await analyze(files), []);
  const split = structuredClone(policy);
  const owner = split.boundaries.find(boundary => boundary.roots.includes(feature));
  owner.roots = owner.roots.filter(path => path !== selection);
  owner.allow.boundaries.push("composition.counterexample.selection");
  split.boundaries.push({
    id: "composition.counterexample.selection", dependencyMode: "runtime", roots: [selection], entrypoints: [selection],
    allow: { boundaries: [owner.id], packages: [], builtins: [], runtimeReferences: [] },
  });
  const diagnostics = await analyze(files, split);
  assert.deepEqual(diagnostics.map(d => d.ruleId), ["architecture.source-dependencies.boundary-runtime-cycle"]);
  const typeOnly = await analyze({
    [feature]: 'import type { Selection } from "./contained-turn-provider-selection.js"; export interface Options { selection?: Selection }\n',
    [selection]: 'import type { Options } from "./contained-turn-feature-composition.js"; export interface Selection { options?: Options }\n',
  }, split);
  assert.deepEqual(typeOnly.map(d => d.ruleId), ["architecture.source-dependencies.boundary-type-only-cycle"]);
});
