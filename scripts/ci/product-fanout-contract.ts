import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  universe: string[]; fullArgv: string[]; inventories: readonly Command[][];
}
export interface ExpectedEvidence extends ProductSource {
  sha: string; inputTree: string; nodeExecutable: string; measureDigests: Record<string, string>;
}

// Independent source oracle: every tracked byte and the original four expansions.
// It reads source files, never imports a product module or takes a receipt's universe.
export async function readProductSource(root: string, tracked: readonly string[]): Promise<ProductSource> {
  const roots = Object.values(packageRoots);
  const generated = (path: string) => roots.some(base =>
    ['dist', '.cache', 'node_modules'].some(dir => path === `${base}/${dir}` || path.startsWith(`${base}/${dir}/`)));
  const common = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', 'tsconfig.json'];
  const selected = tracked.filter(path => !generated(path) &&
    (roots.some(base => path.startsWith(`${base}/`)) || path.startsWith('scripts/ci/') || path.startsWith('.github/workflows/') || common.includes(path))).toSorted();
  const observed: string[] = [];
  for (const base of [...roots, 'scripts/ci', '.github/workflows']) {
    assert.equal(await realpath(join(root, base)), join(root, base), 'source root symlink');
    for (const entry of await readdir(join(root, base), { recursive: true, withFileTypes: true })) {
      const path = relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
      if (generated(path) || entry.isDirectory()) { continue; }
      assert.ok(entry.isFile(), `unsupported source input: ${path}`); observed.push(path);
    }
  }
  assert.deepEqual([...observed, ...common].toSorted(), selected, 'untracked/ignored or missing source inputs');
  const inputs: Record<string, string> = {};
  for (const path of [...tracked].toSorted()) {
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
  return { inputs, manifests, runners, universe, fullArgv: ['--test', '--test-concurrency=1', ...fullFiles],
    inventories: phaseEntries.map(entry => commandInventory(scripts, entry)) };
}

export function assertJobResults(needs: unknown): void {
  const jobs = object(needs);
  assert.deepEqual(Object.keys(jobs).toSorted(), ['packages', 'root']);
  for (const id of ['packages', 'root']) { assert.equal(object(jobs[id]).result, 'success', `${id} incomplete`); }
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
export function assertPackageEvidence(expected: ExpectedEvidence, receipts: readonly unknown[]): void {
  assert.equal(receipts.length, 8, 'eight shard reports required');
  const packageReports = receipts.map(object);
  assert.deepEqual(packageReports.map(report => report.requestedShard).toSorted(), [...shardIds].toSorted(), 'missing/duplicate/extra shard');
  const union: string[] = [];
  for (const report of packageReports) {
    assert.equal(report.schemaVersion, 2, 'one actual producer contract');
    assert.equal(report.sourceSha, expected.sha, 'wrong source SHA'); assert.equal(report.sourceTree, expected.inputTree, 'wrong source tree');
    assert.equal(report.platform, 'linux'); assert.equal(report.arch, 'x64');
    assert.equal(report.node, 'v24.21.0'); assert.equal(report.pnpm, '11.18.0');
    assert.equal(report.execPath, expected.nodeExecutable);
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
    const selected = expected.universe.filter((_, i) => i % 3 === index);
    const reporter = join(root, 'scripts/ci/package-execution.ts');
    const proof = index < 3
      ? packageCommand(commands[2], expected.nodeExecutable, ['--test', '--test-concurrency=1', `--test-reporter=${reporter}`, ...selected], join(root, packageRoots[id]))
      : packageCommand(commands[2], 'pnpm', ['--filter', `@agent-teams/${id}`, 'run', 'test'], root);
    if (index < 3) {
      const binding = { fullScript: expected.runners[id], fullArgv: expected.fullArgv, patterns: [...aePatterns],
        universeHash: hash(JSON.stringify(expected.universe)), partitionIndex: index, partitionCount: 3, files: selected };
      assert.deepEqual(report.selection, { ...binding, universe: expected.universe, bindingHash: hash(JSON.stringify(binding)) }, 'AE exact modulo selection drift');
      assert.ok(selected.length > 0); union.push(...selected);
    } else { assert.equal(report.selection, null, 'other five run whole commands'); }
    const observation = object(proof.observation);
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
    }
  }
  assert.equal(new Set(union).size, union.length, 'overlapping AE shards');
  assert.deepEqual(union.toSorted(), expected.universe, 'AE union omits original test file');
}
export function assertFanoutEvidence(expected: ExpectedEvidence, packages: readonly unknown[], phases: readonly unknown[]): void {
  assert.match(expected.sha, /^[a-f0-9]{40}$/u); assert.match(expected.inputTree, /^[a-f0-9]{40}$/u);
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

const checkout = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
const setup = 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38';
const upload = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const download = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
const revisionGuard = 'set -euo pipefail\n[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]]\ntest "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"\n';
const retainedHistory = 'set -euo pipefail\nobject=8e5e859d10981e1623d0617e933afc68a9e8770c\nif ! git cat-file -e "$object^{commit}"; then\n  git fetch --no-tags origin "$object"\nfi\ntest "$(git rev-parse "$object^{commit}")" = "$object"\ngit fsck --connectivity-only --no-reflogs "$object"\n';
const enablePnpm = 'corepack enable\ncorepack install --global pnpm@11.18.0\n';
function assertProductSteps(steps: Record<string, unknown>[]): void {
  for (const step of steps) {
    assert.ok(Object.keys(step).every(key => ['name', 'run', 'shell', 'uses', 'with', 'if'].includes(key)), 'unreviewed step field');
    assert.equal(step.env, undefined, 'no step environment overrides');
    if (step.run !== undefined) {
      assert.equal(step.if, undefined, 'unconditional full phases');
      assert.ok(!String(step.run).includes('${{'), 'no shell input interpolation');
      assert.equal(step.uses, undefined); assert.equal(step.with, undefined);
      assert.equal(step.shell, step.run === revisionGuard || step.run === retainedHistory ? 'bash' : undefined);
    } else {
      assert.ok([checkout, setup, upload, download].includes(String(step.uses)), 'unadmitted action');
      if (step.uses === upload) {
        assert.ok(['${{ always() }}', '${{ success() }}'].includes(String(step.if)), 'archive/current upload condition');
      } else { assert.equal(step.if, undefined); }
      assert.equal(step.shell, undefined);
    }
  }
}
export function assertProductWorkflow(value: unknown): void {
  const workflow = object(value);
  assert.deepEqual(Object.keys(workflow).toSorted(), ['jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on, { workflow_call: { inputs: { revision: { required: true, type: 'string' }, artifact: { required: true, type: 'string' } } } });
  const jobs = object(workflow.jobs);
  assert.deepEqual(Object.keys(jobs).toSorted(), ['aggregate', 'packages', 'root']);
  const packages = object(jobs.packages);
  assert.deepEqual(packages, { strategy: { 'fail-fast': false, matrix: { shard: [...shardIds] } },
    uses: './.github/workflows/ci-product-shard.yml', with: { shard: '${{ matrix.shard }}', revision: '${{ inputs.revision }}', artifact: '${{ inputs.artifact }}' } });
  for (const name of ['root', 'aggregate']) {
    const job = object(jobs[name]);
    assert.deepEqual(Object.keys(job).toSorted(), name === 'root'
      ? ['env', 'runs-on', 'steps', 'timeout-minutes'] : ['env', 'if', 'needs', 'runs-on', 'steps', 'timeout-minutes']);
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.equal(job['timeout-minutes'], name === 'root' ? 35 : 10);
    assert.equal(job['continue-on-error'], undefined); assert.equal(job.permissions, undefined);
    assert.equal(job.secrets, undefined); assert.equal(job.environment, undefined);
    assert.equal(job.if, name === 'aggregate' ? '${{ always() }}' : undefined);
    assert.deepEqual(job.needs, name === 'aggregate' ? ['packages', 'root'] : undefined);
    const env = object(job.env); assert.equal(env.EXPECTED_REVISION, '${{ inputs.revision }}');
    const steps = array(job.steps).map(object);
    const firstStep = object(steps[0]), guardStep = object(steps[1]), historyStep = object(steps[2]), lastStep = object(steps.at(-1));
    assert.deepEqual(firstStep.with, { ref: '${{ inputs.revision }}', 'persist-credentials': false, 'fetch-depth': 0 });
    assert.equal(firstStep.uses, checkout);
    const guard = String(guardStep.run);
    assert.equal(guardStep.shell, 'bash');
    assert.equal(guard, revisionGuard);
    assert.deepEqual(steps.find(step => step.uses === setup)?.with, { 'node-version-file': '.node-version' });
    assert.equal(historyStep.shell, 'bash'); assert.equal(historyStep.run, retainedHistory);
    assert.equal(steps.filter(step => step.uses === checkout).length, 1);
    assert.equal(steps.filter(step => step.uses === setup).length, 1);
    assert.equal(steps.filter(step => step.uses === upload).length, name === 'root' ? 2 : 0);
    assert.equal(steps.filter(step => step.uses === download).length, name === 'aggregate' ? 2 : 0);
    const runs = steps.filter(step => step.run !== undefined).map(step => step.run);
    const install = runs.indexOf('pnpm install --frozen-lockfile'); assert.ok(install > 0);
    assert.ok(runs.includes(enablePnpm));
    assertProductSteps(steps);
    const sequence = steps.map(step => step.uses ?? step.run);
    const rootSequence = [checkout, revisionGuard, retainedHistory, setup, 'node scripts/ci/gate.ts revision', enablePnpm,
      'pnpm install --frozen-lockfile', 'node scripts/ci/product-fanout-contract.ts custody-start',
      "pnpm --filter './packages/**' -r run clean", 'pnpm product:build', ...phaseEntries.map(entry => `node scripts/ci/measure.ts ${entry}`),
      'node scripts/ci/product-fanout-contract.ts custody-end', upload, upload];
    const aggregateSequence = [checkout, revisionGuard, retainedHistory, setup, 'node scripts/ci/product-fanout-contract.ts results', enablePnpm,
      'pnpm install --frozen-lockfile', download, download, 'node scripts/ci/product-fanout-contract.ts evidence'];
    assert.deepEqual(sequence, name === 'root' ? rootSequence : aggregateSequence);

    if (name === 'root') {
      assert.deepEqual(runs, [revisionGuard, retainedHistory, 'node scripts/ci/gate.ts revision', enablePnpm,
        'pnpm install --frozen-lockfile', 'node scripts/ci/product-fanout-contract.ts custody-start',
        'pnpm --filter \'./packages/**\' -r run clean', 'pnpm product:build', ...phaseEntries.map(entry => `node scripts/ci/measure.ts ${entry}`),
        'node scripts/ci/product-fanout-contract.ts custody-end']);
      for (const key of ['AUTHOR', 'COMMITTER']) { assert.equal(env[`GIT_${key}_NAME`], 'iliya'); assert.equal(env[`GIT_${key}_EMAIL`], 'iliyazelenkog@gmail.com'); }
      assert.equal(env.CI_EVIDENCE_DIR, '${{ runner.temp }}/ci-product-root');
      const archive = object(steps.at(-2));
      assert.equal(archive.uses, upload); assert.equal(archive.if, '${{ always() }}');
      assert.deepEqual(archive.with, { name: 'full-ci-${{ inputs.artifact }}-root-${{ github.run_attempt }}',
        path: '${{ runner.temp }}/ci-product-root/*.json', 'if-no-files-found': 'error', 'retention-days': 14 });
      assert.equal(lastStep.uses, upload); assert.equal(lastStep.if, '${{ success() }}');
      assert.deepEqual(lastStep.with, { name: 'full-ci-${{ inputs.artifact }}-root-current',
        path: '${{ runner.temp }}/ci-product-root/*.json', 'if-no-files-found': 'error', 'retention-days': 14, overwrite: true });
      assert.deepEqual(Object.keys(env).toSorted(), ['CI_EVIDENCE_DIR', 'EXPECTED_REVISION', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME']);
    } else {
      assert.equal(env.NEEDS, '${{ toJSON(needs) }}');
      assert.deepEqual(runs, [revisionGuard, retainedHistory, 'node scripts/ci/product-fanout-contract.ts results', enablePnpm,
        'pnpm install --frozen-lockfile', 'node scripts/ci/product-fanout-contract.ts evidence']);
      assert.equal(env.CI_PACKAGE_REPORT_DIR, '${{ runner.temp }}/ci-product-reports/packages');
      assert.equal(env.CI_ROOT_REPORT_DIR, '${{ runner.temp }}/ci-product-reports/root');
      assert.deepEqual(Object.keys(env).toSorted(), ['CI_PACKAGE_REPORT_DIR', 'CI_ROOT_REPORT_DIR', 'EXPECTED_REVISION', 'NEEDS']);
      // Exact inputs preserve the action's default same-workflow-run scope:
      // no run-id, repository, token or artifact-id may select another run.
      assert.deepEqual(steps.filter(step => step.uses === download).map(step => step.with), [
        { pattern: 'full-ci-${{ inputs.artifact }}-package-*-current', path: '${{ runner.temp }}/ci-product-reports/packages', 'merge-multiple': false },
        { name: 'full-ci-${{ inputs.artifact }}-root-current', path: '${{ runner.temp }}/ci-product-reports/root' },
      ]);
    }
  }
}

export function assertShardWorkflow(value: unknown): void {
  const workflow = object(value);
  assert.deepEqual(Object.keys(workflow).toSorted(), ['jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on, { workflow_call: { inputs: Object.fromEntries(['shard', 'revision', 'artifact'].map(key =>
    [key, { required: true, type: 'string' }])) } });
  const jobs = object(workflow.jobs); assert.deepEqual(Object.keys(jobs), ['shard']);
  const job = object(jobs.shard);
  assert.deepEqual(Object.keys(job).toSorted(), ['env', 'runs-on', 'steps', 'timeout-minutes']);
  assert.equal(job['runs-on'], 'ubuntu-24.04'); assert.equal(job['timeout-minutes'], 35);
  assert.deepEqual(job.env, { GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
    GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
    EXPECTED_REVISION: '${{ inputs.revision }}', PACKAGE_SHARD: '${{ inputs.shard }}',
    CI_EVIDENCE_DIR: '${{ runner.temp }}/ci-product-shard' });
  const steps = array(job.steps).map(item => {
    const { name: _name, ...step } = object(item); return step;
  });
  assert.deepEqual(steps, [
    { uses: checkout, with: { ref: '${{ inputs.revision }}', 'persist-credentials': false, 'fetch-depth': 0 } },
    { shell: 'bash', run: revisionGuard }, { shell: 'bash', run: retainedHistory },
    { uses: setup, with: { 'node-version-file': '.node-version' } },
    { run: 'node scripts/ci/gate.ts revision' }, { run: enablePnpm }, { run: 'pnpm install --frozen-lockfile' },
    { run: 'node scripts/ci/package-execution.ts' },
    { if: '${{ always() }}', uses: upload, with: {
      name: 'full-ci-${{ inputs.artifact }}-package-${{ inputs.shard }}-${{ github.run_attempt }}',
      path: '${{ runner.temp }}/ci-product-shard/receipt.json', 'if-no-files-found': 'error', 'retention-days': 14 } },
    { if: '${{ success() }}', uses: upload, with: {
      name: 'full-ci-${{ inputs.artifact }}-package-${{ inputs.shard }}-current',
      path: '${{ runner.temp }}/ci-product-shard/receipt.json', 'if-no-files-found': 'error', 'retention-days': 14, overwrite: true } },
  ]);
}

// receipt.json remains in each artifact's own directory. Diagnostic logs are not reports.
export async function reports(directory: string): Promise<unknown[]> {
  const found: unknown[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'evidence symlink');
    if (entry.isDirectory() || !entry.name.endsWith('.json')) { continue; }
    assert.ok(entry.isFile(), 'unexpected evidence input');
    found.push(JSON.parse(await readFile(join(entry.parentPath, entry.name), 'utf8')));
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
  assert.ok(['results', 'evidence', 'custody-start', 'custody-end'].includes(mode ?? ''), 'unknown gate mode');
  if (mode === 'results' || mode === 'evidence') { assertJobResults(JSON.parse(process.env.NEEDS ?? '{}')); }
  if (mode !== 'results') {
    const root = process.cwd();
    const sha = git('rev-parse', 'HEAD').trim(); assert.equal(sha, process.env.EXPECTED_REVISION);
    assert.match(sha, /^[a-f0-9]{40}$/u);
    const inputTree = git('rev-parse', 'HEAD^{tree}').trim();
    const tracked = git('ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
    const source = await readProductSource(root, tracked);
    execFileSync('git', ['diff', '--quiet', 'HEAD']);
    if (mode === 'evidence') {
      const { inputPaths } = await import('./measure.ts');
      const measureDigests: Record<string, string> = {};
      for (const path of inputPaths) { measureDigests[path] = hash(await readFile(path)); }
      const { parse } = await import('yaml');
      assertProductWorkflow(parse(await readFile('.github/workflows/ci-product.yml', 'utf8')));
      assertShardWorkflow(parse(await readFile('.github/workflows/ci-product-shard.yml', 'utf8')));
      assert.ok(process.env.CI_PACKAGE_REPORT_DIR && process.env.CI_ROOT_REPORT_DIR, 'external evidence directories required');
      const rootReports = await reports(process.env.CI_ROOT_REPORT_DIR);
      const custody = rootReports.filter(report => object(report).kind === 'root-custody');
      assert.equal(custody.length, 1, 'one completed root custody receipt required');
      assertRootCustody(custody[0], { ...source, sha, inputTree });
      assertFanoutEvidence({ ...source, sha, inputTree, nodeExecutable: process.execPath, measureDigests },
        await reports(process.env.CI_PACKAGE_REPORT_DIR), rootReports.filter(report => object(report).kind !== 'root-custody'));
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
  console.log('Full Linux product checkpoint validated; hosted qualification and speed remain separate.');
}
