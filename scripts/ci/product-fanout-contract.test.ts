import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parse } from 'yaml';
import { aePatterns, assertFanoutEvidence, assertJobResults, assertProductWorkflow, packageRoots,
  phaseEntries, prerequisiteCommands, readProductSource, shardIds, assertShardWorkflow, assertRootCustody, reports } from './product-fanout-contract.ts';
import type { ExpectedEvidence, PackageId, ShardId } from './product-fanout-contract.ts';
import { commandExit, executionSelection, packages as originalPackages, packageStreamPlans, runCommand, selectShard } from './package-execution.ts';
import type { PackageReceipt } from './package-execution.ts';

const scripts = {
  'product:check': "pnpm --filter './packages/**' -r run clean && pnpm product:build && pnpm --filter './packages/**' -r run test",
  'product:build': "pnpm --filter './packages/**' -r run build",
  typecheck: 'tsc --project tsconfig.json --noEmit --pretty false', test: 'node --test fixtures.test.ts',
  'lint:typed': 'agent-teams-foundation quality check --consumer .', 'quality:native': 'node scripts/foundation/check-native-quality.mjs',
  'check:ci:product:packages': 'pnpm product:check', 'check:ci:product:root': 'pnpm typecheck && pnpm test',
  'check:ci:product:typed': 'pnpm lint:typed', 'check:ci:product:native': 'pnpm quality:native',
  'check:ci:product': 'pnpm check:ci:product:packages && pnpm check:ci:product:root && pnpm check:ci:product:typed && pnpm check:ci:product:native',
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'product-fanout-TEST-'));
  const tracked: string[] = [];
  const put = async (path: string, value: string) => {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), value); tracked.push(path);
  };
  await put('package.json', JSON.stringify({ scripts }));
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']) { await put(path, 'TEST'); }
  await put('.node-version', '24.21.0');
  await put('.github/workflows/ci-product.yml', '# disposable fixture');
  await put('scripts/ci/package-execution.ts', await readFile(new URL('./package-execution.ts', import.meta.url), 'utf8'));
  await put('pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
  tracked.pop(); // overwrite, retaining one source identity
  await put('scripts/ci/full-contract.json', JSON.stringify({ scripts }));
  for (const [id, base] of Object.entries(packageRoots)) {
    await put(`${base}/package.json`, JSON.stringify({ name: `@agent-teams/${id}`, type: 'module', scripts: {
      clean: 'node scripts/clean.ts', build: 'node scripts/build.ts',
      test: originalPackages.find(p => p.root === base)!.test,
    } }));
    await put(`${base}/src/input.ts`, 'export const disposable = true;');
    await put(`${base}/scripts/build.ts`, "import { mkdir } from 'node:fs/promises'; await mkdir(new URL('../dist/', import.meta.url), {recursive:true});");
    await put(`${base}/scripts/clean.ts`, "import { rm } from 'node:fs/promises'; await rm(new URL('../dist/', import.meta.url), {recursive:true,force:true});");
    await put(`${base}/tests/example.test.ts`, "import test from 'node:test'; test('actual fixture observation', () => {}); test('preserved skip', {skip:true}, () => {});");
    if (id !== 'agent-execution' && id !== 'embedded-runtime') {
      for (const pattern of originalPackages.find(p => p.root === base)!.test.split(' ').slice(3)) {
        const file = pattern.replaceAll('*', 'example');
        await put(`${base}/${file}`, "import test from 'node:test'; test('first identity', () => {}); test('second identity', () => {}); for (const name of ['repeat', 'repeat']) { test(name, () => {}); } test('skip', {skip:true}, () => {});\n");
      }
    }
    if (id === 'embedded-runtime') {
      await put(`${base}/tests/second.test.ts`, "import test from 'node:test'; test('second actual process', () => {});");
      await put(`${base}/scripts/adoption-test-reporter.mjs`, await readFile(new URL('../../packages/apps/embedded-runtime/scripts/adoption-test-reporter.mjs', import.meta.url), 'utf8'));
      const runner = await readFile(new URL('../../packages/apps/embedded-runtime/scripts/run-package-tests.mjs', import.meta.url), 'utf8');
      await put(`${base}/scripts/run-package-tests.mjs`, runner.replace(/export const testProcesses = (\[[\s\S]*?\n\]);/u,
        'export const testProcesses = [\n  ["--test", "--test-concurrency=1", "tests/example.test.ts"],\n  ["--experimental-test-module-mocks", "--test", "tests/second.test.ts"]\n];'));

    }
  }
  // Uneven universe, literal mjs, and intentionally unsorted creation order.
  const files = ['tests/package/z.test.ts', 'tests/features/contained-agent-turn/b.test.ts',
    'tests/features/runtime-installation-discovery/a.test.ts', 'tests/package/a.test.ts',
    'tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs',
    'tests/features/contained-agent-turn/a.test.ts', 'tests/package/m.test.ts'];
  for (const file of files) { await put(`${packageRoots['agent-execution']}/${file}`, "import test from 'node:test'; test('actual fixture file', () => {}); test('other passing identity', () => {}); for (const name of ['repeat', 'repeat']) { test(name, () => {}); } test('deliberate TEST skip', {skip:true}, () => {});"); }
  const source = await readProductSource(root, tracked);
  const expected: ExpectedEvidence = { ...source, sha: 'a'.repeat(40), inputTree: 'b'.repeat(40), nodeExecutable: process.execPath, measureDigests: { 'package.json': 'c'.repeat(64) } };
  return { root, tracked, expected };
}
const phaseEvent = (suite = 'fixture') => ({ suite, name: 'observed TEST boundary', ancestry: [], depth: 0, status: 'passed', kind: 'test' as const });
// Unit receipt metadata names the disposable fixture. Command proofs and observations
// are the unmodified actual v2 producer output, never current-suite qualification.
async function packageReports(root: string, expected: ExpectedEvidence, requested: readonly ShardId[] = shardIds): Promise<PackageReceipt[]> {
  const receipts: PackageReceipt[] = [];
  const logs = await mkdtemp(join(root, 'command-attempt-'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  for (const shard of requested) {
    const index = shardIds.indexOf(shard);
    const id: PackageId = index < 3 ? 'agent-execution' : shard as PackageId;
    const selection = await executionSelection(root, selectShard(shard));
    const commands = [];
    for (const [i, command] of prerequisiteCommands.entries()) {
      commands.push(await runCommand(command.executable, [...command.argv], root, env, join(logs, `${shard}-${i}`)));
    }
    const reporter = join(root, 'scripts/ci/package-execution.ts');
    const capture = join(logs, `${shard}-capture`);
    if (id === 'embedded-runtime') { await mkdir(capture); }
    const embeddedEnv = { ...env, CI_ER_PROCESS_OBSERVER: '1', AE_ADOPTION_CAPTURE_DIR: capture,
      NODE_OPTIONS: `--test-reporter=${reporter} --test-reporter-destination=stderr --test-reporter-destination=stdout` };
    commands.push(selection
      ? await runCommand(process.execPath, ['--test', '--test-concurrency=1', `--test-reporter=${reporter}`, ...selection.files],
        join(root, packageRoots[id]), env, join(logs, `${shard}-2`))
      : await runCommand('pnpm', ['--filter', `@agent-teams/${id}`, 'run', 'test'], root,
        id === 'embedded-runtime' ? embeddedEnv : { ...env, NODE_OPTIONS: `--test-reporter=${reporter}` }, join(logs, `${shard}-2`)));
    const plans = await packageStreamPlans(root, selectShard(shard), selection);
    assert.equal(commandExit(commands[2]!, id === 'embedded-runtime' ? 2 : 1, undefined, plans, Object.keys(expected.inputs).map(file => join(root, file))), 0, `producer ${shard}`);
    receipts.push({ schemaVersion: 2, requestedShard: shard, packageName: `@agent-teams/${id}`,
      sourceSha: expected.sha, sourceTree: expected.inputTree, checkoutRoot: root, selection,
      platform: 'linux', arch: 'x64', uid: process.getuid?.() ?? null, node: 'v24.21.0', execPath: process.execPath, pnpm: '11.18.0',
      runnerImage: { os: null, version: null, runnerOS: null, runnerArch: null }, runnerHash: expected.inputs['scripts/ci/package-execution.ts']!,
      before: { ...expected.manifests }, after: { ...expected.manifests }, sourceBefore: { ...expected.inputs }, sourceAfter: { ...expected.inputs },
      commands, exitCode: 0, failure: null, coverage: 'actual disposable TEST processes; fixture source identity, not current product suite' });
  }
  return receipts;
}
function phaseReports(expected: ExpectedEvidence) {
  const names = [['typecheck', 'test'], ['lint:typed'], ['quality:native']];
  return phaseEntries.map((entry, i) => ({ entry, sha: expected.sha, inputTree: expected.inputTree, platform: 'linux',
    node: 'v24.21.0', pnpm: '11.18.0', arm: 'production', runnerImage: { arch: 'X64' }, digests: { ...expected.measureDigests },
    inventory: expected.inventories[i], phases: names[i]?.map(script => ({ script, code: 0, signal: null,
      commands: expected.inventories[i]?.filter(command => command.script === script), tests: [phaseEvent()] })) }));
}
export function registerProductFanoutTests(): void {
registerProductSourceCustodyTests(); registerProductWorkflowTests();
test('source-derived full coverage preserves all eight runners and old root/type/native commands', async t => {
  const { root, expected } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(expected.universe.length, 7); assert.deepEqual(expected.universe, expected.universe.toSorted());
  const packages = await packageReports(root, expected), phases = phaseReports(expected);
  assertFanoutEvidence(expected, packages.toReversed(), phases.toReversed());
  if (process.env.CI_FOCUSED_EVIDENCE_DIR) { await writeFile(join(process.env.CI_FOCUSED_EVIDENCE_DIR, 'synthetic-fanout-processes.json'), JSON.stringify({ scope: 'actual disposable TEST commands; no product qualification', expected, packages, phases }, null, 2)); }
  const embedded = packages.find(report => report.packageName === '@agent-teams/embedded-runtime')!;
  assert.equal(embedded.commands[2]!.observation.summaries.length, 2);
  assert.ok(embedded.commands[2]!.observation.events.some(event => event.title === 'second actual process' && event.name === undefined));
  assert.deepEqual(packages.slice(0, 3).flatMap(report => report.selection?.files ?? []).toSorted(), expected.universe);
  const reject = async (name: string, change: (p: PackageReceipt[], r: ReturnType<typeof phaseReports>) => void) => {
    await t.test(name, () => { const p = structuredClone(packages), r = structuredClone(phases); change(p, r); assert.throws(() => assertFanoutEvidence(expected, p, r)); });
  };
  await reject('same-file balanced duplicate identity', p => {
    const observation = p[0]!.commands[2]!.observation;
    const first = observation.events.find(e => e.name === 'actual fixture file')!;
    const second = observation.events.find(e => e.file === first.file && e.name === 'other passing identity')!;
    observation.events[observation.events.indexOf(first)] = { ...second };
    assert.equal(commandExit(p[0]!.commands[2]!, 1), 1);
  });
  await reject('PA RC swapped observations', p => {
    const left = p[3]!.commands[2]!, right = p[4]!.commands[2]!;
    [left.observation, right.observation] = [right.observation, left.observation];
    const plan = expected.packageStreams['provider-access'][0]!;
    assert.equal(commandExit(left, 1, undefined, [{executable:process.execPath, argv:plan.argv, cwd:join(root, packageRoots['provider-access']), files:plan.files.map(file => join(root, packageRoots['provider-access'], file))}]), 1);
  });
  await reject('ER first stream replaces second', p => {
    const observation = p[6]!.commands[2]!.observation;
    const first = observation.events.filter(e => String(e.suite).endsWith('/tests/example.test.ts')); assert.ok(first.length);
    observation.events = [...first, ...structuredClone(first)]; observation.summaries[1] = structuredClone(observation.summaries[0]!);
    assert.equal(commandExit(p[6]!.commands[2]!, 2), 1);
  });
  await reject('ER duplicate process envelope', p => {
    const observation = p[6]!.commands[2]!.observation; observation.streams[1] = structuredClone(observation.streams[0]!);
    assert.equal(commandExit(p[6]!.commands[2]!, 2), 1);
  });
  await reject('missing matrix report', p => p.pop());
  await reject('duplicate package report', p => { p[7] = p[6]!; });
  await reject('wrong revision', p => { p[0]!.sourceSha = 'd'.repeat(40); });
  await reject('wrong head tree', p => { p[0]!.sourceTree = 'd'.repeat(40); });
  await reject('empty events', p => { p[0]!.commands[2]!.observation.events = []; });
  await reject('failed process', p => { p[0]!.commands[2]!.exitCode = 1; });
  await reject('missing build prerequisite', p => { p[0]!.commands = [p[0]!.commands[0]!, p[0]!.commands[2]!]; });
  await reject('failed prerequisite', p => { p[0]!.commands[0]!.exitCode = 2; });
  await reject('wrong platform', p => { Object.assign(p[0]!, { platform: 'darwin' }); });
  await reject('wrong package identity', p => { p[0]!.packageName = '@agent-teams/embedded-runtime'; });
  await reject('runner script drift', p => { p[3]!.runnerHash = '0'.repeat(64); });
  await reject('increased concurrency', p => { p[0]!.commands[2]!.argv = ['--test', '--test-concurrency=2', ...p[0]!.selection!.files]; });
  await reject('omitted universe file', p => { p[0]!.selection!.universe = expected.universe.slice(1); });
  await reject('overlapping partitions', p => { p[1]!.selection!.files = p[0]!.selection!.files; });
  await reject('wrong partition count', p => { Object.assign(p[1]!.selection!, { partitionCount: 2 }); });
  await reject('wrong universe hash', p => { p[0]!.selection!.universeHash = '0'.repeat(64); });
  await reject('missing file event', p => { p[0]!.commands[2]!.observation.events = p[0]!.commands[2]!.observation.events.slice(1); });
  await reject('failed test event', p => { p[0]!.commands[2]!.observation.events = [{ ...p[0]!.commands[2]!.observation.events[0]!, status: 'failed' }]; });
  await reject('input omitted', p => { delete p[0]!.sourceBefore[Object.keys(expected.inputs)[0]!]; });
  await reject('input changed during execution', p => { p[7]!.sourceAfter['package.json'] = '0'.repeat(64); });
  await reject('dropped file completion', p => { p[0]!.commands[2]!.observation.completedFiles.pop(); });
  await reject('duplicate file completion', p => { p[0]!.commands[2]!.observation.completedFiles.push(p[0]!.commands[2]!.observation.completedFiles[0]!); });
  await reject('dropped process summary', p => { p[0]!.commands[2]!.observation.summaries.pop(); });
  await reject('dropped deliberate skipped event', p => { p[0]!.commands[2]!.observation.events = p[0]!.commands[2]!.observation.events.filter(event => event.status !== 'skipped'); });
  await reject('missing second ER process summary', p => { p[6]!.commands[2]!.observation.summaries.pop(); });
  await reject('failed process summary', p => { p[0]!.commands[2]!.observation.summaries[0]!.failed = 1; });
  await reject('process error', p => { p[0]!.commands[2]!.error = 'actual producer error'; });
  await reject('process signal', p => { p[0]!.commands[2]!.signal = 'SIGTERM'; });
  await reject('extra shard', p => { p.push(p[0]!); });
  await reject('missing native report', (_, r) => r.pop());
  await reject('duplicate phase report', (_, r) => { r[2] = r[1]!; });
  await reject('dropped root test phase', (_, r) => { r[0]!.phases!.pop(); });
  await reject('nonzero native phase', (_, r) => { r[2]!.phases![0]!.code = 1; });
  await reject('empty native execution', (_, r) => { r[2]!.phases![0]!.tests = []; });
  await reject('measure digest drift', (_, r) => { r[0]!.digests['package.json'] = '0'.repeat(64); });
  await reject('old-full inventory drift', (_, r) => { r[0]!.inventory = []; });
  await t.test('partial retry retains same-SHA successful siblings and replaces only the retried current slot', async () => {
    // Files model same-run artifact storage, not historical hosted execution.
    // Every package command proof comes from a real disposable fixture process.
    const current = join(root, 'same-run-current'); await mkdir(current);
    for (const receipt of packages) {
      const directory = join(current, `full-ci-product-package-${receipt.requestedShard}-current`);
      await mkdir(directory); await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt));
    }
    const siblingPath = join(current, 'full-ci-product-package-provider-access-current', 'receipt.json');
    const siblingBefore = await readFile(siblingPath);
    const retried = (await packageReports(root, expected, ['agent-execution-1']))[0]!;
    assert.notEqual(retried.commands[2]!.pid, packages[0]!.commands[2]!.pid);
    await writeFile(join(current, 'full-ci-product-package-agent-execution-1-current', 'receipt.json'), JSON.stringify(retried));
    assert.deepEqual(await readFile(siblingPath), siblingBefore);
    const loaded = await reports(current);
    assert.equal(loaded.length, 8);
    assertJobResults({ packages: { result: 'success' }, root: { result: 'success' } });
    assertFanoutEvidence(expected, loaded, phases);

    const failed = await runCommand(process.execPath, ['--eval', 'process.exit(1)'], root, process.env, join(root, 'failed-retry'));
    assert.equal(failed.exitCode, 1);
    for (const job of ['packages', 'root']) {
      // Even a complete valid old current set cannot bypass live needs at the
      // actual aggregate CLI boundary; it rejects before reading evidence.
      const needs = { packages: { result: 'success' }, root: { result: 'success' }, [job]: { result: 'failure' } };
      const result = spawnSync(process.execPath, [new URL('./product-fanout-contract.ts', import.meta.url).pathname, 'evidence'], {
        encoding: 'utf8', env: { ...process.env, NEEDS: JSON.stringify(needs), CI_PACKAGE_REPORT_DIR: current, CI_ROOT_REPORT_DIR: current },
      });
      assert.equal(result.status, 1); assert.match(result.stderr, new RegExp(`${job} incomplete`, 'u'));
      assert.equal((await reports(current)).length, 8);
    }
  });
});
test('source oracle rejects ignored inputs, runner drift, and missing literal AE pattern', async t => {
  for (const fault of ['ignored', 'runner', 'literal', 'root-script']) {
    await t.test(fault, async subtest => {
      const { root, tracked } = await fixture(); subtest.after(() => rm(root, { recursive: true, force: true }));
      if (fault === 'ignored') { await writeFile(join(root, packageRoots['agent-execution'], 'tests/package/ignored.test.ts'), '// ignored by Git'); }
      if (fault === 'runner') {
        await writeFile(join(root, packageRoots['agent-execution'], 'package.json'), JSON.stringify({ name: '@agent-teams/agent-execution', scripts: { test: 'node --test tests/package/*.test.ts' } }));
      }
      if (fault === 'literal') {
        const path = `${packageRoots['agent-execution']}/${aePatterns[2]}`;
        await rm(join(root, path)); tracked.splice(tracked.indexOf(path), 1);
      }
      if (fault === 'root-script') { await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { ...scripts, test: 'node --test dropped.test.ts' } })); }
      await assert.rejects(readProductSource(root, tracked));
    });
  }
});
}
export function registerProductSourceCustodyTests(): void {
test('physical root custody rejects Git-ignored test/type/native/config helpers and symlink ancestry', async t => {
  for (const path of ['experiments/runtime-profile-behavior/test/extra.test.ts',
    'experiments/runtime-profile-behavior/src/extra.ts', 'experiments/rust-system-boundaries/client/extra.ts',
    'scripts/native-helper/extra.mjs', 'scripts/foundation/extra.mjs', 'architecture/foundation/extra.yaml',
    'tsconfig.extra.json', '.oxlintrc.extra.json']) {
    await t.test(path, async sub => {
      const {root, tracked} = await fixture(); sub.after(() => rm(root, {recursive:true, force:true}));
      execFileSync('git', ['init', '--quiet', root]);
      await writeFile(join(root, '.git/info/exclude'), `${path}\n`);
      await mkdir(join(root, path, '..'), {recursive:true});
      await writeFile(join(root, path), "import test from 'node:test'; test('ignored actual source', () => {});\n");
      assert.equal(execFileSync('git', ['check-ignore', path], {cwd:root, encoding:'utf8'}).trim(), path);
      if (path.endsWith('.test.ts')) {
        const env = {...process.env}; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
        const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path], {cwd:root, encoding:'utf8', env});
        assert.equal(result.status, 0); assert.match(result.stdout, /ignored actual source/u);
      }
      await assert.rejects(readProductSource(root, tracked), /untracked\/ignored/u);
      const external = await mkdtemp(join(tmpdir(), 'external-source-TEST-')); sub.after(() => rm(external, {recursive:true,force:true}));
      const target = join(external, 'target.ts'); await writeFile(target, '// TEST');
      await rm(join(root, path)); await symlink(target, join(root, path));
      await assert.rejects(readProductSource(root, tracked), /symlink|unsupported/u);
    });
  }
  await t.test('deliberate generated dependency/build exclusions preserve custody', async sub => {
    const {root, tracked, expected} = await fixture(); sub.after(() => rm(root, {recursive:true,force:true}));
    for (const path of [`${packageRoots['agent-execution']}/dist/generated.ts`, `${packageRoots['provider-access']}/.cache/output.json`,
      `${packageRoots['embedded-runtime']}/node_modules/installed.ts`, 'experiments/rust-system-boundaries/target/generated.rs']) {
      await mkdir(join(root, path, '..'), {recursive:true}); await writeFile(join(root, path), '// generated TEST');
    }
    assert.deepEqual((await readProductSource(root, tracked)).inputs, expected.inputs);
  });
  await t.test('tracked directory replaced by an external ancestry symlink', async sub => {
    const {root, tracked} = await fixture(); sub.after(() => rm(root, {recursive:true, force:true}));
    const base = join(root, 'scripts/ci'), moved = join(root, 'external-ci');
    await import('node:fs/promises').then(fs => fs.rename(base, moved)); await symlink(moved, base);
    await assert.rejects(readProductSource(root, tracked), /symlink/u);
  });
});
}
export function registerProductWorkflowTests(): void {
test('matrix and root failures, cancellation, skip or missing needs fail closed', () => {
  assertJobResults({ packages: { result: 'success' }, root: { result: 'success' } });
  for (const job of ['packages', 'root']) {
    for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
      assert.throws(() => assertJobResults({ packages: { result: 'success' }, root: { result: 'success' }, [job]: { result } }));
    }
  }
  assert.throws(() => assertJobResults({ root: { result: 'success' } }));
});
test('parsed full-product workflow rejects matrix/phase/permissions/action drift', async t => {
  const workflow = parse(await readFile(new URL('../../.github/workflows/ci-product.yml', import.meta.url), 'utf8'));
  assertProductWorkflow(workflow);
  const cases: Record<string, (value: typeof workflow) => void> = {
    'matrix omission': w => w.jobs.packages.strategy.matrix.shard.pop(),
    'dynamic matrix': w => { w.jobs.packages.strategy.matrix = '${{ fromJSON(inputs.matrix) }}'; },
    'matrix fail-fast': w => { w.jobs.packages.strategy['fail-fast'] = true; },
    'conditional whole lane': w => { w.jobs.packages.if = "github.event_name == 'push'"; },
    'native phase dropped': w => { w.jobs.root.steps = w.jobs.root.steps.filter((s: { run?: string }) => s.run !== 'node scripts/ci/measure.ts check:ci:product:native'); },
    'conditional root test': w => { w.jobs.root.steps.find((s: { run?: string }) => s.run === 'node scripts/ci/measure.ts check:ci:product:root').if = 'false'; },
    'credential persistence': w => { w.jobs.root.steps[0].with['persist-credentials'] = true; },
    'wrong download pin': w => { w.jobs.aggregate.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/download-artifact')).uses = 'actions/download-artifact@main'; },
    'shell interpolation': w => { w.jobs.root.steps[1].run += 'echo ${{ inputs.revision }}\n'; },
    'aggregate no always': w => { delete w.jobs.aggregate.if; },
    'continue on error': w => { w.jobs.root['continue-on-error'] = true; },
    'retained C0 history dropped': w => { w.jobs.root.steps.splice(2, 1); },
    'test Git owner drift': w => { w.jobs.root.env.GIT_AUTHOR_NAME = 'wrong'; },
    'invalid job-level runner context': w => { w.jobs.root.env.CI_EVIDENCE_DIR = '${{ runner.temp }}/ci-product-root'; },
    'download path drift': w => { w.jobs.aggregate.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/download-artifact')).with.path = 'local'; },
    'package current-attempt-only download': w => { w.jobs.aggregate.steps.find((s: { with?: { pattern?: string } }) => s.with?.pattern).with.pattern = 'full-ci-${{ inputs.artifact }}-package-*-${{ github.run_attempt }}'; },
    'root current-attempt-only download': w => { w.jobs.aggregate.steps.find((s: { with?: { name?: string } }) => s.with?.name).with.name = 'full-ci-${{ inputs.artifact }}-root-${{ github.run_attempt }}'; },
    'root current slot always': w => { w.jobs.root.steps.at(-1).if = '${{ always() }}'; },
    'root current slot overwrite false': w => { w.jobs.root.steps.at(-1).with.overwrite = false; },
    'root current slot missing overwrite': w => { delete w.jobs.root.steps.at(-1).with.overwrite; },
    'root attempt archive missing': w => { w.jobs.root.steps.splice(-2, 1); },
    'root attempt archive success-only': w => { w.jobs.root.steps.at(-2).if = '${{ success() }}'; },
    'root attempt archive overwritten': w => { w.jobs.root.steps.at(-2).with.overwrite = true; },
    'root attempt archive retention weakened': w => { w.jobs.root.steps.at(-2).with['retention-days'] = 1; },
    'root current identity weakened': w => { w.jobs.root.steps.at(-1).with.name = 'full-ci-${{ inputs.artifact }}-current'; },
    'root dependency missing': w => { w.jobs.aggregate.needs = ['packages']; },
    'current needs binding weakened': w => { w.jobs.aggregate.env.NEEDS = '{"packages":{"result":"success"},"root":{"result":"success"}}'; },
    'live result check missing': w => { w.jobs.aggregate.steps = w.jobs.aggregate.steps.filter((s: { run?: string }) => s.run !== 'node scripts/ci/product-fanout-contract.ts results'); },
    'live result check bypassed': w => { w.jobs.aggregate.steps.find((s: { run?: string }) => s.run === 'node scripts/ci/product-fanout-contract.ts results').run += ' || true'; },
    'exact revision binding weakened': w => { w.jobs.aggregate.env.EXPECTED_REVISION = '${{ github.sha }}'; },
    'complete evidence gate missing': w => { w.jobs.aggregate.steps.pop(); },
  };
  for (const [name, fault] of Object.entries(cases)) { await t.test(name, () => { const bad = structuredClone(workflow); fault(bad); assert.throws(() => assertProductWorkflow(bad)); }); }
  for (const index of [0, 1]) {
    for (const [key, value] of Object.entries({ 'run-id': '${{ github.run_id }}', repository: '${{ github.repository }}',
      'github-token': '${{ github.token }}', 'artifact-ids': '123' })) {
      await t.test(`same-run download ${index} rejects ${key} override`, () => {
        const bad = structuredClone(workflow);
        bad.jobs.aggregate.steps.filter((s: { uses?: string }) => s.uses?.startsWith('actions/download-artifact'))[index].with[key] = value;
        assert.throws(() => assertProductWorkflow(bad));
      });
    }
  }
});

test('parsed shard refuses skipped execution, weakened custody and incomplete evidence upload', async t => {
  const workflow = parse(await readFile(new URL('../../.github/workflows/ci-product-shard.yml', import.meta.url), 'utf8'));
  assertShardWorkflow(workflow);
  const mutations: Array<(w: typeof workflow) => void> = [
    w => { w.jobs.shard.if = 'false'; },
    w => { w.permissions.contents = 'write'; },
    w => { w.jobs.shard.env.PACKAGE_SHARD = '${{ inputs.package }}'; },
    w => { w.jobs.shard.env.CI_EVIDENCE_DIR = '${{ runner.temp }}/ci-product-shard'; },
    w => { w.jobs.shard.steps[0].with['fetch-depth'] = 1; },
    w => { w.jobs.shard.steps.splice(2, 1); },
    w => { w.jobs.shard.steps.find((s: {run?: string}) => s.run === 'node scripts/ci/package-execution.ts').if = 'false'; },
    w => { w.jobs.shard.steps.at(-1).with.path = '${{ runner.temp }}/ci-product-shard/*.log'; },
    w => { w.jobs.shard.steps.at(-1).with['if-no-files-found'] = 'ignore'; },
    w => { w.jobs.shard.steps.at(-1).with['retention-days'] = 1; },
    w => { w.jobs.shard.steps[1].run += 'echo ${{ inputs.shard }}'; },
    w => { w.jobs.shard.steps.at(-1).if = '${{ always() }}'; },
    w => { w.jobs.shard.steps.at(-1).with.overwrite = false; },
    w => { delete w.jobs.shard.steps.at(-1).with.overwrite; },
    w => { w.jobs.shard.steps.splice(-2, 1); },
    w => { w.jobs.shard.steps.at(-2).if = '${{ success() }}'; },
    w => { w.jobs.shard.steps.at(-2).with.overwrite = true; },
    w => { w.jobs.shard.steps.at(-2).with['retention-days'] = 1; },
    w => { w.jobs.shard.steps.at(-1).with.name = 'full-ci-${{ inputs.artifact }}-package-current'; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    await t.test(`custody mutation ${i}`, () => { const changed = structuredClone(workflow); mutate(changed); assert.throws(() => assertShardWorkflow(changed)); });
  }
});
test('separate receipt.json artifacts preserve duplicates and ignore raw diagnostic logs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-receipts-TEST-')); t.after(() => rm(root, {recursive:true,force:true}));
  for (const dir of ['shard-one', 'shard-two']) {
    await mkdir(join(root, dir)); await writeFile(join(root, dir, 'receipt.json'), JSON.stringify({requestedShard:'agent-execution-1'}));
    await writeFile(join(root, dir, 'command-2.stdout'), 'not JSON and never execution evidence');
  }
  const loaded = await reports(root); assert.equal(loaded.length, 2); assert.deepEqual(loaded[0], loaded[1]);
  const expected = {sha:'a'.repeat(40), inputTree:'b'.repeat(40), inputs:{'actual-source.ts':'c'.repeat(64)}};
  const proof = {kind:'root-custody', sourceSha:expected.sha, sourceTree:expected.inputTree, before:expected.inputs, after:expected.inputs};
  assertRootCustody(proof, expected);
  assert.throws(() => assertRootCustody({...proof, after:null}, expected));
  assert.throws(() => assertRootCustody({...proof, after:{}}, expected));
});

}
