import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { commandExit, embeddedObserverEnv, enumerateExecutionFiles, executionSelection, observeLine, packages,
  packageStreamPlans, partitionExecutionFiles, runCommand, selectShard, shardIds, validateInventory, validatePlatform } from './package-execution.ts';
import { observeEmbeddedProcesses, captureStream } from './er-process-observer.ts';
import type { Observation } from './package-execution.ts';
import { assertObservedStreams } from './product-test-observation.ts';
import type { ExpectedEvidence } from './product-fanout-contract.ts';

const reporter = resolve('scripts/ci/package-execution.ts');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ae-partition-TEST-'));
  const packageRoot = join(root, packages[0].root);
  const paths = ['tests/features/runtime-installation-discovery/a.test.ts',
    'tests/features/runtime-installation-discovery/b.test.ts',
    'tests/features/contained-agent-turn/a.test.ts', 'tests/features/contained-agent-turn/b.test.ts',
    'tests/features/contained-agent-turn/c.test.ts',
    'tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs',
    'tests/package/a.test.ts', 'tests/package/b.test.ts'];
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: packages[0].test } }));
  for (const [index, path] of paths.entries()) {
    await mkdir(join(packageRoot, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
    // Each file proves isolation: a process-global mutation cannot leak to another file.
    await writeFile(join(packageRoot, path), `import assert from 'node:assert/strict';\nimport {test, describe} from 'node:test';\ntest('identity-${index}', () => { assert.equal(process.env.FIXTURE_OWNER, undefined); process.env.FIXTURE_OWNER = '${index}'; });\n`
      + (index === 0 ? "test('skipped-identity', {skip: 'TEST skip preserved'}, () => {});\nfor (const name of ['repeat', 'repeat']) { test(name, () => {}); }\n" : '')
      + (index === 1 ? "describe('suite-identity', () => { test('nested-identity', () => {}); });\n" : ''));
  }
  return { root, packageRoot, paths: paths.toSorted() };
}

const identities = (events: Record<string, unknown>[]) => events.map(e => JSON.stringify([e.file, e.line, e.column, e.name, e.nesting, e.kind, e.status])).toSorted();

async function embeddedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'er-observer-TEST-'));
  const base = 'packages/apps/embedded-runtime', cwd = join(root, base);
  await mkdir(join(cwd, 'scripts'), { recursive: true });
  for (const name of ['run-package-tests.mjs', 'adoption-test-reporter.mjs']) {
    await writeFile(join(cwd, 'scripts', name), await readFile(join(base, 'scripts', name)));
  }
  const plans = await packageStreamPlans(root, selectShard('embedded-runtime'), null);
  const sourceFiles = plans.flatMap(plan => plan.files);
  for (const file of sourceFiles) {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, "import test from 'node:test'; test('disposable original argv entry', () => {});\n");
  }
  const helper = join(cwd, 'tests/package/support/observer-registration.ts');
  await mkdir(join(helper, '..'), { recursive: true }); sourceFiles.push(helper);
  await writeFile(helper, "import { test, describe } from 'node:test'; describe('helper ancestry', () => { for (const name of ['repeat', 'repeat']) { test(name, () => {}); } test('skip', {skip:'TEST skip'}, () => {}); });\n");
  const nested = join(cwd, 'tests/package/support/observer-child.test.ts'); sourceFiles.push(nested);
  await writeFile(nested, "import test from 'node:test'; test('nested child', () => {});\n");
  await writeFile(join(cwd, 'tests/package/live/run-linux-codex-live-canary.test.mjs'),
    "import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; import test from 'node:test';\n"
    + "import '../support/observer-registration.ts';\n"
    + "test('nested bare Node test retains original default reporter semantics', () => { const env = {...process.env}; delete env.NODE_TEST_CONTEXT; const result = spawnSync(process.execPath, ['--test', 'tests/package/support/observer-child.test.ts'], {env, encoding:'utf8'}); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); assert.match(result.stdout, /nested child/); assert.doesNotMatch(result.stdout, /PACKAGE_|\\\"kind\\\"/); });\n");
  await writeFile(join(cwd, 'tests/package/node-docker-route-provenance-integration.test.ts'),
    "import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; import test from 'node:test';\n"
    + "test('different nested reporter and ordinary Node preserve exact output', () => { const env = {...process.env}; delete env.NODE_TEST_CONTEXT; const dot = spawnSync(process.execPath, ['--test', '--test-reporter=dot', 'tests/package/support/observer-child.test.ts'], {env, encoding:'utf8'}); assert.ifError(dot.error); assert.equal(dot.status, 0, dot.stderr); assert.equal(dot.stdout, '.\\n'); assert.equal(dot.stderr, ''); const ordinary = spawnSync(process.execPath, ['-e', 'process.stdout.write(\\\"ordinary TEST child\\\")'], {env, encoding:'utf8'}); assert.equal(ordinary.status, 0); assert.equal(ordinary.stdout, 'ordinary TEST child'); assert.equal(ordinary.stderr, ''); });\n");
  return { root, base, cwd, plans, sourceFiles };
}

function registerEmbeddedCaptureTests(): void {
test('ER inherited two destinations break a nested one-reporter Node test; bounded spawn capture and OS corroboration preserve original children and two streams', async t => {
  // Old regression: a real nested --test inherits two destinations and only
  // package-execution's reporter. New code must preserve its original output.
  const f = await embeddedFixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const oldCapture = join(f.root, 'old-capture'); await mkdir(oldCapture);
  const oldEnv = { ...env, AE_ADOPTION_CAPTURE_DIR: oldCapture, CI_ER_PROCESS_OBSERVER: '1',
    NODE_OPTIONS: `--test-reporter=${process.env.CI_ER_BASELINE_REPORTER ?? reporter} --test-reporter-destination=stderr --test-reporter-destination=stdout` };
  const oldNested = spawnSync(process.execPath, ['--test', 'tests/package/support/observer-child.test.ts'], { cwd: f.cwd, env: oldEnv, encoding: 'utf8' });
  assert.ifError(oldNested.error); assert.notEqual(oldNested.status, 0); assert.equal(oldNested.stdout, '');
  assert.match(oldNested.stderr, /ERR_INVALID_ARG_VALUE.*|must match the number of specified '--test-reporter-destination'/u);
  const old = await runCommand(process.execPath, ['scripts/run-package-tests.mjs'], f.cwd, oldEnv, join(f.root, 'old'));
  assert.notEqual(old.exitCode, 0); assert.match(await readFile(join(oldCapture, 'process-0.stdout'), 'utf8'), /"kind":"failure"/u);
  const capture = join(f.root, 'new-capture'); await mkdir(capture);
  const observedEnv = embeddedObserverEnv(env, capture, f.plans);
  assert.equal(observedEnv.NODE_OPTIONS, undefined);
  const green = await runCommand(process.execPath, ['scripts/run-package-tests.mjs'], f.cwd, observedEnv, join(f.root, 'new'));
  assert.equal(green.error, null); assert.equal(commandExit(green, 2, undefined, f.plans, f.sourceFiles), 0);
  assert.equal(new Set(green.observation.streams.map(stream => stream.node.pid)).size, 2);
  assert.deepEqual(green.observation.events.filter(e => e.title === 'repeat').map(e => e.ordinal), [1, 2]);
  assert.ok(green.observation.events.some(e => e.status === 'skipped' && e.skipReason === 'TEST skip'));
  assert.ok(green.observation.events.some(e => e.title === 'repeat' && Array.isArray(e.ancestry) && e.ancestry.length === 1));
  for (const stream of green.observation.streams) {
    assert.equal(stream.stderr, '', 'no worker/child observation markers');
    assert.ok(stream.identity); assert.doesNotMatch(stream.stdout, /PACKAGE_NODE_/u);
  }
  const expected = { nodeExecutable: process.execPath, inputs: Object.fromEntries(f.sourceFiles.map(file => [file.slice(f.root.length + 1), 'TEST'])),
    packageStreams: { 'embedded-runtime': f.plans.map(plan => ({ argv: plan.argv, files: plan.files.map(file => file.slice(f.cwd.length + 1)) })) } } as ExpectedEvidence;
  const context = { id: 'embedded-runtime' as const, index: 6, selected: [], root: f.root, packageRoot: f.base };
  assertObservedStreams(expected, { ...green }, context);
  for (const ancestors of [[0, green.pid], [-5, green.pid], ['not-a-PID', green.pid], [green.pid, green.pid],
    [green.observation.streams[0]!.node.pid, green.pid], [1.5, green.pid], [Number.MAX_SAFE_INTEGER + 1, green.pid],
    [null, green.pid], [...Array.from({length: 16}, (_, i) => 1_000_000 + i), green.pid]]) {
    const corrupted = structuredClone(green), stream = corrupted.observation.streams[0]!;
    stream.identity = JSON.stringify({ ...JSON.parse(stream.identity!), osObserved: true, ancestors });
    assert.equal(commandExit(corrupted, 2, undefined, f.plans, f.sourceFiles), 1, 'impossible raw OS ancestry must reject');
    assert.throws(() => assertObservedStreams(expected, { ...corrupted }, context));
  }
  const executions = [green];
  for (let attempt = 1; attempt < 3; attempt++) {
    const nextCapture = join(f.root, `capture-${attempt}`); await mkdir(nextCapture);
    const next = await runCommand(process.execPath, ['scripts/run-package-tests.mjs'], f.cwd,
      embeddedObserverEnv(env, nextCapture, f.plans), join(f.root, `fresh-${attempt}`));
    assert.equal(commandExit(next, 2, undefined, f.plans, f.sourceFiles), 0);
    assertObservedStreams(expected, {...next}, context);
    assert.equal(new Set(next.observation.streams.map(stream => stream.node.pid)).size, 2);
    for (const stream of next.observation.streams) {
      assert.equal(stream.node.pid, stream.original!.actualPid);
      assert.equal(stream.original!.runnerPid, next.pid, 'direct original runner PID');
    }
    executions.push(next);
  }
  for (const key of ['actualPid', 'runnerPid', 'actualExecutable', 'actualCwd']) {
    const corrupted = structuredClone(green); corrupted.observation.streams[1]!.original![key] = null;
    assert.equal(commandExit(corrupted, 2, undefined, f.plans, f.sourceFiles), 1);
    assert.throws(() => assertObservedStreams(expected, {...corrupted}, context));
  }
  const portable = structuredClone(green);
  for (const stream of portable.observation.streams) {
    stream.identity = JSON.stringify({...JSON.parse(stream.identity!), osObserved: false, ancestors: null});
  }
  assert.equal(commandExit(portable, 2, undefined, f.plans, f.sourceFiles), 0);
  assertObservedStreams(expected, {...portable}, context); // Capture decoder only; no Darwin execution claim.
  const missedCapture = join(f.root, 'post-exit-capture'); await mkdir(missedCapture);
  const missed = await runCommand(process.execPath, ['scripts/run-package-tests.mjs'], f.cwd,
    {...env, AE_ADOPTION_CAPTURE_DIR: missedCapture}, join(f.root, 'no-live-observer'));
  assert.equal(missed.exitCode, 0);
  assert.match(missed.error!, /ENOENT.*process-0.identity.json/);
  assert.equal(commandExit(missed, 2, undefined, f.plans, f.sourceFiles), 1, 'old missing-observation decode rejects actual successful commands');
  // Begin observation after the actual command has exited: no live procfs child
  // can be claimed. Actual spawn returns still cover the very short second stream.
  await observeEmbeddedProcesses(f.plans, missedCapture, missed.pid!)();
  const records = JSON.parse(await readFile(join(missedCapture, 'processes.json'), 'utf8')) as Record<string, unknown>[];
  const repaired = {...missed, error: null, observation: {summaries: [], events: [], completedFiles: [], streams: []} as Observation};
  for (const [index, original] of records.entries()) {
    const observed = captureStream(await readFile(join(missedCapture, `process-${index}.stdout`), 'utf8'),
      await readFile(join(missedCapture, `process-${index}.stderr`), 'utf8'), index, original,
      {rawIdentity: await readFile(join(missedCapture, `process-${index}.identity.json`), 'utf8'), observeLine,
        summary: () => {throw new Error('original ER cannot contain injected Node reporter records');}});
    repaired.observation.events.push(...observed.events); repaired.observation.summaries.push(...observed.summaries);
    repaired.observation.completedFiles.push(...observed.completedFiles); repaired.observation.streams.push(...observed.streams);
    assert.equal(JSON.parse(observed.streams[0]!.identity!).osObserved, false);
  }
  assert.equal(commandExit(repaired, 2, undefined, f.plans, f.sourceFiles), 0);
  assertObservedStreams(expected, {...repaired}, context);
  for (const mutate of [
    (proof: typeof repaired) => {
      proof.pid = proof.observation.streams[0]!.node.pid;
      for (const stream of proof.observation.streams) {
        stream.identity = JSON.stringify({...JSON.parse(stream.identity!), commandPid: proof.pid});
      }
    },
    (proof: typeof repaired) => {
      const stream = proof.observation.streams[1]!;
      stream.original!.runnerPid = 1_234_567;
      stream.identity = JSON.stringify({...JSON.parse(stream.identity!), runnerPid: 1_234_567});
    },
  ]) {
    const corrupted = structuredClone(repaired); mutate(corrupted);
    assert.equal(commandExit(corrupted, 2, undefined, f.plans, f.sourceFiles), 1, 'impossible capture PID relationship rejects');
    assert.throws(() => assertObservedStreams(expected, {...corrupted}, context));
  }
  const duplicate = structuredClone(green); duplicate.observation.streams[1] = structuredClone(duplicate.observation.streams[0]!);
  assert.equal(commandExit(duplicate, 2, undefined, f.plans, f.sourceFiles), 1);
  assert.throws(() => assertObservedStreams(expected, { ...duplicate }, context));
  const missing = structuredClone(green); missing.observation.streams[0]!.identity = null;
  assert.equal(commandExit(missing, 2, undefined, f.plans, f.sourceFiles), 1);
  assert.throws(() => assertObservedStreams(expected, { ...missing }, context));
  if (process.env.CI_FOCUSED_EVIDENCE_DIR) { await writeFile(join(process.env.CI_FOCUSED_EVIDENCE_DIR, 'er-red-green.json'), JSON.stringify({
    scope: 'original ER runner/reporter/argv, disposable typed TEST entries and real nested Node children', old, oldNested, green, executions, missed, repaired, portableDecoderOnly: portable, plans: f.plans,
  }, null, 2) + '\n'); }
});

}
export function registerPackageExecutionTests(): void {
  registerEmbeddedCaptureTests();

test('original four patterns include the literal mjs, exclude nested/helpers/dotfiles, and repartition additions', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.packageRoot, 'tests/package/.hidden.test.ts'), '');
  await writeFile(join(f.packageRoot, 'tests/package/helper.ts'), '');
  await mkdir(join(f.packageRoot, 'tests/package/nested'));
  await writeFile(join(f.packageRoot, 'tests/package/nested/ignored.test.ts'), '');
  assert.deepEqual(await enumerateExecutionFiles(f.root), f.paths);
  const before = await executionSelection(f.root, selectShard('agent-execution-1'));
  await assert.rejects(executionSelection(f.root, { ...selectShard('agent-execution-1'), partitionCount: 1 }), /shard contract/);
  const added = 'tests/features/contained-agent-turn/new-test.test.ts';
  await writeFile(join(f.packageRoot, added), '');
  const after = await executionSelection(f.root, selectShard('agent-execution-1'));
  assert.ok(before && after); assert.notEqual(before.universeHash, after.universeHash);
  const partitions = await Promise.all([1, 2, 3].map(n => executionSelection(f.root, selectShard(`agent-execution-${n}`))));
  const union = partitions.flatMap(p => { assert.ok(p); return p.files; });
  assert.equal(new Set(union).size, union.length); assert.deepEqual(union.toSorted(), [...f.paths, added].toSorted());
  assert.equal(partitions.filter(p => p?.files.includes('tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs')).length, 1);
});

test('empty pattern, runner option drift, symlink input and unsupported matched filename fail closed', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const manifest = join(f.packageRoot, 'package.json'), original = await readFile(manifest);
  await writeFile(manifest, JSON.stringify({ scripts: { test: packages[0].test.replace('concurrency=1', 'concurrency=2') } }));
  await assert.rejects(enumerateExecutionFiles(f.root), /runner drift/); await writeFile(manifest, original);
  const literal = join(f.packageRoot, 'tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs');
  const bytes = await readFile(literal); await rm(literal);
  await assert.rejects(enumerateExecutionFiles(f.root), /unmatched original/); await writeFile(literal, bytes);
  const link = join(f.packageRoot, 'tests/package/link.test.ts'); await symlink(literal, link);
  await assert.rejects(enumerateExecutionFiles(f.root), /regular file/); await rm(link);
  await writeFile(join(f.packageRoot, 'tests/package/unreviewed name.test.ts'), '');
  await assert.rejects(enumerateExecutionFiles(f.root), /unsupported test path/);
});

test('eight literal shards and Linux platform contract reject unknown, array, whole-AE and unsupported runners', () => {
  assert.equal(shardIds.length, 8);
  assert.deepEqual(shardIds.slice(0, 3).map(id => selectShard(id).partitionIndex), [0, 1, 2]);
  for (const bad of [undefined, [], 'agent-execution', 'agent-execution-4', '@agent-teams/agent-execution', 'provider-access runtime-security'])
    { assert.throws(() => selectShard(bad)); }
  assert.throws(() => partitionExecutionFiles(['c', 'a', 'b'], 0), /ordering/);
  assert.throws(() => partitionExecutionFiles(['a', 'a', 'b'], 0), /duplicate/);
  assert.throws(() => partitionExecutionFiles(['a', 'b'], 0), /empty/);
  assert.throws(() => partitionExecutionFiles(['a', 'b', 'c'], 3), /index/);
  validatePlatform('linux', 'x64', 'Linux', 'X64');
  assert.throws(() => validatePlatform('darwin', 'arm64', 'macOS', 'ARM64'));
  assert.throws(() => validatePlatform('linux', 'x64', 'macOS', 'X64'));
});

test('source inventory rejects missing sixth build, added package, test change and lifecycle hook', () => {
  const clean = `node -e "const fs=require('node:fs'); for (const path of ['dist','.cache']) fs.rmSync(path, { recursive: true, force: true })"`;
  const entries = packages.map(p => ({ root: p.root, manifest: { name: p.name, scripts: { clean, build: p.build, test: p.test } } }));
  const root = { scripts: { 'product:build': "pnpm --filter './packages/**' -r run build" } };
  validateInventory(entries, root);
  assert.throws(() => validateInventory(entries.slice(1), root));
  assert.throws(() => validateInventory([...entries, { root: 'packages/contexts/new', manifest: {} }], root));
  const changed = structuredClone(entries); changed[0]!.manifest.scripts.test += ' --test-name-pattern=canary';
  assert.throws(() => validateInventory(changed, root), /test script/);
  const hook = structuredClone(entries); Object.assign(hook[0]!.manifest.scripts, { pretest: 'echo skipped' });
  assert.throws(() => validateInventory(hook, root), /lifecycle hook/);
});

test('actual Node full run and three partitions preserve file completion, identities/statuses and process isolation', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const universe = await enumerateExecutionFiles(f.root);
  const selection = await executionSelection(f.root, selectShard('agent-execution-1')); assert.ok(selection);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const run = (paths: string[], label: string, withReporter = true) => runCommand(process.execPath,
    ['--test', '--test-concurrency=1', ...(withReporter ? [`--test-reporter=${reporter}`] : []), ...paths],
    f.packageRoot, env, join(f.root, label));
  const full = await run(selection.fullArgv.slice(2), 'full');
  assert.equal(commandExit(full, 1, universe.map(p => join(f.packageRoot, p))), 0);
  const shards = [];
  for (let index = 0; index < 3; index++) {
    const paths = partitionExecutionFiles(universe, index);
    const result = await run(paths, `shard-${index}`);
    assert.equal(commandExit(result, 1, paths.map(p => join(f.packageRoot, p))), 0); shards.push(result);
  }
  assert.deepEqual(identities(shards.flatMap(s => s.observation.events)), identities(full.observation.events));
  const silent = await run(universe, 'silent', false);
  assert.equal(silent.exitCode, 0); assert.equal(commandExit(silent, 1), 1, 'no observer cannot qualify exit-zero tests');
  const missing = structuredClone(full); missing.observation.completedFiles.pop();
  assert.equal(commandExit(missing, 1, universe.map(p => join(f.packageRoot, p))), 1);
  const missingEvent = structuredClone(full); missingEvent.observation.events.shift();
  assert.equal(commandExit(missingEvent, 1), 1, 'summary alone cannot cover a missing emitted identity');
  const balanced = structuredClone(full);
  const first = balanced.observation.events.find(e => e.name === 'identity-0')!;
  const second = balanced.observation.events.find(e => e.name === 'repeat')!;
  balanced.observation.events[balanced.observation.events.indexOf(first)] = { ...second };
  assert.equal(commandExit(balanced, 1), 1, 'balanced same-file duplicate replacement must reject');
  const repeated = full.observation.events.filter(e => e.name === 'repeat');
  assert.deepEqual(repeated.map(e => e.ordinal), [1, 2]);
  const duplicatedStream = structuredClone(full); duplicatedStream.observation.streams.push(structuredClone(duplicatedStream.observation.streams[0]!));
  assert.equal(commandExit(duplicatedStream, 2), 1, 'duplicate actual process must reject');
  const missingSummary = structuredClone(full); missingSummary.observation.summaries.length = 0;
  assert.equal(commandExit(missingSummary, 1), 1);
  const duplicate = structuredClone(full); duplicate.observation.completedFiles.push(duplicate.observation.completedFiles[0]!);
  assert.equal(commandExit(duplicate, 1, universe.map(p => join(f.packageRoot, p))), 1);
  const extra = structuredClone(full); extra.observation.completedFiles.push(join(f.packageRoot, 'other.test.ts'));
  assert.equal(commandExit(extra, 1, universe.map(p => join(f.packageRoot, p))), 1);
  const failing = 'tests/package/failing.test.ts';
  await writeFile(join(f.packageRoot, failing), "import test from 'node:test'; test('real failure', () => { throw Error('TEST assertion failed'); });\n");
  const failed = await run([failing], 'failed');
  assert.notEqual(failed.exitCode, 0); assert.equal(commandExit(failed, 1), 1);
  const observation: Observation = { events: [], summaries: [], completedFiles: [], streams: [] };
  assert.throws(() => observeLine('PACKAGE_SUMMARY {"tests":1}', observation), /invalid Node summary/);
  if (process.env.CI_FOCUSED_EVIDENCE_DIR) { await writeFile(join(process.env.CI_FOCUSED_EVIDENCE_DIR, 'synthetic-package-processes.json'), JSON.stringify({
    scope: 'synthetic TEST only; not current product-suite qualification', full, shards, silent, failed,
  }, null, 2) + '\n'); }
});

}
