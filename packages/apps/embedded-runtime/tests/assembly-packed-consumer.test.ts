import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

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

type ArchivePin = { name: string; version: string; archiveSha256: string; archivePath: string };

// The profile pins retained bytes; the committed lock supplies their registry SRI.
// Never resolve a version or accept registry metadata as archive verification.
const withVerifiedArchives = async (
  root: string,
  readArchive: (pin: ArchivePin) => Promise<Buffer>,
  consume: (root: string, dependencies: Record<string, string>) => Promise<void>,
): Promise<void> => {
  const profile = JSON.parse(await readFile(join(repositoryRoot, "architecture/get-modular/consumer-profile.json"), "utf8"));
  const lock = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const verified: { pin: ArchivePin; bytes: Buffer }[] = [];
  for (const name of ["@get-modular/core", "@get-modular/assembly"]) {
    const pins: ArchivePin[] = profile.packages.filter((pin: ArchivePin) => pin.name === name);
    assert.equal(pins.length, 1, `one retained archive identity required: ${name}`);
    const pin = pins[0]!;
    assert.match(pin.archiveSha256, /^[a-f0-9]{64}$/u);
    const bytes = await readArchive(pin);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.archiveSha256, `profile archive identity mismatch: ${name}`);
    // Match only the packages resolution entry, never the snapshots entry.
    const entry = lock.split(`  '${name}@${pin.version}':\n`)[1];
    const integrity = /^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}/u.exec(entry ?? "")?.[1];
    assert.ok(integrity, `retained registry SRI required: ${name}`);
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, integrity, `lock archive identity mismatch: ${name}`);
    verified.push({ pin, bytes });
  }
  const archives = join(root, "archives");
  await mkdir(archives);
  const dependencies: Record<string, string> = {};
  for (const { pin, bytes } of verified) {
    const archive = join(archives, `${pin.name.split("/")[1]}.tgz`);
    // Write the verified buffer itself: no reread of a potentially replaced source.
    await writeFile(archive, bytes, { flag: "wx", mode: 0o400 });
    dependencies[pin.name] = `file:${archive}`;
  }
  await consume(root, dependencies);
};

const consumePackedArchives = async (root: string, dependencies: Record<string, string>): Promise<void> => {
  assert.equal(run("pnpm", ["--version"], repositoryRoot), "11.18.0", "packed verification requires pinned pnpm");
  const archives = join(root, "archives");
  const consumer = join(root, "consumer");
  await mkdir(consumer);
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
  // Core/Assembly and all local roots use the exact disposable archives.
  // Only remaining declared dependencies require registry retrieval.
  run("pnpm", ["install", "--ignore-scripts", "--config.node-linker=hoisted"], consumer);
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
};

test("installed archives expose async composition and preserve passive sibling access", { timeout: 360_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-packed-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withVerifiedArchives(root, pin => readFile(join(repositoryRoot, pin.archivePath)), consumePackedArchives);
});

test("verified retained archives are staged as exact consumer file dependencies", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-packed-verified-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retained = new Map<string, Buffer>();
  let consumed = false;
  await withVerifiedArchives(root, async pin => {
    const bytes = await readFile(join(repositoryRoot, pin.archivePath));
    retained.set(pin.name, bytes);
    return bytes;
  }, async (consumerRoot, dependencies) => {
    consumed = true;
    assert.equal(consumerRoot, root);
    assert.deepEqual(Object.keys(dependencies).sort(), ["@get-modular/assembly", "@get-modular/core"]);
    for (const [name, dependency] of Object.entries(dependencies)) {
      assert.ok(dependency.startsWith(`file:${join(root, "archives")}${sep}`));
      assert.deepEqual(await readFile(dependency.slice(5)), retained.get(name));
    }
  });
  assert.equal(consumed, true);
});

for (const name of ["@get-modular/core", "@get-modular/assembly"]) {
  test(`same-version wrong ${name} archive is rejected before consumer installation or behavior`, async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-packed-wrong-archive-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(withVerifiedArchives(root, async pin => {
      const bytes = await readFile(join(repositoryRoot, pin.archivePath));
      if (pin.name !== name) { return bytes; }
      const wrong = Buffer.from(bytes);
      // Change gzip MTIME only: a valid tgz with identical package/version and
      // executable payload still violates the retained exact archive identity.
      wrong[4] = wrong[4]! ^ 1;
      assert.deepEqual(gunzipSync(wrong), gunzipSync(bytes));
      return wrong;
    }, consumePackedArchives), new RegExp(`profile archive identity mismatch: ${name}`));
    assert.deepEqual(await readdir(root), [], "rejection must precede archive staging, install and behavior");
  });
}
