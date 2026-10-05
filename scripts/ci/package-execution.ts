import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { TestEvent } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import { observeEmbeddedProcesses, captureStream, assertCapturedIdentity } from './er-process-observer.ts';

import { validatePlatform, workflowIdentity, verifySource } from './product-workflow-contract.ts';
import type { ExecutionTarget, WorkflowIdentity } from './product-workflow-contract.ts';
export { validatePlatform, workflowIdentity } from './product-workflow-contract.ts';
export type { ExecutionTarget, WorkflowIdentity } from './product-workflow-contract.ts';

import { assertNativeAbsent, prepareNative, finishNative, nativeOutput } from './package-native-observation.ts';
import type { NativeBuild } from './package-native-observation.ts';
export { assertMachOArm64 } from './package-native-observation.ts';
export type { NativeBuild } from './package-native-observation.ts';

const build = 'tsc --project tsconfig.json --pretty false';
const clean = 'node -e "const fs=require(\'node:fs\'); for (const path of [\'dist\',\'.cache\']) fs.rmSync(path, { recursive: true, force: true })"';
// Independent source-reviewed whole-suite inventory. Script drift requires review.
export const packages = [
  { name: '@agent-teams/agent-execution', root: 'packages/contexts/agent-execution', build: `${build} && node scripts/copy-runtime-assets.mjs`, test: 'node --test --test-concurrency=1 tests/features/runtime-installation-discovery/*.test.ts tests/features/contained-agent-turn/*.test.ts tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs tests/package/*.test.ts', processes: 1 },
  { name: '@agent-teams/embedded-runtime', root: 'packages/apps/embedded-runtime', build, test: 'node scripts/run-package-tests.mjs', processes: 2 },
  { name: '@agent-teams/filesystem-custody', root: 'packages/platform/filesystem-custody', build: `${build} && node scripts/build-native-helper.mjs`, test: 'node --test --test-concurrency=1 tests/features/stable-filesystem-custody/stable-path-custody.test.ts tests/features/stable-filesystem-custody/stable-directory-process-lock.test.ts tests/features/stable-filesystem-custody/host-descriptors.test.mjs tests/features/stable-filesystem-custody/darwin-acquisition-guard.test.mjs tests/features/stable-filesystem-custody/host-errno.test.mjs tests/package/curated-assembly-surface.test.ts', processes: 1 },
  { name: '@agent-teams/provider-access', root: 'packages/contexts/provider-access', build, test: 'node --test --test-concurrency=1 tests/features/contained-turn-access/*.test.ts', processes: 1 },
  { name: '@agent-teams/runtime-configuration', root: 'packages/contexts/runtime-configuration', build, test: 'node --test --test-concurrency=1 tests/features/codex-configuration-inspection/codex-configuration-inspection.test.ts tests/features/codex-configuration-inspection/codex-application-boundary.test.ts tests/features/codex-configuration-inspection/semantic-boundary.test.ts tests/features/claude-code-configuration-inspection/claude-code-contract.test.ts tests/features/claude-code-configuration-inspection/claude-code-configuration-inspection.test.ts tests/features/claude-code-configuration-inspection/claude-code-vocabulary-parity.test.ts tests/features/claude-code-configuration-inspection/claude-code-configuration-source-reader.test.ts tests/package/claude-code-contract-custody.test.ts tests/package/curated-assembly-surface.test.ts', processes: 1 },
  { name: '@agent-teams/runtime-security', root: 'packages/contexts/runtime-security', build, test: 'node --test --test-concurrency=1 tests/features/*/*.test.ts tests/package/*.test.ts', processes: 1 },
] as const;
type Package = (typeof packages)[number];
// Scheduling only: every original test file remains an obligation.
export const shardIds = ['agent-execution-1', 'agent-execution-2', 'agent-execution-3',
  'provider-access', 'runtime-configuration', 'runtime-security', 'embedded-runtime', 'filesystem-custody'] as const;
export type ShardId = (typeof shardIds)[number];
export interface Shard { id: ShardId; package: Package; partitionIndex: number; partitionCount: number }
export function selectShard(id: unknown): Shard {
  assert.ok(typeof id === 'string', 'one literal shard required');
  assert.ok(shardIds.includes(id as ShardId), 'unknown or multiple shard selection');
  const execution = id.startsWith('agent-execution-');
  return { id: id as ShardId, package: selectPackage(`@agent-teams/${execution ? 'agent-execution' : id}`),
    partitionIndex: execution ? Number(id.at(-1)) - 1 : 0, partitionCount: execution ? 3 : 1 };
}
export interface Selection {
  partitionIndex: number; partitionCount: number; files: string[]; universe: string[]; universeHash: string;
  fullScript: string; fullArgv: string[]; patterns: string[]; bindingHash: string;
}
const executionPrefix = ['node', '--test', '--test-concurrency=1'];
const executionPatterns = packages[0].test.split(' ').slice(executionPrefix.length);
async function executionInventory(root: string): Promise<{ universe: string[]; fullFiles: string[] }> {
  const packageRoot = join(root, packages[0].root);
  const manifest = object(json(await readFile(join(packageRoot, 'package.json'), 'utf8')));
  assert.equal(object(manifest.scripts).test, packages[0].test, 'Agent Execution runner drift');
  const universe: string[] = [];
  // The four reviewed patterns have no recursive glob, shell quoting or expansion.
  for (const pattern of executionPatterns) {
    for (const segment of pattern.split('/').slice(0, -1)) {assert.match(segment, /^[a-z-]+$/u);}
    const directory = resolve(packageRoot, pattern.slice(0, pattern.lastIndexOf('/')));
    assert.equal(await realpath(directory), directory, 'symlink in test pattern ancestry');
    const matches: string[] = [];
    for await (const path of glob(pattern, { cwd: packageRoot })) {
      // POSIX shell * excludes dotfiles; directories/symlinks are unsupported inputs.
      if (basename(path).startsWith('.')) {continue;}
      assert.match(path, /^[a-z0-9/-]+\.test\.(?:ts|mjs)$/u, 'unsupported test path');
      assert.equal(path.split('/').length, pattern.split('/').length, 'unexpected recursive match');
      const stat = await lstat(join(packageRoot, path));
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'test must be a regular file');
      matches.push(path);
    }
    assert.ok(matches.length > 0, `unmatched original test pattern: ${pattern}`);
    universe.push(...matches.toSorted());
  }
  assert.equal(new Set(universe).size, universe.length, 'overlapping original test patterns');
  return { universe: universe.toSorted(), fullFiles: universe };
}
export async function enumerateExecutionFiles(root: string): Promise<string[]> {
  return (await executionInventory(root)).universe;
}
export function partitionExecutionFiles(universe: readonly string[], index: number): string[] {
  assert.ok([0, 1, 2].includes(index), 'invalid partition index');
  assert.ok(universe.length >= 3, 'empty Agent Execution partition');
  assert.deepEqual(universe.toSorted(), universe, 'canonical universe ordering required');
  assert.equal(new Set(universe).size, universe.length, 'duplicate universe identity');
  return universe.filter((_, position) => position % 3 === index);
}
export async function executionSelection(root: string, shard: Shard): Promise<Selection | null> {
  assert.deepEqual(shard, selectShard(shard.id), 'unsupported shard contract');
  if (shard.package.name !== packages[0].name) {return null;}
  const { universe, fullFiles } = await executionInventory(root);
  const fullArgv = [...executionPrefix.slice(1), ...fullFiles];
  const universeHash = hash(JSON.stringify(universe));
  const binding = { fullScript: packages[0].test, fullArgv, patterns: executionPatterns, universeHash,
    partitionIndex: shard.partitionIndex, partitionCount: shard.partitionCount,
    files: partitionExecutionFiles(universe, shard.partitionIndex) };
  return { ...binding, universe, bindingHash: hash(JSON.stringify(binding)) };
}
export const productBuild = "pnpm --filter './packages/**' -r run build";
export const cleanArgs = ['--filter', './packages/**', '-r', 'run', 'clean'];
export const buildArgs = ['run', 'product:build'];
const self = fileURLToPath(import.meta.url);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const json = (bytes: string): unknown => JSON.parse(bytes);
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  return value as Record<string, unknown>;
}
export function selectPackage(name: unknown): Package {
  assert.equal(typeof name, 'string', 'one literal package required');
  const selected = packages.find(item => item.name === name);
  assert.ok(selected, 'unknown or multiple package selection');
  return selected;
}
export function validateInventory(entries: readonly { root: string; manifest: unknown }[], rootManifest: unknown): void {
  assert.deepEqual(entries.map(item => item.root).toSorted(), packages.map(item => item.root).toSorted(), 'fixed six roots mismatch');
  const names = entries.map(item => object(item.manifest).name);
  assert.equal(new Set(names).size, 6, 'duplicate package name');
  for (const entry of entries) {
    const expected = packages.find(item => item.root === entry.root);
    assert.ok(expected);
    const manifest = object(entry.manifest), scripts = object(manifest.scripts);
    assert.equal(manifest.name, expected.name, 'package name/root mismatch');
    assert.equal(scripts.clean, clean, 'unsupported clean script');
    assert.equal(scripts.build, expected.build, 'unsupported build script');
    assert.equal(scripts.test, expected.test, 'unsupported whole-package test script');
    for (const hook of ['preclean', 'postclean', 'prebuild', 'postbuild', 'pretest', 'posttest'])
      {assert.equal(scripts[hook], undefined, 'unsupported package lifecycle hook');}
  }
  const scripts = object(object(rootManifest).scripts);
  assert.equal(scripts['product:build'], productBuild, 'root product:build drift');
  for (const hook of ['preproduct:build', 'postproduct:build']) {assert.equal(scripts[hook], undefined, 'unsupported root lifecycle hook');}
}
async function manifests(root: string, path: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    if (['node_modules', 'dist', '.cache'].includes(entry.name)) {continue;}
    assert.ok(!entry.isSymbolicLink(), `package inventory symlink: ${path}/${entry.name}`);
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) {found.push(...await manifests(root, child));}
    else if (entry.name === 'package.json') {found.push(child);}
  }
  return found;
}
export async function snapshotScripts(root: string): Promise<Record<string, string>> {
  const paths = [...await manifests(root, 'packages'), ...await manifests(root, 'experiments')].toSorted();
  const entries = await Promise.all(paths.map(async path => ({ root: path.slice(0, -13), manifest: json(await readFile(join(root, path), 'utf8')) })));
  validateInventory(entries, json(await readFile(join(root, 'package.json'), 'utf8')));
  const hashes: Record<string, string> = {};
  for (const path of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.node-version', ...paths])
    {hashes[path] = hash(await readFile(join(root, path)));}
  return hashes;
}
// Every tracked input, not only manifests. Build outputs remain untracked.
export async function snapshotSource(root: string): Promise<Record<string, string>> {
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).toSorted();
  const { readProductSource } = await import('./product-fanout-contract.ts');
  return (await readProductSource(root, paths)).inputs;
}
export interface Summary { tests: number; passed: number; failed: number; cancelled: number; skipped: number; todo: number; success: boolean }
export interface StreamPlan { executable: string; argv: string[]; cwd: string; files: string[] }
export interface NodeProcessObservation { pid: number; executable: string; argv: string[]; cwd: string; summary: Summary }
export interface CapturedStream { index: number; node: NodeProcessObservation; stdout: string; stderr: string; original: Record<string, unknown> | null; identity: string | null }
export interface Observation { summaries: Summary[]; events: Record<string, unknown>[]; completedFiles: string[]; streams: CapturedStream[] }
const emptyObservation = (): Observation => ({ summaries: [], events: [], completedFiles: [], streams: [] });

function registrationStatus(event: Extract<TestEvent, {type: 'test:pass' | 'test:fail'}>): string {
  const d = event.data;
  return d.todo ? 'todo' : d.skip ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed';
}
// Registration occurrences come from Node's ordered start/outcome events. A
// repeated registration site is valid; its occurrence is part of its identity.
export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const stack: Record<string, unknown>[] = [], pending: Record<string, unknown>[] = [];
  let occurrences = new Map<string, number>();
  for await (const event of source) {
    if (event.type === 'test:start') {
      const d = event.data;
      assert.equal(stack.length, d.nesting);
      const ancestry = stack.map(item => item.segment);
      const site = [d.file, d.line, d.column, d.name];
      const key = JSON.stringify([ancestry, site]);
      const ordinal = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, ordinal);
      stack.push({ file: d.file, line: d.line, column: d.column, name: d.name, ancestry, ordinal,
        segment: [...site, ordinal], nesting: d.nesting });
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data, registration = stack.pop();
      assert.equal(registration?.name, d.name); assert.equal(stack.length, d.nesting);
      const { segment: _segment, ...identity } = registration!;
      pending.push({ observerPid: process.pid, ...identity, kind: d.details.type,
        status: registrationStatus(event) });
    } else if (event.type === 'test:summary') {
      const d = event.data;
      if (d.file === undefined) {
        assert.equal(pending.length, 0);
        const counts = { ...d.counts, success: d.success };
        yield `PACKAGE_NODE_PROCESS ${JSON.stringify({ pid: process.pid, executable: process.execPath,
          argv: [...process.execArgv, ...process.argv.slice(1)], cwd: process.cwd(), summary: counts })}\n`;
        yield `PACKAGE_SUMMARY ${JSON.stringify(counts)}\n`;
      } else {
        assert.equal(stack.length, 0);
        for (const identity of pending) { yield `PACKAGE_EVENT ${JSON.stringify({ ...identity, suite: d.file })}\n`; }
        yield `PACKAGE_FILE ${JSON.stringify({ file: d.file, success: d.success })}\n`;
        pending.length = 0; occurrences = new Map();
      }
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') { yield event.data.message; }
    else if (event.type === 'test:diagnostic') { yield `# ${event.data.message}\n`; }
  }
}
export function observeLine(line: string, observation: Observation): void {
  if (line.startsWith('PACKAGE_EVENT ')) { observation.events.push(object(json(line.slice(14)))); }
  else if (line.startsWith('PACKAGE_SUMMARY ')) { observation.summaries.push(summary(object(json(line.slice(16))))); }
  else if (line.startsWith('PACKAGE_FILE ')) {
    const value = object(json(line.slice(13)));
    assert.equal(typeof value.file, 'string', 'missing completed file'); assert.equal(value.success, true, 'failed test file');
    observation.completedFiles.push(String(value.file));
  } else if (line.startsWith('{')) {
    let value: unknown; try { value = json(line); } catch { return; }
    const record = object(value);
    if (record.kind === 'summary') { observation.summaries.push(summary({ ...object(record.counts), success: record.success })); }
    else if (record.kind === 'test') { observation.events.push(record); }
    else if (record.kind === 'file') { assert.equal(record.success, true); observation.completedFiles.push(String(record.suite)); }
    else if (record.kind === 'failure') { throw new Error('Embedded Runtime test failure'); }
  }
}
function summary(record: Record<string, unknown>): Summary {
  for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'])
    {assert.ok(Number.isSafeInteger(record[key]) && Number(record[key]) >= 0, 'invalid Node summary');}
  assert.equal(typeof record.success, 'boolean', 'missing Node summary outcome');
  return { tests: Number(record.tests), passed: Number(record.passed), failed: Number(record.failed),
    cancelled: Number(record.cancelled), skipped: Number(record.skipped), todo: Number(record.todo), success: record.success === true };
}
const captured = (stdout: string, stderr: string, index: number, original: Record<string, unknown> | null, rawIdentity: string | null = null): Observation =>
  captureStream(stdout, stderr, index, original, {rawIdentity, observeLine, summary});
export interface CommandResult { executable: string; argv: string[]; cwd: string; pid: number | null; start: string; end: string; wallMs: number; exitCode: number | null; signal: NodeJS.Signals | null; error: string | null; observation: Observation }
export interface PackageReceipt {
  schemaVersion: 3; target: ExecutionTarget; workflow: WorkflowIdentity | null; nativeBuild: NativeBuild | null; embeddedProcesses: Record<string, unknown>[] | null; requestedShard: unknown; packageName: string | null; sourceSha: string; sourceTree: string | null;
  checkoutRoot: string; selection: Selection | null; platform: string; arch: string; uid: number | null;
  node: string; execPath: string; pnpm: string | null;
  runnerImage: { os: string | null; version: string | null; runnerOS: string | null; runnerArch: string | null };
  runnerHash: string; before: Record<string, string>; after: Record<string, string>;
  sourceBefore: Record<string, string>; sourceAfter: Record<string, string>;
  commands: CommandResult[]; exitCode: number; failure: string | null; coverage: string;
}
export async function packageStreamPlans(root: string, shard: Shard, selection: Selection | null): Promise<StreamPlan[]> {
  const cwd = join(root, shard.package.root);
  let argvs: string[][];
  if (selection) { argvs = [['--test', '--test-concurrency=1', `--test-reporter=${join(root, 'scripts/ci/package-execution.ts')}`, ...selection.files]]; }
  else if (shard.package.name === '@agent-teams/embedded-runtime') {
    const source = await readFile(join(cwd, 'scripts/run-package-tests.mjs'), 'utf8');
    const literal = /export const testProcesses = (\[[\s\S]*?\n\]);/u.exec(source)?.[1];
    assert.ok(literal, 'explicit original ER testProcesses required');
    const processes: unknown = json(literal);
    assert.ok(Array.isArray(processes) && processes.length === 2 && processes.every(args => Array.isArray(args) && args.every(arg => typeof arg === 'string')));
    argvs = (processes as string[][]).map(args => ['--test-reporter=./scripts/adoption-test-reporter.mjs', ...args]);
  } else {
    const manifest = object(json(await readFile(join(cwd, 'package.json'), 'utf8')));
    const script = object(manifest.scripts).test; assert.equal(script, shard.package.test);
    const args = String(script).split(' '); assert.deepEqual(args.slice(0, 3), executionPrefix);
    const files: string[] = [];
    for (const pattern of args.slice(3)) {
      const matches: string[] = [];
      for await (const file of glob(pattern, { cwd })) { if (!file.split('/').some(part => part.startsWith('.'))) { matches.push(file); } }
      assert.ok(matches.length > 0, 'unmatched original package pattern'); files.push(...matches.toSorted());
    }
    argvs = [[...args.slice(1, 3), ...files]];
  }
  return argvs.map(argv => ({ executable: process.execPath, argv, cwd, files: argv.filter(arg => !arg.startsWith('--')).map(file => join(cwd, file)) }));
}
export function embeddedObserverEnv(env: NodeJS.ProcessEnv, capture: string, plans: readonly StreamPlan[]): NodeJS.ProcessEnv {
  assert.ok(!env.NODE_OPTIONS, 'caller Node options unsupported');
  assert.equal(plans.length, 2, 'two original ER plans required');
  return { ...env, AE_ADOPTION_CAPTURE_DIR: capture, CI_ER_PROCESS_PLANS: JSON.stringify(plans) };
}
function validateCapturedStream(stream: CapturedStream, index: number, plan?: StreamPlan, sourceFiles?: readonly string[]): Observation {
  assert.equal(stream.index, index);
  const actual = captured(stream.stdout, stream.stderr, index, stream.original, stream.identity);
  assert.deepEqual(actual.streams[0], stream, 'raw process envelope drift');
  if (plan) {
    assert.equal(stream.node.executable, plan.executable); assert.equal(stream.node.cwd, plan.cwd);
    assert.deepEqual(stream.node.argv, plan.argv, 'original process argv drift');
    const completed = actual.completedFiles.map(file => resolve(stream.node.cwd, stream.original ? '../../..' : '.', file));
    assert.deepEqual(completed.toSorted(), plan.files.toSorted(), 'whole-package file universe drift');
  }
  if (stream.original) {
    assert.equal(stream.original.index, index); assert.equal(stream.original.executable, 'node');
    assert.deepEqual(stream.original.argv, stream.node.argv); assert.equal(stream.original.exitCode, 0); assert.equal(stream.original.signal, null);
    assert.equal(stream.original.cwd, relative(resolve(stream.node.cwd, '../../..'), stream.node.cwd));
    assert.ok(Number.isFinite(Date.parse(String(stream.original.start))) && Date.parse(String(stream.original.end)) >= Date.parse(String(stream.original.start)));
    assert.equal(stream.original.stdout, `process-${index}.stdout`); assert.equal(stream.original.stderr, `process-${index}.stderr`);
  }
  assert.deepEqual(actual.summaries, [stream.node.summary], 'summary/stream mismatch');
  const occurrences = new Map<string, number[]>();
  const identities = actual.events.map(event => JSON.stringify([event.suite, event.file, event.line, event.column, event.name ?? event.title, event.ancestry, event.ordinal, event.type ?? event.kind]));
  assert.equal(new Set(identities).size, identities.length, 'duplicate registration identity');
  for (const event of actual.events) {
    assert.ok(Number.isSafeInteger(event.ordinal) && Number(event.ordinal) > 0, 'registration occurrence missing');
    assert.ok(Array.isArray(event.ancestry)); assert.equal(event.observerPid, stream.node.pid);
    assert.ok(Number.isSafeInteger(event.line) && Number(event.line) > 0 && Number.isSafeInteger(event.column) && Number(event.column) > 0);
    if (sourceFiles) { assert.ok(sourceFiles.includes(resolve(stream.node.cwd, stream.original ? '../../..' : '.', String(event.file))), 'registration outside source custody'); }
    const site = JSON.stringify([event.suite, event.file, event.line, event.column, event.name ?? event.title, event.ancestry, event.type ?? event.kind]);
    const ordinals = occurrences.get(site) ?? []; ordinals.push(Number(event.ordinal)); occurrences.set(site, ordinals);
    assert.ok(actual.completedFiles.includes(String(event.suite)), 'foreign registration suite');
  }
  for (const ordinals of occurrences.values()) { assert.deepEqual(ordinals.toSorted((a, b) => a - b), ordinals.map((_, i) => i + 1)); }
  return actual;
}
export function commandExit(result: Pick<CommandResult, 'exitCode' | 'signal' | 'error' | 'observation'> & { pid?: number | null }, expectedProcesses?: number,
  expectedFiles?: readonly string[], plans?: readonly StreamPlan[], sourceFiles?: readonly string[]): number {
  if (result.error || result.signal) {return 1;}
  if (result.exitCode !== 0) {return result.exitCode ?? 1;}
  if (expectedProcesses === undefined) {return 0;}
  try {
    const observation = result.observation;
    assert.equal(observation.streams.length, expectedProcesses);
    assert.equal(new Set(observation.streams.map(stream => stream.node.pid)).size, expectedProcesses, 'duplicate process envelope');
    const recomputed = emptyObservation();
    for (const [index, stream] of observation.streams.entries()) {
      const actual = validateCapturedStream(stream, index, plans?.[index], sourceFiles);
      if (stream.original) { assertCapturedIdentity(stream, result.pid, observation.streams[0]!.original?.runnerPid); }
      recomputed.events.push(...actual.events); recomputed.summaries.push(...actual.summaries); recomputed.completedFiles.push(...actual.completedFiles);
      const counts = stream.node.summary, tests = actual.events.filter(event => (event.type ?? event.kind) === 'test');
      assert.ok(counts.success && counts.tests > 0 && counts.passed > 0 && counts.failed === 0 && counts.cancelled === 0 && counts.todo === 0 && counts.passed + counts.skipped === counts.tests);
      assert.equal(tests.length, counts.tests); assert.equal(tests.filter(event => event.status === 'passed').length, counts.passed);
      assert.equal(tests.filter(event => event.status === 'skipped').length, counts.skipped);
    }
    assert.deepEqual(observation.events, recomputed.events, 'raw event binding drift');
    assert.deepEqual(observation.summaries, recomputed.summaries); assert.deepEqual(observation.completedFiles, recomputed.completedFiles);
    assert.equal(new Set(observation.completedFiles).size, observation.completedFiles.length, 'duplicate completed file');
    if (expectedFiles) { assert.deepEqual(observation.completedFiles.toSorted(), expectedFiles.toSorted()); }
    return 0;
  } catch { return 1; }
}
export async function runCommand(executable: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, logPrefix: string): Promise<CommandResult> {
  const start = new Date().toISOString(), clock = performance.now(); let observation = emptyObservation();
  const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
  const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopObserver = env.CI_ER_PROCESS_PLANS && env.AE_ADOPTION_CAPTURE_DIR && child.pid
    ? observeEmbeddedProcesses(json(env.CI_ER_PROCESS_PLANS) as StreamPlan[], env.AE_ADOPTION_CAPTURE_DIR, child.pid) : null;
  let error: string | null = null;
  child.once('error', failure => { error = failure.message; });
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].on('data', (bytes: Buffer) => { chunks[stream].push(Buffer.from(bytes)); process[stream].write(bytes); });
  }
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(_resolve => {
    child.once('close', (exitCode, signal) => _resolve({ exitCode, signal }));
  });
  const logs = { stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') };
  try { await stopObserver?.(); } catch (failure) { error = String(failure); }
  for (const stream of ['stdout', 'stderr'] as const) {await writeFile(`${logPrefix}.${stream}`, logs[stream], { flag: 'wx' });}
  try {
    if (env.AE_ADOPTION_CAPTURE_DIR) {
      const records: unknown = json(await readFile(join(env.AE_ADOPTION_CAPTURE_DIR, 'processes.json'), 'utf8')); assert.ok(Array.isArray(records));
      for (const [index, value] of records.entries()) {
        const record = object(value); assert.equal(record.stdout, `process-${index}.stdout`); assert.equal(record.stderr, `process-${index}.stderr`);
        const stream = captured(await readFile(join(env.AE_ADOPTION_CAPTURE_DIR, String(record.stdout)), 'utf8'),
          await readFile(join(env.AE_ADOPTION_CAPTURE_DIR, String(record.stderr)), 'utf8'), index, record,
          await readFile(join(env.AE_ADOPTION_CAPTURE_DIR, `process-${index}.identity.json`), 'utf8'));
        observation.events.push(...stream.events); observation.summaries.push(...stream.summaries);
        observation.completedFiles.push(...stream.completedFiles); observation.streams.push(...stream.streams);
      }
    } else if (logs.stdout.includes('PACKAGE_NODE_PROCESS ') || logs.stderr.includes('PACKAGE_NODE_PROCESS ')) {
      observation = captured(logs.stdout, logs.stderr, 0, null);
    }
  } catch (failure) { error ??= String(failure); }
  return { executable, argv, cwd, pid: child.pid ?? null, start, end: new Date().toISOString(), wallMs: performance.now() - clock, ...result, error, observation };
}
export async function executePackage(root: string, id: unknown, revision: string, output: string, target: ExecutionTarget): Promise<number> {
  // A new unique receipt directory retains failures and avoids overwriting evidence.
  await mkdir(output, { recursive: false });
  const report: PackageReceipt = { schemaVersion: 3, target, workflow: null, nativeBuild: null, embeddedProcesses: null, requestedShard: id, packageName: null,
    sourceSha: revision, sourceTree: null as string | null, checkoutRoot: root, selection: null as Selection | null,
    platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null, node: process.version, execPath: process.execPath, pnpm: null,
    runnerImage: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null, runnerOS: process.env.RUNNER_OS ?? null, runnerArch: process.env.RUNNER_ARCH ?? null },
    runnerHash: hash(await readFile(self)), before: {} as Record<string, string>, after: {} as Record<string, string>,
    sourceBefore: {}, sourceAfter: {}, commands: [], exitCode: 1, failure: null,
    coverage: 'one of eight required target-specific shards; complete-file AE partition or unchanged whole-package command; all-six clean/build; all other obligations separate' };
  const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n'); await save();
  try {
    const shard = selectShard(id), selected = shard.package;
    report.packageName = selected.name;
    validatePlatform(target, { platform: process.platform, arch: process.arch, uid: report.uid,
      runnerOS: report.runnerImage.runnerOS, runnerArch: report.runnerImage.runnerArch, execPath: process.execPath });
    report.workflow = workflowIdentity(process.env);
    assert.equal(process.version, 'v24.21.0', 'pinned Node required'); assert.ok(!process.env.NODE_OPTIONS, 'caller Node options unsupported');
    verifySource(root, revision);
    report.sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
    report.pnpm = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(report.pnpm, '11.18.0', 'pinned pnpm required');
    report.before = await snapshotScripts(root); report.sourceBefore = await snapshotSource(root);
    report.selection = await executionSelection(root, shard);
    assert.equal((await readFile(join(root, '.node-version'), 'utf8')).trim(), '24.21.0', 'Node file drift');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const testEnv = { ...env, NODE_OPTIONS: `--test-reporter=${self}` };
    const plans = await packageStreamPlans(root, shard, report.selection);
    const capture = join(output, 'embedded-processes');
    const embeddedEnv = selected.name === '@agent-teams/embedded-runtime'
      ? embeddedObserverEnv(env, capture, plans) : env;
    if (selected.name === '@agent-teams/embedded-runtime') { await mkdir(embeddedEnv.AE_ADOPTION_CAPTURE_DIR!); }
    for (const item of packages) {assert.equal(await realpath(join(root, item.root)), join(root, item.root), 'shared/symlinked package root');}
    const commands = [
      { executable: 'pnpm', argv: cleanArgs, cwd: root, env, processes: undefined, files: undefined },
      { executable: 'pnpm', argv: buildArgs, cwd: root, env, processes: undefined, files: undefined },
      report.selection ? { executable: process.execPath,
        argv: [...executionPrefix.slice(1), `--test-reporter=${self}`, ...report.selection.files],
        cwd: join(root, selected.root), env, processes: 1,
        files: report.selection.files.map(path => join(root, selected.root, path)) }
        : { executable: 'pnpm', argv: ['--filter', selected.name, 'run', 'test'], cwd: root,
          env: selected.name === '@agent-teams/embedded-runtime' ? embeddedEnv : testEnv,
          processes: selected.processes, files: undefined },
    ];
    return await performPackageCommands({ root, revision, output, shard, report, save }, commands, capture, plans);
  } catch (failure) { report.failure = String(failure); report.exitCode = 1; }
  await save(); return report.exitCode;
}
interface PackageRunContext { root: string; revision: string; output: string; shard: Shard; report: PackageReceipt; save: () => Promise<void> }
interface PackageCommand { executable: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; processes: number | undefined; files: string[] | undefined }
async function performPackageCommands(context: PackageRunContext, commands: PackageCommand[], embeddedCapture: string, plans: StreamPlan[]): Promise<number> {
  const { root, revision, output, shard, report, save } = context;
  const selected = shard.package; let native: NativeBuild | null = null;
  for (const [index, command] of commands.entries()) {
    assert.deepEqual(await snapshotScripts(root), report.before, 'script/input drift before execution');
    assert.deepEqual(await snapshotSource(root), report.sourceBefore, 'complete source drift before execution');
    assert.deepEqual(await executionSelection(root, shard), report.selection, 'test universe drift before execution');
    assert.equal(hash(await readFile(self)), report.runnerHash, 'runner drift before execution');
    verifySource(root, revision);
    if (index === 2 && report.nativeBuild) { assert.equal(hash(await readFile(join(root, nativeOutput))), report.nativeBuild.sha256, 'native output drift before tests'); }
    if (index === 2) {for (const item of packages) {
      const dist = join(root, item.root, 'dist');
      assert.equal(await realpath(dist), dist, 'shared/symlinked build output');
    }}
    const result = await runCommand(command.executable, command.argv, command.cwd, command.env, join(output, `command-${index}`));
    report.commands.push(result);
    if (index === 2 && selected.name === '@agent-teams/embedded-runtime') {
      report.embeddedProcesses = json(await readFile(join(embeddedCapture, 'processes.json'), 'utf8')) as Record<string, unknown>[];
      assert.equal(result.observation.streams.length, 2, 'both actual Embedded Runtime Node process observers required');
      assert.equal(new Set(result.observation.streams.map(p => p.node.pid)).size, 2, 'distinct Node PIDs required');
    }
    if (index === 2 && report.nativeBuild) { assert.equal(hash(await readFile(join(root, nativeOutput))), report.nativeBuild.sha256, 'native output drift during tests'); }
    report.after = await snapshotScripts(root); report.sourceAfter = await snapshotSource(root);
    assert.deepEqual(report.after, report.before, 'script/input drift during execution');
    assert.deepEqual(report.sourceAfter, report.sourceBefore, 'complete source drift during execution');
    assert.deepEqual(await executionSelection(root, shard), report.selection, 'test universe drift during execution');
    assert.equal(hash(await readFile(self)), report.runnerHash, 'runner drift during execution');
    verifySource(root, revision);
    report.exitCode = commandExit(result, command.processes, command.files, index === 2 ? plans : undefined, Object.keys(report.sourceBefore).map(file => join(root, file)));
    await save();
    if (report.exitCode !== 0) {return report.exitCode;}
    if (report.target === 'darwin-arm64' && index === 0) {
      await assertNativeAbsent(root);
      native = await prepareNative(root, output, command.env, runCommand);
    }
    if (report.target === 'darwin-arm64' && index === 1) {
      assert.ok(native); report.nativeBuild = await finishNative(root, output, command.env, native, runCommand);
      await save();
    }
  }
  return report.exitCode;
}
export async function executeReference(root: string, revision: string, output: string): Promise<number> {
  await mkdir(output, { recursive: false });
  const report = { schemaVersion: 3, kind: 'darwin-unsplit-reference', target: 'darwin-arm64',
    sourceSha: revision, sourceTree: null as string | null, checkoutRoot: root, workflow: null as WorkflowIdentity | null,
    platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null, node: process.version, execPath: process.execPath, pnpm: null as string | null,
    runnerImage: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null, runnerOS: process.env.RUNNER_OS ?? null, runnerArch: process.env.RUNNER_ARCH ?? null },
    runnerHash: hash(await readFile(self)), before: {} as Record<string, string>, after: {} as Record<string, string>,
    sourceBefore: {} as Record<string, string>, sourceAfter: {} as Record<string, string>,
    command: null as CommandResult | null, nativeBuild: null as NativeBuild | null, exitCode: 1, failure: null as string | null,
    coverage: 'original unsplit pnpm product:check; raw outputs/events preserved; identity equivalence requires Root review' };
  const save = () => writeFile(join(output, 'reference-receipt.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  try {
    assert.equal(process.env.EXECUTION_TARGET, 'darwin-arm64');
    validatePlatform('darwin-arm64', { ...report, runnerOS: report.runnerImage.runnerOS, runnerArch: report.runnerImage.runnerArch });
    assert.equal(process.version, 'v24.21.0'); assert.ok(!process.env.NODE_OPTIONS);
    report.workflow = workflowIdentity(process.env); verifySource(root, revision);
    report.sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
    report.pnpm = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(); assert.equal(report.pnpm, '11.18.0');
    report.before = await snapshotScripts(root); report.sourceBefore = await snapshotSource(root);
    // Fresh checkout has no native output; the unchanged command performs its own clean/build.
    await assertNativeAbsent(root);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const native = await prepareNative(root, output, env, runCommand);
    report.command = await runCommand('pnpm', ['product:check'], root, env, join(output, 'original-product'));
    report.after = await snapshotScripts(root); report.sourceAfter = await snapshotSource(root);
    assert.deepEqual(report.before, report.after); assert.deepEqual(report.sourceBefore, report.sourceAfter); verifySource(root, revision);
    report.exitCode = commandExit(report.command);
    if (report.command.exitCode === 0 && !report.command.signal && !report.command.error) {
      report.nativeBuild = await finishNative(root, output, env, native, runCommand);
    }
  } catch (error) { report.failure = String(error); report.exitCode = 1; }
  await save(); return report.exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === 'reference'), 'only the fixed manual reference mode is admitted');
  const output = process.env.CI_EVIDENCE_DIR; assert.ok(output, 'evidence directory required');
  const root = await realpath(process.cwd());
  assert.ok(relative(root, resolve(output)) !== '', 'receipt directory cannot be repository root');
  if (process.argv[2] === 'reference') { process.exitCode = await executeReference(root, process.env.EXPECTED_REVISION ?? '', resolve(output)); }
  else { process.exitCode = await executePackage(root, process.env.PACKAGE_SHARD, process.env.EXPECTED_REVISION ?? '', resolve(output), process.env.EXECUTION_TARGET as ExecutionTarget); }
}
