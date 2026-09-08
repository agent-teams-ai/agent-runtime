import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const packagePaths = [
  "packages/platform/filesystem-custody",
  "packages/contexts/runtime-security",
  "packages/contexts/runtime-configuration",
  "packages/contexts/provider-access",
  "packages/contexts/agent-execution",
  "packages/apps/embedded-runtime",
];

const run = (command: string, args: string[], cwd: string): string => {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};

test("installed archives expose async composition and preserve passive sibling access", { timeout: 360_000 }, async t => {
  assert.equal(run("pnpm", ["--version"], repositoryRoot), "11.18.0", "packed verification requires pinned pnpm");
  const root = await mkdtemp(join(tmpdir(), "ar-packed-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archives = join(root, "archives");
  const consumer = join(root, "consumer");
  await mkdir(archives);
  await mkdir(consumer);
  const dependencies: Record<string, string> = {
    "@get-modular/core": "0.1.0", "@get-modular/assembly": "0.1.0",
  };
  for (const packagePath of packagePaths) {
    const source = join(repositoryRoot, packagePath);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    const before = new Set(await readdir(archives));
    run("pnpm", ["pack", "--pack-destination", archives], source);
    const added = (await readdir(archives)).filter(name => !before.has(name));
    assert.equal(added.length, 1, `one archive required for ${manifest.name}`);
    dependencies[manifest.name] = `file:${join(archives, added[0]!)}`;
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "disposable-agent-runtime-packed-consumer", private: true, type: "module",
    packageManager: "pnpm@11.18.0", dependencies,
    devDependencies: { typescript: "7.0.2", "@types/node": "24.13.3" },
  }));
  await writeFile(join(consumer, "pnpm-workspace.yaml"), JSON.stringify({ overrides: dependencies, minimumReleaseAgeExclude: ["@get-modular/core@0.1.0", "@get-modular/assembly@0.1.0"] }));
  // Missing cache entries are a concrete failure, never a skip or a source fallback.
  run("pnpm", ["install", "--offline", "--ignore-scripts", "--config.node-linker=hoisted"], consumer);
  const installedConsumer = await realpath(consumer);
  for (const name of Object.keys(dependencies)) {
    const installed = await realpath(join(consumer, "node_modules", name));
    assert.ok(installed.startsWith(`${installedConsumer}${sep}`), `${name} escaped disposable install`);
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    if (name.startsWith("@get-modular/")) { assert.equal(manifest.version, "0.1.0"); }
    for (const value of Object.values(manifest.dependencies ?? {})) {
      assert.doesNotMatch(String(value), /^(?:workspace:|link:|catalog:)/u);
    }
  }
  await writeFile(join(consumer, "verify.mjs"), `
import assert from 'node:assert/strict';
import * as ordinary from '@agent-teams/embedded-runtime';
import * as composition from '@agent-teams/embedded-runtime/composition';
assert.deepEqual(Object.keys(ordinary), []);
assert.equal('createAgentRuntimeHost' in composition, false);
assert.equal('createRuntimeSetupAttempt' in composition, false);
assert.throws(() => import.meta.resolve('@agent-teams/embedded-runtime/dist/composition/agent-runtime-host.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const pending = composition.createDefaultAgentRuntimeHost();
assert.ok(pending instanceof Promise);
const host = await pending;
const access = host.bindAccess({});
try {
  const codex = await access.codexSetup.inspect({});
  const claude = await access.claudeCodeSetup.inspect();
  assert.deepEqual(codex, { diagnostics: [{ code: 'capability_unavailable' }], status: 'unsupported' });
  assert.equal(claude.status, 'unsupported');
  assert.deepEqual(claude.diagnostics, [{ code: 'capability_unavailable' }]);
  assert.ok(Object.isFrozen(codex));
  assert.ok(Object.isFrozen(claude));
} finally {
  await host[Symbol.asyncDispose]();
}
await host.dispose();
assert.throws(() => host.bindAccess({}), /Host is disposed/u);
await assert.rejects(access.codexSetup.inspect({}), /Host is disposed/u);
await assert.rejects(access.claudeCodeSetup.inspect(), /Host is disposed/u);
`);
  await writeFile(join(consumer, "consumer.ts"), `
import type { RuntimeAccessHandle } from '@agent-teams/embedded-runtime';
import { createDefaultAgentRuntimeHost, type AgentRuntimeHost } from '@agent-teams/embedded-runtime/composition';
// @ts-expect-error Synchronous leaf is not exported from the installed composition root.
import { createAgentRuntimeHost } from '@agent-teams/embedded-runtime/composition';
void createAgentRuntimeHost;
const pending: Promise<AgentRuntimeHost> = createDefaultAgentRuntimeHost();
// @ts-expect-error Async bootstrap must be awaited.
const missingAwait: AgentRuntimeHost = pending;
void missingAwait;
const host: AgentRuntimeHost = await pending;
const access: RuntimeAccessHandle = host.bindAccess({});
void access;
await host[Symbol.asyncDispose]();
`);
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false },
    files: ["consumer.ts"],
  }));
  run(join(consumer, "node_modules", ".bin", "tsc"), ["--project", "tsconfig.json", "--pretty", "false"], consumer);
  run(process.execPath, ["verify.mjs"], consumer);
});
