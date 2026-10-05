import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProductWorkflow, assertShardWorkflow, assertDarwinWorkflow } from './product-workflow-contract.ts';
export { assertProductWorkflow, assertShardWorkflow, assertDarwinWorkflow, assertDarwinCaller, assertDarwinReference } from './product-workflow-contract.ts';
import { workflowIdentity } from './product-workflow-contract.ts';
import type { ExecutionTarget, WorkflowIdentity } from './package-execution.ts';
import { assertObservedStreams } from './product-test-observation.ts';
import { commandInventory } from './script-routing.ts';
import type { Command, Scripts } from './script-routing.ts';

// Runtime owns this fixed full-product policy. Reports are observations, never permits.
export const packageRoots = {
  'agent-execution': 'packages/contexts/agent-execution',
  'provider-access': 'packages/contexts/provider-access',
  'runtime-configuration': 'packages/contexts/runtime-configuration',
  'runtime-security': 'packages/contexts/runtime-security',
  'embedded-runtime': 'packages/apps/embedded-runtime',
  'filesystem-custody': 'packages/platform/filesystem-custody',
} as const;
export type PackageId = keyof typeof packageRoots;
export const shardIds = ['agent-execution-1', 'agent-execution-2', 'agent-execution-3',
  'provider-access', 'runtime-configuration', 'runtime-security', 'embedded-runtime', 'filesystem-custody'] as const;
export type ShardId = typeof shardIds[number];
export const aePatterns = ['tests/features/runtime-installation-discovery/*.test.ts',
  'tests/features/contained-agent-turn/*.test.ts',
  'tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs', 'tests/package/*.test.ts'] as const;
const aeRunner = `node --test --test-concurrency=1 ${aePatterns.join(' ')}`;
export const prerequisiteCommands = [
  { executable: 'pnpm', argv: ['--filter', './packages/**', '-r', 'run', 'clean'] },
  { executable: 'pnpm', argv: ['run', 'product:build'] },
] as const;
export const phaseEntries = ['check:ci:product:root', 'check:ci:product:typed', 'check:ci:product:native'] as const;
const phaseScripts = [['typecheck', 'test'], ['lint:typed'], ['quality:native']] as const;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected report object');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => { assert.ok(Array.isArray(value), 'expected report array'); return value; };
export interface ProductSource {
  inputs: Record<string, string>; manifests: Record<string, string>; runners: Record<PackageId, string>;
  universe: string[]; fullArgv: string[]; embeddedArgv: string[][]; inventories: readonly Command[][];
  packageStreams: Record<PackageId, { argv: string[]; files: string[] }[]>;
}
export interface ExpectedEvidence extends ProductSource {
  target: ExecutionTarget; workflow: WorkflowIdentity; sha: string; inputTree: string; nodeExecutable: string; measureDigests: Record<string, string>;
}

async function assertPhysicalCustody(root: string, tracked: readonly string[], roots: readonly string[]): Promise<void> {
  const generated = (path: string) => roots.some(base =>
    ['dist', '.cache', 'node_modules'].some(dir => path === `${base}/${dir}` || path.startsWith(`${base}/${dir}/`)));
  // Root tests/type projects, typed source policy and native helpers read these
  // finite source/config/fixture roots. Preserve all tracked hashes separately.
  const custodyRoots = ['packages', 'experiments', 'scripts', 'architecture', 'docs', 'research', '.github'];
  const excluded = (path: string) => generated(path) || path.split('/').includes('node_modules')
    || path === 'experiments/rust-system-boundaries/target' || path.startsWith('experiments/rust-system-boundaries/target/');
  const common = tracked.filter(path => !path.includes('/'));
  const selected = tracked.filter(path => !excluded(path) &&
    (custodyRoots.some(base => path.startsWith(`${base}/`)) || common.includes(path))).toSorted();
  const observed: string[] = [];
  const walk = async (base: string): Promise<void> => {
    assert.equal(await realpath(join(root, base)), join(root, base), 'source ancestry symlink');
    for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
      const path = `${base}/${entry.name}`;
      if (excluded(path)) { continue; }
      assert.ok(!entry.isSymbolicLink(), `source symlink: ${path}`);
      if (entry.isDirectory()) { await walk(path); }
      else { assert.ok(entry.isFile(), `unsupported source input: ${path}`); observed.push(path); }
    }
  };
  for (const base of custodyRoots) {
    // Tiny disposable fixtures need only their actual source roots.
    try { await lstat(join(root, base)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !tracked.some(path => path.startsWith(`${base}/`))) { continue; }
      throw error;
    }
    await walk(base);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (common.includes(entry.name) || /\.(?:[cm]?ts|[cm]?js|json|ya?ml|toml|lock|c|h|sh)$/u.test(entry.name)) {
      assert.ok(entry.isFile(), `unsupported root source input: ${entry.name}`); observed.push(entry.name);
    }
  }
  assert.deepEqual(observed.toSorted(), selected, 'untracked/ignored or missing source inputs');
}

// Independent source oracle: every tracked byte and the original four expansions.
// It reads source files, never imports a product module or takes a receipt's universe.
export async function readProductSource(root: string, tracked: readonly string[]): Promise<ProductSource> {
  const roots = Object.values(packageRoots);
  await assertPhysicalCustody(root, tracked, roots);
  const inputs: Record<string, string> = {};
  for (const path of [...tracked].toSorted()) {
    assert.equal(await realpath(join(root, path, '..')), join(root, path, '..'), `tracked source ancestry symlink: ${path}`);
    assert.ok((await lstat(join(root, path))).isFile(), `non-file tracked input: ${path}`);
    inputs[path] = hash(await readFile(join(root, path)));
  }
  const manifests = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version',
    ...roots.map(base => `${base}/package.json`)].toSorted().map(path => [path, inputs[path]!]));
  assert.equal((await readFile(join(root, '.node-version'), 'utf8')).trim(), '24.21.0', 'pinned Node drift');
  const scripts: Scripts = object(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts) as Scripts;
  const baseline: { scripts: Scripts } = JSON.parse(await readFile(join(root, 'scripts/ci/full-contract.json'), 'utf8'));
  for (const name of ['product:check', 'product:build', ...phaseScripts.flat()]) {
    assert.equal(scripts[name], baseline.scripts[name], `original product script drift: ${name}`);
  }
  assert.equal(scripts['check:ci:product:packages'], 'pnpm product:check');
  assert.equal(scripts['check:ci:product'], 'pnpm check:ci:product:packages && pnpm check:ci:product:root && pnpm check:ci:product:typed && pnpm check:ci:product:native');
  phaseEntries.forEach((entry, index) => assert.equal(scripts[entry], phaseScripts[index]?.map(name => `pnpm ${name}`).join(' && ')));
  const runners = {} as Record<PackageId, string>;
  for (const [id, base] of Object.entries(packageRoots)) {
    const manifest = object(JSON.parse(await readFile(join(root, base, 'package.json'), 'utf8')));
    assert.equal(manifest.name, `@agent-teams/${id}`, 'fixed package identity');
    const runner = object(manifest.scripts).test; assert.equal(typeof runner, 'string');
    runners[id as PackageId] = runner as string;
  }
  assert.equal(runners['agent-execution'], aeRunner, 'frozen AE runner drift');
  const embeddedHelper = runners['embedded-runtime'].split(' ');
  assert.equal(embeddedHelper[0], 'node'); assert.equal(embeddedHelper.length, 2);
  const embeddedSource = await readFile(join(root, packageRoots['embedded-runtime'], embeddedHelper[1]!), 'utf8');
  const embeddedLiteral = /export const testProcesses = (\[[\s\S]*?\n\]);/u.exec(embeddedSource);
  assert.ok(embeddedLiteral, 'explicit original Embedded Runtime process inventory required');
  const embeddedArgv = array(JSON.parse(embeddedLiteral[1]!)).map(argv => { assert.ok(array(argv).every(v => typeof v === 'string')); return argv as string[]; });
  assert.equal(embeddedArgv.length, 2);
  const fullFiles: string[] = [];
  for (const pattern of aePatterns) {
    const matches: string[] = [];
    const base = join(root, packageRoots['agent-execution']);
    const directory = resolve(base, pattern.slice(0, pattern.lastIndexOf('/')));
    assert.equal(await realpath(directory), directory, 'AE ancestry symlink');
    for await (const path of glob(pattern, { cwd: base })) {
      if (basename(path).startsWith('.')) { continue; }
      assert.match(path, /^[a-z0-9/-]+\.test\.(?:ts|mjs)$/u, 'unsupported AE test input');
      assert.ok((await lstat(join(base, path))).isFile(), 'non-file AE test'); matches.push(path);
    }
    assert.ok(matches.length > 0, `missing AE pattern: ${pattern}`); fullFiles.push(...matches.toSorted());
  }
  assert.equal(new Set(fullFiles).size, fullFiles.length, 'overlapping original patterns');
  const universe = fullFiles.toSorted(); assert.ok(universe.length >= 3, 'empty AE partition');
  const packageStreams = {} as ProductSource['packageStreams'];
  // Independent directory expansion of the unchanged finite Node runner grammar.
  // Do not use the producer's glob, selection or receipt as this oracle.
  const expand = async (base: string, pattern: string): Promise<string[]> => {
    let prefixes = [''];
    for (const part of pattern.split('/')) {
      assert.ok(part === '*' || part === '*.test.ts' || /^[a-z0-9.-]+$/u.test(part), 'unsupported original runner input');
      const next: string[] = [];
      for (const prefix of prefixes) {
        const names = await readdir(join(base, prefix));
        next.push(...names.filter(name => !name.startsWith('.') && (part === '*' || (part === '*.test.ts' ? name.endsWith('.test.ts') : name === part)))
          .map(name => prefix ? `${prefix}/${name}` : name));
      }
      prefixes = next.toSorted();
    }
    assert.ok(prefixes.length > 0, `unmatched original runner input: ${pattern}`);
    for (const file of prefixes) {
      assert.ok((await lstat(join(base, file))).isFile(), 'regular runner input required');
      assert.equal(await realpath(join(base, file)), join(base, file), 'runner source symlink');
      assert.ok(inputs[relative(root, join(base, file))], 'runner input outside tracked source');
    }
    return prefixes;
  };
  for (const [id, path] of Object.entries(packageRoots)) {
    const base = join(root, path);
    let processes: string[][];
    if (id === 'embedded-runtime') {
      assert.equal(runners[id], 'node scripts/run-package-tests.mjs', 'original ER runner required');
      const source = await readFile(join(base, 'scripts/run-package-tests.mjs'), 'utf8');
      const literal = /export const testProcesses = (\[[\s\S]*?\n\]);/u.exec(source)?.[1];
      assert.ok(literal, 'explicit ER process source required');
      const parsed: unknown = JSON.parse(literal);
      assert.ok(Array.isArray(parsed) && parsed.length === 2 && parsed.every(args => Array.isArray(args) && args.every(arg => typeof arg === 'string')));
      processes = (parsed as string[][]).map(args => ['--test-reporter=./scripts/adoption-test-reporter.mjs', ...args]);
    } else {
      const args = runners[id as PackageId].split(' ');
      assert.deepEqual(args.slice(0, 3), ['node', '--test', '--test-concurrency=1'], 'original serial Node runner required');
      processes = [args.slice(1)];
    }
    packageStreams[id as PackageId] = [];
    for (const args of processes) {
      const options = args.filter(arg => arg.startsWith('--'));
      const files: string[] = [];
      for (const pattern of args.filter(arg => !arg.startsWith('--'))) { files.push(...await expand(base, pattern)); }
      assert.equal(new Set(files).size, files.length, 'overlapping whole-package runner files');
      packageStreams[id as PackageId].push({ argv: [...options, ...files], files });
    }
  }
  assert.deepEqual(packageStreams['agent-execution'][0]!.files, fullFiles, 'independent AE expansion drift');
  return { inputs, manifests, runners, universe, fullArgv: ['--test', '--test-concurrency=1', ...fullFiles],
    embeddedArgv, packageStreams, inventories: phaseEntries.map(entry => commandInventory(scripts, entry)) };
}

export function assertJobResults(needs: unknown, target: ExecutionTarget): void {
  const jobs = object(needs);
  assert.ok(['linux-x64', 'darwin-arm64'].includes(target));
  const expected = target === 'darwin-arm64' ? ['macos-product'] : ['packages', 'root'];
  assert.deepEqual(Object.keys(jobs).toSorted(), expected);
  for (const id of expected) { assert.equal(object(jobs[id]).result, 'success', `${id} incomplete`); }
}
function successful(proof: Record<string, unknown>): void {
  assert.equal(proof.code, 0, 'missing/failed process');
  assert.equal(proof.signal, null, 'cancelled process');
}
function testEvidence(value: unknown): Record<string, unknown>[] {
  const tests = array(value).map(object);
  assert.ok(tests.some(test => test.status === 'passed'), 'empty execution evidence');
  for (const test of tests) {
    assert.ok(['passed', 'skip', 'todo'].includes(String(test.status)), 'failed test');
    assert.ok(typeof test.name === 'string' && test.name.length > 0 && typeof test.suite === 'string');
    assert.ok(array(test.ancestry).every(name => typeof name === 'string'));
    assert.ok(Number.isSafeInteger(test.depth) && Number(test.depth) >= 0);
  }
  return tests;
}
function packageCommand(value: unknown, executable: string, argv: readonly string[], cwd: string): Record<string, unknown> {
  const proof = object(value);
  assert.equal(proof.exitCode, 0, 'missing/failed package process');
  assert.equal(proof.signal, null, 'cancelled package process'); assert.equal(proof.error, null, 'package process error');
  assert.equal(proof.executable, executable, 'executable drift'); assert.deepEqual(proof.argv, argv, 'runner argv drift');
  assert.equal(proof.cwd, cwd, 'execution directory drift');
  assert.ok(Number.isSafeInteger(proof.pid) && Number(proof.pid) > 0, 'missing process PID');
  assert.ok(typeof proof.wallMs === 'number' && Number.isFinite(proof.wallMs) && proof.wallMs >= 0);
  assert.ok(Number.isFinite(Date.parse(String(proof.start))) && Date.parse(String(proof.end)) >= Date.parse(String(proof.start)), 'missing process times');
  return proof;
}
function assertNativeEvidence(report: Record<string, unknown>, expected: ExpectedEvidence): void {
  const native = object(report.nativeBuild), root = String(report.checkoutRoot);
  assert.equal(native.cleanOutputAbsent, true, 'native output must follow successful clean');
  assert.equal(native.path, 'packages/platform/filesystem-custody/dist/rename-no-replace.node');
  assert.match(String(native.sha256), /^[a-f0-9]{64}$/u, 'native output hash required');
  assert.equal(native.format, 'Mach-O 64-bit bundle'); assert.equal(native.arch, 'arm64');
  const base = 'packages/platform/filesystem-custody';
  assert.equal(native.builderHash, expected.inputs[`${base}/scripts/build-native-helper.mjs`]);
  assert.equal(native.sourceHash, expected.inputs[`${base}/native/rename-no-replace.c`]);
  const compiler = object(native.compiler), driver = object(native.compilerDriver), headers = object(native.headers), sdk = object(native.sdk);
  for (const item of [compiler, driver, headers, sdk]) { assert.ok(typeof item.path === 'string' && isAbsolute(item.path)); }
  assert.match(String(driver.sha256), /^[a-f0-9]{64}$/u);
  assert.match(String(compiler.sha256), /^[a-f0-9]{64}$/u); assert.match(String(sdk.settingsHash), /^[a-f0-9]{64}$/u);
  const files = object(headers.files); assert.ok(files['node_api.h'] && files['js_native_api.h']);
  for (const digest of Object.values(files)) { assert.match(String(digest), /^[a-f0-9]{64}$/u); }
  assert.deepEqual(native.recipe, ['-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-bundle', '-undefined', 'dynamic_lookup', '-lsandbox',
    `-I${headers.path}`, 'native/rename-no-replace.c', '-o', 'dist/rename-no-replace.node']);
  const output = join(root, String(native.path));
  const probes = object(native.probes);
  const commands: Record<string, [string, string[]]> = {
    compilerDriver: ['/usr/bin/xcrun', ['--find', 'cc']], driverTrace: ['cc', ['-###', ...array(native.recipe) as string[]]],
    compilerPath: ['/bin/sh', ['-c', 'command -v cc']], compilerVersion: ['cc', ['--version']],
    sdkPath: ['/usr/bin/xcrun', ['--show-sdk-path']], sdkVersion: ['/usr/bin/xcrun', ['--show-sdk-version']],
    osVersion: ['/usr/bin/sw_vers', ['-productVersion']], osBuild: ['/usr/bin/sw_vers', ['-buildVersion']],
    format: ['/usr/bin/file', [output]], arch: ['/usr/bin/lipo', ['-archs', output]], digest: ['/usr/bin/shasum', ['-a', '256', output]],
  };
  assert.deepEqual(Object.keys(probes).toSorted(), Object.keys(commands).toSorted());
  for (const [name, [executable, argv]] of Object.entries(commands)) {
    const probe = object(probes[name]); packageCommand(probe.command, executable, argv, name === 'driverTrace' ? join(root, base) : root);
    assert.equal(typeof probe.stdout, 'string'); assert.equal(typeof probe.stderr, 'string');
    assert.ok(String(probe.stdout).trim() || String(probe.stderr).trim());
  }
  assert.equal(String(object(probes.sdkPath).stdout).trim(), sdk.path);
  assert.ok(typeof sdk.realPath === 'string' && isAbsolute(sdk.realPath));
  const trace = String(object(probes.driverTrace).stderr);
  assert.ok(trace.includes(String(sdk.path)) || trace.includes(sdk.realPath), 'native driver trace must bind current SDK');
  for (const input of [headers.path, 'native/rename-no-replace.c']) { assert.ok(trace.includes(String(input)), 'native driver trace must bind current headers/SDK/source'); }
  assert.match(String(object(probes.compilerVersion).stdout), /(?:Apple )?clang version/u);
  assert.match(String(object(probes.osVersion).stdout).trim(), /^15\.[0-9]+(?:\.[0-9]+)?$/u, 'Mac OS family drift');
  assert.match(String(object(probes.format).stdout), /Mach-O 64-bit bundle arm64/u);
  assert.equal(String(object(probes.arch).stdout).trim(), 'arm64');
  assert.equal(String(object(probes.digest).stdout).split(/\s+/u)[0], native.sha256, 'native output hash mismatch');
}
function assertReceiptPlatform(report: Record<string, unknown>, expected: ExpectedEvidence): void {
  const mac = expected.target === 'darwin-arm64';
  assert.equal(report.platform, mac ? 'darwin' : 'linux'); assert.equal(report.arch, mac ? 'arm64' : 'x64');
  const image = object(report.runnerImage);
  assert.equal(image.runnerOS, mac ? 'macOS' : 'Linux'); assert.equal(image.runnerArch, mac ? 'ARM64' : 'X64');
  if (mac) {
    assert.ok(Number.isSafeInteger(report.uid) && Number(report.uid) > 0, 'non-root Mac execution required');
    assert.match(String(image.os), /^macos15(?:-arm64)?$/u, 'macos-15 image family required');
    assert.match(String(image.version), /^[0-9]{8}\.[0-9]{4}(?:\.[0-9]+)?$/u, 'explicit current image version required');
    assert.match(String(report.execPath), /^\/Users\/runner\/hostedtoolcache\/node\/24\.21\.0\/arm64\/bin\/node$/u, 'pinned Mac Node toolcache required');
    assertNativeEvidence(report, expected);
  } else { assert.equal(report.nativeBuild, null); }
  assert.equal(report.node, 'v24.21.0'); assert.equal(report.pnpm, '11.18.0');
  if (!mac) { assert.equal(report.execPath, expected.nodeExecutable); }
}
function assertEmbeddedProcesses(report: Record<string, unknown>, observation: Record<string, unknown>, id: PackageId): void {
  if (id === 'embedded-runtime') {
    const children = array(report.embeddedProcesses).map(object), streams = array(observation.streams).map(object);
    assert.equal(children.length, 2, 'both actual Embedded Runtime exits required');
    assert.deepEqual(children, streams.map(stream => stream.original), 'original ER stream custody drift');
  } else { assert.equal(report.embeddedProcesses, null); }
}
function assertTestObservation(observation: Record<string, unknown>, context: { id: PackageId; index: number; selected: string[]; root: string }): void {
  const { id, index, selected, root } = context;
  const summaries = array(observation.summaries).map(object);
  assert.equal(summaries.length, id === 'embedded-runtime' ? 2 : 1, 'actual process summaries missing');
  for (const summary of summaries) {
    for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']) {
    assert.ok(Number.isSafeInteger(summary[key]) && Number(summary[key]) >= 0, 'invalid summary count');
    }
    assert.equal(summary.success, true); assert.ok(Number(summary.tests) > 0 && Number(summary.passed) > 0);
    for (const key of ['failed', 'cancelled', 'todo']) { assert.equal(summary[key], 0); }
    assert.equal(Number(summary.passed) + Number(summary.skipped), summary.tests);
  }
  const events = array(observation.events).map(object); assert.ok(events.length > 0, 'missing actual events');
  for (const event of events) {
    assert.ok(['passed', 'skipped'].includes(String(event.status)), 'failed/cancelled/todo event');
    const name = event.name ?? event.title; assert.ok(typeof name === 'string' && name.length > 0);
    assert.ok(['test', 'suite'].includes(String(event.type ?? event.kind)), 'unsupported event kind');
  }
  const tests = events.filter(event => (event.type ?? event.kind) === 'test');
  const total = (key: string) => summaries.reduce((sum, summary) => sum + Number(summary[key]), 0);
  assert.equal(tests.length, total('tests'), 'dropped test events');
  assert.equal(tests.filter(event => event.status === 'passed').length, total('passed'));
  assert.equal(tests.filter(event => event.status === 'skipped').length, total('skipped'), 'deliberate skips changed');
  const completed = array(observation.completedFiles);
  if (index < 3) {
    const files = selected.map(file => join(root, packageRoots[id], file));
    assert.deepEqual([...completed].toSorted(), files.toSorted(), 'missing/duplicate/extra completed file');
    assert.deepEqual([...new Set(events.map(event => event.file))].toSorted(), files.toSorted(), 'dropped/foreign file events');
    for (const event of events) { assert.ok(Number.isSafeInteger(event.observerPid) && Number(event.observerPid) > 0, 'actual Node reporter PID required'); }
  }
}
export function assertPackageEvidence(expected: ExpectedEvidence, receipts: readonly unknown[]): void {
  assert.ok(['linux-x64', 'darwin-arm64'].includes(expected.target), 'trusted target required');
  assert.match(expected.sha, /^[a-f0-9]{40}$/u); assert.match(expected.inputTree, /^[a-f0-9]{40}$/u);
  assert.match(expected.workflow.runId, /^[1-9][0-9]*$/u); assert.match(expected.workflow.workflowSha, /^[a-f0-9]{40}$/u);
  assert.ok(Number.isSafeInteger(expected.workflow.attempt) && expected.workflow.attempt > 0);
  assert.equal(receipts.length, 8, 'eight shard reports required');
  const packageReports = receipts.map(object);
  assert.deepEqual(packageReports.map(report => report.requestedShard).toSorted(), [...shardIds].toSorted(), 'missing/duplicate/extra shard');
  const union: string[] = [];
  for (const report of packageReports) {
    assert.equal(report.schemaVersion, 3, 'one actual producer contract');
    assert.equal(report.target, expected.target, 'trusted execution target mismatch');
    const workflow = object(report.workflow);
    assert.equal(workflow.runId, expected.workflow.runId, 'same workflow run required');
    assert.equal(workflow.workflowSha, expected.workflow.workflowSha, 'workflow source drift');
    assert.ok(Number.isSafeInteger(workflow.attempt) && Number(workflow.attempt) > 0 && Number(workflow.attempt) <= expected.workflow.attempt, 'invalid/future attempt');
    assert.equal(report.sourceSha, expected.sha, 'wrong source SHA'); assert.equal(report.sourceTree, expected.inputTree, 'wrong source tree');
    assertReceiptPlatform(report, expected);
    assert.equal(report.exitCode, 0); assert.equal(report.failure, null);
    assert.equal(report.runnerHash, expected.inputs['scripts/ci/package-execution.ts'], 'runner bytes drift');
    for (const key of ['sourceBefore', 'sourceAfter']) { assert.deepEqual(report[key], expected.inputs, 'complete source inventory drift'); }
    for (const key of ['before', 'after']) { assert.deepEqual(report[key], expected.manifests, 'manifest inventory drift'); }
    const root = report.checkoutRoot; assert.ok(typeof root === 'string' && isAbsolute(root), 'absolute checkout required');
    const index = shardIds.indexOf(report.requestedShard as ShardId);
    const id: PackageId = index < 3 ? 'agent-execution' : report.requestedShard as PackageId;
    assert.equal(report.packageName, `@agent-teams/${id}`);
    const commands = array(report.commands); assert.equal(commands.length, 3, 'all-six clean/build and selected test required');
    prerequisiteCommands.forEach((command, i) => packageCommand(commands[i], command.executable, command.argv, root));
    for (let i = 1; i < commands.length; i++) { assert.ok(Date.parse(String(object(commands[i]).start)) >= Date.parse(String(object(commands[i - 1]).end)), 'clean/build/test must execute in order'); }
    const selected = expected.universe.filter((_, i) => i % 3 === index);
    const reporter = join(root, 'scripts/ci/package-execution.ts');
    const proof = index < 3
      ? packageCommand(commands[2], String(report.execPath), ['--test', '--test-concurrency=1', `--test-reporter=${reporter}`, ...selected], join(root, packageRoots[id]))
      : packageCommand(commands[2], 'pnpm', ['--filter', `@agent-teams/${id}`, 'run', 'test'], root);
    if (index < 3) {
      const binding = { fullScript: expected.runners[id], fullArgv: expected.fullArgv, patterns: [...aePatterns],
        universeHash: hash(JSON.stringify(expected.universe)), partitionIndex: index, partitionCount: 3, files: selected };
      assert.deepEqual(report.selection, { ...binding, universe: expected.universe, bindingHash: hash(JSON.stringify(binding)) }, 'AE exact modulo selection drift');
      assert.ok(selected.length > 0); union.push(...selected);
    } else { assert.equal(report.selection, null, 'other five run whole commands'); }
    assertObservedStreams(expected, proof, { id, index, selected, root, packageRoot: packageRoots[id], nodeExecutable: String(report.execPath) });
    const observation = object(proof.observation);
    assertEmbeddedProcesses(report, observation, id);
    assertTestObservation(observation, { id, index, selected, root });
  }
  if (expected.target === 'darwin-arm64') {
    const tuple = (report: Record<string, unknown>) => { const native = object(report.nativeBuild); return { image: report.runnerImage, compiler: native.compiler, compilerDriver: native.compilerDriver, headers: native.headers, sdk: native.sdk,
      versions: Object.fromEntries(['compilerVersion', 'sdkVersion', 'osVersion', 'osBuild'].map(key => [key, object(object(native.probes)[key]).stdout])) }; };
    for (const report of packageReports) { assert.deepEqual(tuple(report), tuple(packageReports[0]!), 'mixed Mac image/compiler/SDK/header tuple'); }
  }
  assert.equal(new Set(union).size, union.length, 'overlapping AE shards');
  assert.deepEqual(union.toSorted(), expected.universe, 'AE union omits original test file');
}
export function assertFanoutEvidence(expected: ExpectedEvidence, packages: readonly unknown[], phases: readonly unknown[]): void {
  assert.match(expected.sha, /^[a-f0-9]{40}$/u); assert.match(expected.inputTree, /^[a-f0-9]{40}$/u);
  assert.equal(expected.target, 'linux-x64', 'root/typed/native phases are Linux obligations');
  assertPackageEvidence(expected, packages);
  assert.equal(phases.length, 3, 'root/typed/native reports required');
  const phaseReports = phases.map(object);
  assert.deepEqual(phaseReports.map(report => report.entry).toSorted(), [...phaseEntries].toSorted(), 'missing/duplicate product phase');
  for (const report of phaseReports) {
    assert.equal(report.sha, expected.sha); assert.equal(report.inputTree, expected.inputTree);
    assert.equal(report.platform, 'linux'); assert.equal(report.node, 'v24.21.0'); assert.equal(report.pnpm, '11.18.0');
    assert.equal(report.arm, 'production'); assert.equal(object(report.runnerImage).arch, 'X64');
    assert.deepEqual(report.digests, expected.measureDigests, 'measure input drift');
    const index = phaseEntries.indexOf(report.entry as typeof phaseEntries[number]);
    assert.deepEqual(report.inventory, expected.inventories[index], 'old-full phase inventory drift');
    const observed = array(report.phases).map(object);
    assert.deepEqual(observed.map(phase => phase.script), phaseScripts[index], 'dropped/duplicate product phase');
    for (const phase of observed) {
      successful(phase);
      const inventory = expected.inventories[index]?.filter(command => command.script === phase.script);
      assert.deepEqual(phase.commands, inventory, 'phase commands drift');
      if (phase.script === 'test' || phase.script === 'quality:native') { testEvidence(phase.tests); }
    }
  }
}

// receipt.json remains in each artifact's own directory. Diagnostic logs are not reports.
export async function reports(directory: string, kind: 'packages' | 'root' = 'packages'): Promise<unknown[]> {
  const found: unknown[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'evidence symlink');
    const accepted = kind === 'packages' ? entry.name === 'receipt.json' : ['root-custody.json', ...phaseEntries.map(phaseName => `${phaseName.replaceAll(':', '-')}.json`)].includes(entry.name);
    if (entry.isDirectory() || !accepted) { continue; }
    assert.ok(entry.isFile(), 'unexpected evidence input');
    const receipt: unknown = JSON.parse(await readFile(join(entry.parentPath, entry.name), 'utf8'));
    if (object(receipt).target === 'darwin-arm64') {
      const native = object(object(receipt).nativeBuild);
      const bytes = await readFile(join(entry.parentPath, 'rename-no-replace.node'));
      assert.equal(hash(bytes), native.sha256, 'downloaded native output hash mismatch');
      const { assertMachOArm64 } = await import('./package-execution.ts'); assertMachOArm64(bytes);
    }
    found.push(receipt);
  }
  return found;
}
export function assertRootCustody(value: unknown, expected: Pick<ExpectedEvidence, 'sha' | 'inputTree' | 'inputs'>): void {
  const proof = object(value); assert.equal(proof.kind, 'root-custody');
  assert.equal(proof.sourceSha, expected.sha); assert.equal(proof.sourceTree, expected.inputTree);
  assert.deepEqual(proof.before, expected.inputs); assert.deepEqual(proof.after, expected.inputs, 'root source drift or incomplete execution');
}
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'one fixed mode required');
  const mode = process.argv[2];
  assert.ok(['results', 'evidence', 'darwin-results', 'darwin-evidence', 'custody-start', 'custody-end'].includes(mode ?? ''), 'unknown gate mode');
  const target: ExecutionTarget = mode?.startsWith('darwin-') ? 'darwin-arm64' : 'linux-x64';
  if (mode?.endsWith('results') || mode?.endsWith('evidence')) {
    assert.equal(process.env.EXECUTION_TARGET, target, 'workflow must supply trusted target');
    assertJobResults(JSON.parse(process.env.NEEDS ?? '{}'), target);
  }
  if (!mode?.endsWith('results')) {
    const root = process.cwd();
    const sha = git('rev-parse', 'HEAD').trim(); assert.equal(sha, process.env.EXPECTED_REVISION);
    assert.match(sha, /^[a-f0-9]{40}$/u);
    const inputTree = git('rev-parse', 'HEAD^{tree}').trim();
    const tracked = git('ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
    const source = await readProductSource(root, tracked);
    execFileSync('git', ['diff', '--quiet', 'HEAD']);
    if (mode?.endsWith('evidence')) {
      const { inputPaths } = await import('./measure.ts');
      const measureDigests: Record<string, string> = {};
      for (const path of inputPaths) { measureDigests[path] = hash(await readFile(path)); }
      const { parse } = await import('yaml');
      const expected = { ...source, sha, inputTree, target, workflow: workflowIdentity(process.env), nodeExecutable: process.execPath, measureDigests };
      if (target === 'darwin-arm64') {
        assertDarwinWorkflow(parse(await readFile('.github/workflows/ci-darwin-packages.yml', 'utf8')));
        assert.ok(process.env.CI_PACKAGE_REPORT_DIR);
        assertPackageEvidence(expected, await reports(process.env.CI_PACKAGE_REPORT_DIR));
      } else {
      assertProductWorkflow(parse(await readFile('.github/workflows/ci-product.yml', 'utf8')));
      assertShardWorkflow(parse(await readFile('.github/workflows/ci-product-shard.yml', 'utf8')));
      assert.ok(process.env.CI_PACKAGE_REPORT_DIR && process.env.CI_ROOT_REPORT_DIR, 'external evidence directories required');
      const rootReports = await reports(process.env.CI_ROOT_REPORT_DIR, 'root');
      const custody = rootReports.filter(report => object(report).kind === 'root-custody');
      assert.equal(custody.length, 1, 'one completed root custody receipt required');
      assertRootCustody(custody[0], { ...source, sha, inputTree });
      assertFanoutEvidence(expected,
        await reports(process.env.CI_PACKAGE_REPORT_DIR), rootReports.filter(report => object(report).kind !== 'root-custody'));
      }
    } else {
      const output = process.env.CI_EVIDENCE_DIR; assert.ok(output, 'external custody directory required');
      assert.ok(relative(root, resolve(output)).startsWith('..'), 'custody must be outside checkout');
      await mkdir(output, { recursive: true });
      const path = join(output, 'root-custody.json');
      if (mode === 'custody-start') {
        await writeFile(path, JSON.stringify({ kind: 'root-custody', sourceSha: sha, sourceTree: inputTree, before: source.inputs, after: null }), { flag: 'wx' });
      } else {
        const proof = object(JSON.parse(await readFile(path, 'utf8')));
        assert.equal(proof.after, null, 'custody cannot be reused');
        const completed = { ...proof, after: source.inputs };
        assertRootCustody(completed, { ...source, sha, inputTree }); await writeFile(path, JSON.stringify(completed));
      }
    }
  }
  console.log('Full target-specific product checkpoint validated; hosted qualification and speed remain separate.');
}
