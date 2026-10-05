import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { fixtureRegistration, protocol } from './foundation-fixture-sharding.ts';
import { validateFoundationWorkflows } from './foundation-fanout-contract.ts';

function exec(file: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { reject(error); } else { resolve({ stdout, stderr }); }
    });
  });
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const boundary = 'scripts/architecture/source-dependency-adapter-boundaries.test.mjs';
const helper = join(root, 'scripts/ci/foundation-fixture-sharding.ts');
const revision = '73c771f254858db430d01d13c3cb433ef18b757d';
// Independent oracle: original reviewed source bytes, never the helper table.
const original = execFileSync('git', ['show', `${revision}:${boundary}`], { cwd: root, encoding: 'utf8' });
const names = [...original.matchAll(/^  test\("([^"]+)",/gmu)].map(match => match[1]!);
const cleanEnv = { ...process.env };
for (const key of ['NODE_TEST_CONTEXT', 'FOUNDATION_FIXTURE_PROTOCOL', 'FOUNDATION_FIXTURE_INDEX', 'FOUNDATION_FIXTURE_COUNT']) {delete cleanEnv[key];}
const envFor = (index: number) => ({ FOUNDATION_FIXTURE_PROTOCOL: protocol, FOUNDATION_FIXTURE_INDEX: String(index), FOUNDATION_FIXTURE_COUNT: '3' });
const workflow = parseDocument(await readFile(join(root, '.github/workflows/ci-foundation.yml'), 'utf8'));
assert.deepEqual(workflow.errors, []);
const jobs = (workflow.toJS() as { jobs: Record<string, { steps?: { name: string; run?: string }[] }> }).jobs;
const aggregate = jobs.aggregate!.steps!.find(step => step.name === 'Require complete observed coverage and successful remainder')!.run!;

interface Report {
  revision: string; index: number; exitCode: number; start: number; end: number;
  registrations: { registered: string[]; excluded: string[] }[];
  events: { name: string; type: string; status: string; skip: boolean; todo: boolean }[];
  summaries: { success: boolean }[];
}

async function disposable<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'foundation-shard-contract-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function prepareSuite(dir: string, env: Record<string, string | undefined>, fault: string) {
  const file = join(dir, 'fixture.test.mts'), calls = join(dir, 'calls.txt'), output = join(dir, 'observed.json');
  const selected = env.FOUNDATION_FIXTURE_INDEX === undefined ? names : names.filter((_, i) => i % 3 === Number(env.FOUNDATION_FIXTURE_INDEX));
  let registered = names;
  if (fault === 'empty') {registered = [];}
  if (fault === 'missing') {registered = names.slice(0, -1);}
  if (fault === 'duplicate') {registered = [...names, names[0]!];}
  await writeFile(file, `
import assert from 'node:assert/strict';
import { describe, before, beforeEach, afterEach, after } from 'node:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { fixtureRegistration } from ${JSON.stringify(helper)};
const fixtures = fixtureRegistration(process.env);
let active = 0, peak = 0, started = 0, ended = 0, ready = false;
let arrivals = 0, releasePeer: (() => void) | undefined;
const rendezvous = () => new Promise<void>(resolve => {
  arrivals++;
  if (arrivals % 2 === 0) { releasePeer!(); releasePeer = undefined; resolve(); }
  else if (arrivals === ${selected.length}) { resolve(); }
  else { releasePeer = resolve; }
});
describe('installed Foundation adapter boundary checks', {concurrency: 2}, () => {
  before(() => { ready = true; });
  beforeEach(() => { assert.equal(ready, true); started++; });
  afterEach(() => { ended++; });
  after(() => { assert.equal(active, 0); assert.equal(peak, 2); assert.equal(started, ${selected.length}); assert.equal(ended, started); ${fault === 'after' ? "throw new Error('after hook failure');" : ''} });
  for (const name of ${JSON.stringify(registered)}) fixtures.test(name, async t => {
    const owned = await mkdtemp(${JSON.stringify(join(dir, 'owned-'))});
    try {
      active++; peak = Math.max(peak, active);
      await appendFile(${JSON.stringify(calls)}, name + '\\n');
      await rendezvous();
      ${fault === 'failed' ? "throw new Error('real body failure');" : ''}
      ${fault === 'skip' ? "t.skip('real Node skip');" : ''}
      ${fault === 'todo' ? "t.todo('real Node todo');" : ''}
    } finally { active--; await rm(owned, {recursive:true, force:true}); }
  });
  const registration = fixtures.finish(); if (registration) console.log(registration);
});
`);
  return { file, calls, output, env };
}

async function runSuite({ file, calls, output, env }: Awaited<ReturnType<typeof prepareSuite>>) {
  let status = 0;
  try {
    await exec(process.execPath, ['--test', `--test-reporter=${helper}`, `--test-reporter-destination=${output}`, file],
      { cwd: root, env: { ...cleanEnv, ...env }, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') {throw error;}
    status = error.code;
  }
  const report = JSON.parse(await readFile(output, 'utf8')) as Report;
  Object.assign(report, { revision, index: Number(env.FOUNDATION_FIXTURE_INDEX ?? -1), exitCode: status, start: 1, end: 2 });
  const executed = await readFile(calls, 'utf8').catch(() => '');
  return { report, executed: executed.trim() ? executed.trim().split('\n') : [], status };
}

// Check all actual generated fixture files together, then execute those same bytes.
async function runGroup(dir: string, cases: Array<{ env?: Record<string, string | undefined>; fault?: string }>) {
  const prepared = await Promise.all(cases.map(async ({ env = {}, fault = '' }) =>
    prepareSuite(await mkdtemp(join(dir, 'case-')), env, fault)));
  await exec(join(root, 'node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--noUncheckedIndexedAccess',
    '--module', 'NodeNext', '--target', 'ES2024', '--allowImportingTsExtensions', '--erasableSyntaxOnly',
    '--types', 'node', '--typeRoots', join(root, 'node_modules/@types'), ...prepared.map(value => value.file)],
    { cwd: root, timeout: 20_000 });
  const results: Awaited<ReturnType<typeof runSuite>>[] = [];
  for (const fixture of prepared) { results.push(await runSuite(fixture)); }
  return results;
}

async function aggregateReports(dir: string, reports: Report[], needs = { fixtures: { result: 'success' }, remainder: { result: 'success' } }, remainderFault = '') {
  const runner = await mkdtemp(join(dir, 'aggregate-')), evidence = join(runner, 'foundation-evidence');
  await mkdir(evidence);
  for (const [i, report] of reports.entries()) {await writeFile(join(evidence, `shard-${i}.json`), JSON.stringify(report));}
  const commands = [
    './node_modules/.bin/agent-teams-foundation check',
    'node --test scripts/docs/runtime-builtin-permissions.test.mjs scripts/ci/run-ordinary-postgres.test.mjs',
    'pnpm foundation:assert-dev-only', 'pnpm foundation:assert-registry', 'pnpm quality:adoption', 'pnpm foundation:scaffold:check',
  ];
  for (const [i, command] of commands.entries()) {
    if (remainderFault === 'missing' && i === 5) {continue;}
    await writeFile(join(evidence, `remainder-${i}.json`), JSON.stringify({ revision, phase: String(i), command,
      exitCode: remainderFault === 'failed' && i === 2 ? 1 : 0, start: i * 2, end: i * 2 + 1 }));
  }
  try {
    await exec('bash', ['-c', aggregate], { cwd: root, env: { ...cleanEnv, RUNNER_TEMP: runner, EXPECTED_REVISION: revision, NEEDS: JSON.stringify(needs) }, timeout: 10_000 });
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') {throw error;}
    return false;
  }
}

export function registerFoundationFixtureShardingTests(): void {
test('all original leaf bodies, assertions, CLI options and cleanup remain byte-identical', async () => {
  assert.equal(names.length, 25);
  assert.equal(new Set(names).size, 25);
  assert.equal([...original.matchAll(/\bassert\.\w+\(/gu)].length, 133);
  const expected = original.replace('import test, { describe } from "node:test";', 'import { describe } from "node:test";\nimport { fixtureRegistration } from "../ci/foundation-fixture-sharding.ts";')
    .replace('import { parseSync } from "oxc-parser";', 'import { parseSync } from "oxc-parser";\n\nconst fixtures = fixtureRegistration(process.env);\nconst test = fixtures.test;')
    .replace('  registerCompositionChecks();\n', '  registerCompositionChecks();\n  const registration = fixtures.finish();\n  if (registration) {\n    console.log(registration);\n  }\n');
  assert.equal(await readFile(join(root, boundary), 'utf8'), expected);
});

test('partial, malformed and unknown shard environments reject before any body execution', async () => {
  const environments = [
    { FOUNDATION_FIXTURE_INDEX: '0' }, { FOUNDATION_FIXTURE_PROTOCOL: protocol }, { FOUNDATION_FIXTURE_COUNT: '3' },
    ...['', '-1', '3', '00', '1/3', '1.0', ' 1'].map(value => ({ ...envFor(0), FOUNDATION_FIXTURE_INDEX: value })),
    { ...envFor(0), FOUNDATION_FIXTURE_COUNT: '2' }, { ...envFor(0), FOUNDATION_FIXTURE_PROTOCOL: 'unknown' },
  ];
  for (const env of environments) { assert.throws(() => fixtureRegistration(env), /invalid Foundation fixture/u); }
  await disposable(async dir => {
    for (const result of await runGroup(dir, environments.map(env => ({ env })))) {
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.executed, []);
      assert.deepEqual(result.report.registrations, []);
    }
  });
});

test('real Node default and three partitions preserve lifecycle/concurrency and aggregate actual execution', async () => {
  await disposable(async dir => {
    const results = await runGroup(dir, [{}, ...[0, 1, 2].map(index => ({ env: envFor(index) })),
      ...['failed', 'skip', 'todo', 'after'].map(fault => ({ env: envFor(0), fault }))]);
    const full = results[0]!;
    assert.equal(full.status, 0);
    assert.deepEqual(full.executed.toSorted(), names.toSorted());
    assert.deepEqual(full.report.registrations, []);
    const reports: Report[] = [];
    for (let index = 0; index < 3; index++) {
      const result = results[index + 1]!;
      assert.equal(result.status, 0);
      assert.deepEqual(result.executed.toSorted(), names.filter((_, i) => i % 3 === index).toSorted());
      reports.push(result.report);
    }
    assert.equal(await aggregateReports(dir, reports), true);
    for (const faulty of [reports.slice(0, 2), [reports[0]!, reports[0]!, reports[2]!]]) {assert.equal(await aggregateReports(dir, faulty), false);}
    for (const mutate of [
      (r: Report) => { r.events = []; r.summaries = []; },
      (r: Report) => { r.registrations[0]!.registered = []; },
      (r: Report) => { r.registrations[0]!.excluded = []; },
      (r: Report) => { r.revision = '0'.repeat(40); },
      (r: Report) => { r.events.push({ name: 'unobserved invented pass', type: 'test', status: 'passed', skip: false, todo: false }); },
      (r: Report) => { r.events[0]!.name = 'unobserved replacement pass'; },
    ]) {
      const changed = structuredClone(reports); mutate(changed[0]!);
      assert.equal(await aggregateReports(dir, changed), false);
    }
    for (const state of ['failure', 'cancelled', 'skipped']) {assert.equal(await aggregateReports(dir, reports, { fixtures: { result: state }, remainder: { result: 'success' } }), false);}
    for (const fault of ['failed', 'missing']) {assert.equal(await aggregateReports(dir, reports, undefined, fault), false);}
    for (const [i, fault] of ['failed', 'skip', 'todo', 'after'].entries()) {
      const result = results[i + 4]!;
      assert.equal(await aggregateReports(dir, [result.report, reports[1]!, reports[2]!]), false, fault);
    }
  });
});

test('real duplicate, incomplete and empty registration fail closed', async () => {
  await disposable(async dir => {
    const faults = ['duplicate', 'missing', 'empty'];
    const results = await runGroup(dir, faults.map(fault => ({ env: envFor(0), fault })));
    for (const [i, result] of results.entries()) {
      assert.notEqual(result.status, 0, faults[i]);
      assert.deepEqual(result.report.registrations, []);
    }
  });
});

test('fixed workflows preserve original remainder, pins, isolation and shell input guards', async () => {
  const baseline = JSON.parse(execFileSync('git', ['show', `${revision}:package.json`], { cwd: root, encoding: 'utf8' })) as { scripts: Record<string, string> };
  const expected = baseline.scripts['foundation:check']!.split(' && ').map(command => {
    if (command === 'agent-teams-foundation check') {return './node_modules/.bin/' + command;}
    if (command === 'pnpm foundation:boundaries:negative') {return baseline.scripts['foundation:boundaries:negative']!.replace(boundary + ' ', '');}
    return command;
  });
  expected.push('pnpm foundation:scaffold:check');
  const remainder = jobs.remainder!.steps!.find(step => step.name === 'Run every original remainder command in serial order')!.run!;
  assert.deepEqual([...remainder.matchAll(/^phase \d (.+)$/gmu)].map(match => match[1]), expected);
  const documents = await Promise.all(['ci-foundation.yml', 'ci-foundation-shard.yml'].map(async file => parseDocument(await readFile(join(root, '.github/workflows', file), 'utf8'))));
  const foundation = documents[0]!.toJS() as unknown;
  const shard = documents[1]!.toJS() as unknown;
  validateFoundationWorkflows(foundation, shard);
  rejectWorkflowFaults(foundation, shard);
  const admitted = new Set(['./.github/workflows/ci-foundation-shard.yml',
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803', 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c']);
  for (const document of documents) {
    assert.deepEqual(document.errors, []);
    const value = document.toJS() as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, { env?: Record<string, string>; uses?: string; steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[] }> };
    assert.deepEqual(Object.keys(value.on), ['workflow_call']);
    assert.deepEqual(value.permissions, { contents: 'read' });
    for (const job of Object.values(value.jobs)) {
      if (job.uses) { assert.ok(admitted.has(job.uses)); continue; }
      assert.equal(job.env?.GIT_AUTHOR_EMAIL, 'iliyazelenkog@gmail.com');
      const checkout = job.steps!.find(step => step.uses?.startsWith('actions/checkout@'))!;
      assert.equal(checkout.with?.['fetch-depth'], 0);
      assert.equal(checkout.with?.['persist-credentials'], false);
      for (const step of job.steps!) {
        if (step.uses) {assert.ok(admitted.has(step.uses));}
        if (step.run) {assert.ok(!step.run.includes('${{'), 'caller strings enter shell only through environment');}
      }
      const guard = job.steps!.find(step => step.run?.includes('git fsck'))!.run!;
      for (const [key, bad] of [['EXPECTED_REVISION', '$(false)'], ['ARTIFACT_PREFIX', 'a; false']]) {
        await assert.rejects(exec('bash', ['-c', guard], { cwd: root, env: { ...cleanEnv, EXPECTED_REVISION: revision, ARTIFACT_PREFIX: 'test', FOUNDATION_FIXTURE_INDEX: '0', [key!]: bad! } }));
      }
    }
  }
});
}

const object = (value: unknown) => value as Record<string, unknown>;

function rejectWorkflowFaults(foundation: unknown, shard: unknown): void {
  // Mutate real parsed workflows, not validator constants or metadata receipts.
  const job = (value: unknown, name: string) => object(object(object(value).jobs)[name]);
  const steps = (value: unknown, name: string) => job(value, name).steps as Array<Record<string, unknown>>;
  const mutations: Array<[boolean, (value: unknown) => void]> = [
    [true, value => { object(value).permissions = { contents: 'write' }; }],
    [true, value => { object(object(object(value).on).workflow_call).inputs = { script: { type: 'string' } }; }],
    [true, value => { job(value, 'fixtures').if = '${{ false }}'; }],
    [true, value => { object(job(value, 'fixtures').strategy).matrix = { index: [0, 1] }; }],
    [true, value => { object(job(value, 'fixtures').strategy)['fail-fast'] = true; }],
    [true, value => { job(value, 'fixtures').secrets = 'inherit'; }],
    [true, value => { object(job(value, 'fixtures').with).revision = 'main'; }],
    [true, value => { job(value, 'remainder')['continue-on-error'] = true; }],
    [true, value => { job(value, 'aggregate').if = '${{ success() }}'; }],
    [true, value => { job(value, 'aggregate').needs = ['fixtures']; }],
    [true, value => { steps(value, 'remainder').find(step => step.name === 'Run every original remainder command in serial order')!.run = 'true'; }],
    [true, value => { steps(value, 'aggregate').find(step => step.name === 'Require complete observed coverage and successful remainder')!.run = 'echo success'; }],
    [true, value => { steps(value, 'aggregate').find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/download-artifact@'))!.with = { pattern: '*' }; }],
    [true, value => { object(steps(value, 'aggregate').find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/download-artifact@'))!.with).pattern = 'foundation-${{ env.ARTIFACT_PREFIX }}-*-${{ github.run_attempt }}'; }],
    [true, value => { steps(value, 'remainder').find(step => step.name === 'Publish successful remainder for same-run retries')!.if = '${{ always() }}'; }],
    [false, value => { object(steps(value, 'shard').find(step => step.name === 'Publish successful partition for same-run retries')!.with).overwrite = false; }],
    [false, value => { steps(value, 'shard')[0]!.uses = 'actions/checkout@main'; }],
    [false, value => { object(steps(value, 'shard')[0]!.with)['fetch-depth'] = 1; }],
    [false, value => { steps(value, 'shard')[1]!.run = 'test "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"'; }],
    [false, value => { steps(value, 'shard').find(step => step.name === 'Frozen install')!.run = 'pnpm install'; }],
    [false, value => { steps(value, 'shard').find(step => step.name === 'Run original boundary file and retain observed results')!.run = 'node --test --test-name-pattern=one scripts/architecture/source-dependency-adapter-boundaries.test.mjs'; }],
    [false, value => { steps(value, 'shard').push({ run: 'arbitrary-script', 'continue-on-error': true }); }],
    [false, value => { object(job(value, 'shard').env).FOUNDATION_FIXTURE_COUNT = '2'; }],
  ];
  for (const [isFoundation, mutate] of mutations) {
    const changed = structuredClone(isFoundation ? foundation : shard);
    mutate(changed);
    assert.throws(() => validateFoundationWorkflows(isFoundation ? changed : foundation, isFoundation ? shard : changed), /Foundation .* contract drift/u);
  }
}
