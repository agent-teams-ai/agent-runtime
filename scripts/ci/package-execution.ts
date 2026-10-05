import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestEvent } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

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
export function validatePlatform(platform: string, arch: string, runnerOS?: string, runnerArch?: string): void {
  assert.equal(platform, 'linux', 'only the Linux product shard is supported');
  assert.equal(arch, 'x64', 'unsupported architecture');
  if (runnerOS !== undefined) {assert.equal(runnerOS, 'Linux', 'runner OS mismatch');}
  if (runnerArch !== undefined) {assert.equal(runnerArch, 'X64', 'runner architecture mismatch');}
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
  const result: Record<string, string> = {};
  for (const path of paths) {
    assert.ok((await lstat(join(root, path))).isFile(), `non-file source input: ${path}`);
    result[path] = hash(await readFile(join(root, path)));
  }
  return result;
}
export interface Summary { tests: number; passed: number; failed: number; cancelled: number; skipped: number; todo: number; success: boolean }
export interface Observation { summaries: Summary[]; events: Record<string, unknown>[]; completedFiles: string[] }
// These are actual Node events. Preserve source locations/nesting; do not invent ancestry or TAP identities.
export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      yield `PACKAGE_EVENT ${JSON.stringify({ observerPid: process.pid, file: d.file, line: d.line, column: d.column,
        name: d.name, nesting: d.nesting, kind: d.details.type, status: d.todo ? 'todo' : d.skip ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed' })}\n`;
    } else if (event.type === 'test:summary') {
      if (event.data.file === undefined)
        {yield `PACKAGE_SUMMARY ${JSON.stringify({ observerPid: process.pid, ...event.data.counts, success: event.data.success })}\n`;}
      else {yield `PACKAGE_FILE ${JSON.stringify({ file: event.data.file, success: event.data.success })}\n`;}
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {yield event.data.message;}
    else if (event.type === 'test:diagnostic') {yield `# ${event.data.message}\n`;}
  }
}
export function observeLine(line: string, observation: Observation): void {
  const eventPrefix = 'PACKAGE_EVENT ', summaryPrefix = 'PACKAGE_SUMMARY ', filePrefix = 'PACKAGE_FILE ';
  if (line.startsWith(eventPrefix)) {observation.events.push(object(json(line.slice(eventPrefix.length))));}
  else if (line.startsWith(summaryPrefix)) {observation.summaries.push(summary(object(json(line.slice(summaryPrefix.length)))));}
  else if (line.startsWith(filePrefix)) {
    const value = object(json(line.slice(filePrefix.length)));
    assert.equal(typeof value.file, 'string', 'missing completed file');
    assert.equal(value.success, true, 'failed test file');
    observation.completedFiles.push(String(value.file));
  }
  else if (line.startsWith('{')) {
    let value: unknown;
    try { value = json(line); } catch { return; }
    const record = object(value);
    // Existing Embedded Runtime reporter emits its own typed event envelope.
    if (record.kind === 'summary') {observation.summaries.push(summary({ ...object(record.counts), success: record.success }));}
    else if (record.kind === 'test') {observation.events.push(record);}
  }
}
function summary(record: Record<string, unknown>): Summary {
  for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'])
    {assert.ok(Number.isSafeInteger(record[key]) && Number(record[key]) >= 0, 'invalid Node summary');}
  assert.equal(typeof record.success, 'boolean', 'missing Node summary outcome');
  return { tests: Number(record.tests), passed: Number(record.passed), failed: Number(record.failed),
    cancelled: Number(record.cancelled), skipped: Number(record.skipped), todo: Number(record.todo), success: record.success === true };
}
export interface CommandResult { executable: string; argv: string[]; cwd: string; pid: number | null; start: string; end: string; wallMs: number; exitCode: number | null; signal: NodeJS.Signals | null; error: string | null; observation: Observation }
export interface PackageReceipt {
  schemaVersion: 2; requestedShard: unknown; packageName: string | null; sourceSha: string; sourceTree: string | null;
  checkoutRoot: string; selection: Selection | null; platform: string; arch: string; uid: number | null;
  node: string; execPath: string; pnpm: string | null;
  runnerImage: { os: string | null; version: string | null; runnerOS: string | null; runnerArch: string | null };
  runnerHash: string; before: Record<string, string>; after: Record<string, string>;
  sourceBefore: Record<string, string>; sourceAfter: Record<string, string>;
  commands: CommandResult[]; exitCode: number; failure: string | null; coverage: string;
}
export function commandExit(result: Pick<CommandResult, 'exitCode' | 'signal' | 'error' | 'observation'>, expectedProcesses?: number,
  expectedFiles?: readonly string[]): number {
  if (result.error || result.signal) {return 1;}
  if (result.exitCode !== 0) {return result.exitCode ?? 1;}
  if (expectedProcesses === undefined) {return 0;}
  if (result.observation.events.length === 0) {return 1;}
  if (expectedFiles && (new Set(result.observation.completedFiles).size !== result.observation.completedFiles.length
    || JSON.stringify(result.observation.completedFiles.toSorted()) !== JSON.stringify(expectedFiles.toSorted()))) {return 1;}
  const counts = result.observation.summaries;
  if (counts.length !== expectedProcesses || !counts.every(item => item.success && item.tests > 0 && item.passed > 0
    && item.failed === 0 && item.cancelled === 0 && item.todo === 0 && item.passed + item.skipped === item.tests)) {return 1;}
  const tests = result.observation.events.filter(event => (event.type ?? event.kind) === 'test');
  const total = (key: 'tests' | 'passed' | 'skipped') => counts.reduce((sum, item) => sum + item[key], 0);
  return tests.length === total('tests') && tests.filter(event => event.status === 'passed').length === total('passed')
    && tests.filter(event => event.status === 'skipped').length === total('skipped') ? 0 : 1;
}
export async function runCommand(executable: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, logPrefix: string): Promise<CommandResult> {
  const start = new Date().toISOString(), clock = performance.now();
  const observation: Observation = { summaries: [], events: [], completedFiles: [] };
  const logs = { stdout: '', stderr: '' };
  const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let error: string | null = null;
  child.once('error', failure => { error = failure.message; });
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].on('data', (bytes: Buffer) => { logs[stream] += bytes.toString(); process[stream].write(bytes); });
    const lines = createInterface({ input: child[stream] });
    lines.on('line', line => { try { observeLine(line, observation); } catch (failure) { error = String(failure); } });
  }
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(_resolve => {
    child.once('close', (exitCode, signal) => _resolve({ exitCode, signal }));
  });
  for (const stream of ['stdout', 'stderr'] as const) {await writeFile(`${logPrefix}.${stream}`, logs[stream], { flag: 'wx' });}
  return { executable, argv, cwd, pid: child.pid ?? null, start, end: new Date().toISOString(), wallMs: performance.now() - clock, ...result, error, observation };
}
function verifySource(root: string, revision: string): void {
  assert.match(revision, /^[0-9a-f]{40}$/u, 'exact revision required');
  assert.equal(git(root, 'rev-parse', 'HEAD'), revision, 'checkout revision mismatch');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no'), '', 'tracked source drift');
  assert.equal(git(root, 'ls-files', '--others', '--exclude-standard', '--', 'packages', 'experiments'), '', 'untracked package inputs');
}
export async function executePackage(root: string, id: unknown, revision: string, output: string): Promise<number> {
  // A new unique receipt directory retains failures and avoids overwriting evidence.
  await mkdir(output, { recursive: false });
  const report: PackageReceipt = { schemaVersion: 2, requestedShard: id, packageName: null,
    sourceSha: revision, sourceTree: null as string | null, checkoutRoot: root, selection: null as Selection | null,
    platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null, node: process.version, execPath: process.execPath, pnpm: null,
    runnerImage: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null, runnerOS: process.env.RUNNER_OS ?? null, runnerArch: process.env.RUNNER_ARCH ?? null },
    runnerHash: hash(await readFile(self)), before: {} as Record<string, string>, after: {} as Record<string, string>,
    sourceBefore: {}, sourceAfter: {}, commands: [], exitCode: 1, failure: null,
    coverage: 'one of eight required Linux shards; complete-file AE partition or unchanged whole-package command; all-six clean/build; all other obligations separate' };
  const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  try {
    const shard = selectShard(id), selected = shard.package;
    report.packageName = selected.name;
    validatePlatform(process.platform, process.arch, process.env.RUNNER_OS, process.env.RUNNER_ARCH);
    assert.equal(process.version, 'v24.21.0', 'pinned Node required');
    assert.ok(!process.env.NODE_OPTIONS, 'caller Node options unsupported');
    verifySource(root, revision);
    report.sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
    report.pnpm = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(report.pnpm, '11.18.0', 'pinned pnpm required');
    report.before = await snapshotScripts(root);
    report.sourceBefore = await snapshotSource(root);
    report.selection = await executionSelection(root, shard);
    assert.equal((await readFile(join(root, '.node-version'), 'utf8')).trim(), '24.21.0', 'Node file drift');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const testEnv = { ...env, NODE_OPTIONS: `--test-reporter=${self}` };
    for (const item of packages) {assert.equal(await realpath(join(root, item.root)), join(root, item.root), 'shared/symlinked package root');}
    const commands = [
      { executable: 'pnpm', argv: cleanArgs, cwd: root, env, processes: undefined, files: undefined },
      { executable: 'pnpm', argv: buildArgs, cwd: root, env, processes: undefined, files: undefined },
      report.selection ? { executable: process.execPath,
        argv: [...executionPrefix.slice(1), `--test-reporter=${self}`, ...report.selection.files],
        cwd: join(root, selected.root), env, processes: 1,
        files: report.selection.files.map(path => join(root, selected.root, path)) }
        : { executable: 'pnpm', argv: ['--filter', selected.name, 'run', 'test'], cwd: root,
          env: selected.name === '@agent-teams/embedded-runtime' ? env : testEnv,
          processes: selected.processes, files: undefined },
    ];
    for (const [index, command] of commands.entries()) {
      assert.deepEqual(await snapshotScripts(root), report.before, 'script/input drift before execution');
      assert.deepEqual(await snapshotSource(root), report.sourceBefore, 'complete source drift before execution');
      assert.deepEqual(await executionSelection(root, shard), report.selection, 'test universe drift before execution');
      assert.equal(hash(await readFile(self)), report.runnerHash, 'runner drift before execution');
      verifySource(root, revision);
      if (index === 2) {for (const item of packages) {
        const dist = join(root, item.root, 'dist');
        assert.equal(await realpath(dist), dist, 'shared/symlinked build output');
      }}
      const result = await runCommand(command.executable, command.argv, command.cwd, command.env, join(output, `command-${index}`));
      report.commands.push(result);
      report.after = await snapshotScripts(root);
      report.sourceAfter = await snapshotSource(root);
      assert.deepEqual(report.after, report.before, 'script/input drift during execution');
      assert.deepEqual(report.sourceAfter, report.sourceBefore, 'complete source drift during execution');
      assert.deepEqual(await executionSelection(root, shard), report.selection, 'test universe drift during execution');
      assert.equal(hash(await readFile(self)), report.runnerHash, 'runner drift during execution');
      verifySource(root, revision);
      report.exitCode = commandExit(result, command.processes, command.files);
      await save();
      if (report.exitCode !== 0) {return report.exitCode;}
    }
  } catch (failure) { report.failure = String(failure); report.exitCode = 1; }
  await save();
  return report.exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  assert.equal(process.argv.length, 2, 'inputs are fixed package/revision environment values only');
  const output = process.env.CI_EVIDENCE_DIR;
  assert.ok(output, 'evidence directory required');
  const root = await realpath(process.cwd());
  assert.ok(relative(root, resolve(output)) !== '', 'receipt directory cannot be repository root');
  process.exitCode = await executePackage(root, process.env.PACKAGE_SHARD, process.env.EXPECTED_REVISION ?? '', resolve(output));
}
