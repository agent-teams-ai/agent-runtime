import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { commandInventory } from './script-routing.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assertFullInventory, productPhases, requiredJobs } from './policy.ts';
import { readScripts } from './inventory.ts';
import type { Scripts } from './script-routing.ts';
import { validateNightlyWorkflow } from './nightly-contract.ts';
import { validateFoundationWorkflows } from './foundation-fanout-contract.ts';

export const eventRevision = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const checkoutAction = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
const nodeAction = 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38';
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function steps(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

const schedulingGroup = 'check-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}';
const schedulingCancellation = "${{ github.event_name == 'pull_request' }}";

function validateScheduling(value: unknown): void {
  assert.deepEqual(value, { group: schedulingGroup, 'cancel-in-progress': schedulingCancellation },
    'CI scheduling must isolate workflow/event/non-PR SHA and cancel only within a stable PR identity');
}

export type SchedulingEvent = { workflow: string; sha: string } & (
  { eventName: 'pull_request'; pullRequestNumber: number }
  | { eventName: 'push' | 'merge_group'; pullRequestNumber?: never }
);

// A closed projection of the admitted template, not a general Actions expression
// evaluator or evidence of hosted scheduling. || uses the positive PR number,
// falling back to github.sha when that event-specific property is undefined.
export function schedulingForEvent(value: unknown, event: SchedulingEvent): { group: string; cancelInProgress: boolean } {
  validateScheduling(value);
  if (event.eventName === 'pull_request') {
    assert.ok(Number.isSafeInteger(event.pullRequestNumber) && event.pullRequestNumber > 0, 'positive PR identity');
  }
  const group = object(value).group;
  assert.ok(typeof group === 'string');
  return {
    group: group.replace('${{ github.workflow }}', () => event.workflow)
      .replace('${{ github.event_name }}', () => event.eventName)
      .replace('${{ github.event.pull_request.number || github.sha }}', () => String(event.pullRequestNumber || event.sha)),
    cancelInProgress: event.eventName === 'pull_request',
  };
}

export function validateWorkflow(main: unknown, reusable: unknown, platform: Record<string, string>): void {
  const workflow = object(main);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(object(workflow.on)).toSorted(), ['merge_group', 'pull_request', 'push', 'workflow_call']);
  assert.deepEqual(object(workflow.on).workflow_call, {}, 'full CI exposes only an inputless reusable call');
  assert.deepEqual(object(workflow.on).push, { branches: ['main'] });
  validateScheduling(workflow.concurrency);
  const jobs = object(workflow.jobs);
  assert.deepEqual(Object.keys(jobs).toSorted(), [...requiredJobs, 'check', 'postgres-durability', 'runtime-macos'].toSorted());
  for (const name of requiredJobs) {
    const job = object(jobs[name]);
    assert.equal(job.uses, name === 'foundation' ? './.github/workflows/ci-foundation.yml' : './.github/workflows/ci-lane.yml');
    assert.equal(job.if, undefined, 'full lane must run unconditionally');
    assert.equal(job.needs, undefined, 'independent lane');
    assert.equal(job.permissions, undefined);
    assert.equal(job['continue-on-error'], undefined);
    if (name === 'foundation') {
      assert.deepEqual(job.with, { artifact: 'foundation', revision: eventRevision });
      assert.deepEqual(Object.keys(job).toSorted(), ['uses', 'with']);
    } else {
      assert.equal(object(job.with).script, `check:ci:${name}`);
    }
    assert.equal(object(job.with).revision, eventRevision);
  }
  const aggregate = object(jobs.check);
  assert.equal(aggregate.name, 'check');
  assert.equal(aggregate.if, '${{ always() }}');
  assert.deepEqual(aggregate.needs, requiredJobs);
  assert.equal(aggregate['continue-on-error'], undefined);
  const aggregateSteps = steps(aggregate.steps);
  const aggregateCheckout = aggregateSteps.find(step => step.uses === checkoutAction);
  assert.deepEqual(aggregateCheckout?.with, { ref: eventRevision, 'persist-credentials': false, 'fetch-depth': 0 });
  assert.ok(aggregateSteps.some(step => step.run === 'test "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"' && object(step.env).EXPECTED_REVISION === eventRevision));
  assert.ok(aggregateSteps.every(step => step['continue-on-error'] === undefined));
  assert.equal(aggregateSteps.at(-1)?.run, 'node scripts/ci/gate.ts aggregate');
  assert.equal(object(aggregateSteps.at(-1)?.env).NEEDS, '${{ toJSON(needs) }}');
  for (const name of ['postgres-durability', 'runtime-macos']) {
    assert.equal(digest(jobs[name]), platform[name], `${name} platform contract changed`);
  }
  const lane = object(reusable);
  assert.deepEqual(lane.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(object(lane.on)), ['workflow_call']);
  assert.deepEqual(Object.keys(object(lane.jobs)), ['lane']);
  const runner = object(object(lane.jobs).lane);
  assert.equal(runner['runs-on'], "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || vars.CI_LINUX_RUNNER || 'ubuntu-24.04' }}");
  assert.equal(runner['timeout-minutes'], 35);
  const commands = steps(runner.steps);
  const checkout = commands.find(step => step.uses === checkoutAction);
  assert.ok(checkout);
  assert.deepEqual(checkout.with, { ref: '${{ inputs.revision }}', 'persist-credentials': false, 'fetch-depth': 0 });
  const shellGuard = commands.findIndex(step => step.run === 'test "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"\nif [ "$BENCHMARK_ARM" != production ]; then\n  test "$EXPECTED_REVISION" = "$GITHUB_WORKFLOW_SHA"\nfi\n');
  assert.ok(shellGuard > commands.indexOf(checkout), 'verify immutable revision before repository code');
  assert.deepEqual(commands[shellGuard]?.env, { EXPECTED_REVISION: '${{ inputs.revision }}', BENCHMARK_ARM: '${{ inputs.arm }}' });
  const verify = commands.findIndex(step => step.run === 'node scripts/ci/gate.ts revision');
  const retainedHistory = commands.findIndex(step => step.name === 'Retain exact C0 review history before repository code');
  assert.ok(retainedHistory > shellGuard && retainedHistory < verify, 'strict retained history before source execution');
  assert.equal(commands[retainedHistory]?.run, 'set -euo pipefail\nobject=8e5e859d10981e1623d0617e933afc68a9e8770c\nif ! git cat-file -e "$object^{commit}"; then\n  git fetch --no-tags origin "$object"\nfi\ntest "$(git rev-parse "$object^{commit}")" = "$object"\ngit fsck --connectivity-only --no-reflogs "$object"\n');
  assert.equal(commands[retainedHistory]?.shell, 'bash');
  assert.deepEqual(runner.env, { GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com', GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com' });
  assert.ok(verify > shellGuard, 'shell revision guard must precede repository code');
  assert.equal(runner['continue-on-error'], undefined);
  const entries = ['check:ci:quick', 'check:ci:foundation', 'check:ci:architecture', 'check:ci:docs', ...Object.keys(productPhases)];
  const execution = commands.filter(step => typeof step.run === 'string' && step.run.startsWith('node scripts/ci/measure.ts '));
  assert.deepEqual(execution.map(step => step.run), entries.map(entry => `node scripts/ci/measure.ts ${entry}`));
  assert.ok(verify >= 0, 'typed revision binding is required');
  assert.equal(object(commands[verify]?.env).EXPECTED_REVISION, '${{ inputs.revision }}');
  for (const [index, step] of execution.entries()) {
    assert.ok(commands.indexOf(step) > verify, 'verify checkout before execution');
    const entry = entries[index];
    assert.ok(entry);
    const laneName = entry.startsWith('check:ci:product:') ? 'check:ci:product' : entry;
    assert.equal(step.if, "${{ inputs.script == 'check' || inputs.script == '" + laneName + "' }}");
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(object(step.env).EXPECTED_REVISION, '${{ inputs.revision }}');
  }
  for (const step of commands) {
    if (step.run !== 'pnpm quality:diagnostic') { assert.equal(step['continue-on-error'], undefined); }
  }
  assert.ok(commands.some(step => step.uses === nodeAction && object(step.with)['node-version-file'] === '.node-version'));
  const install = commands.findIndex(step => step.run === 'pnpm install --frozen-lockfile');
  assert.ok(install > verify && execution.every(step => commands.indexOf(step) > install), 'frozen install before full commands');
  assert.ok(commands.some(step => step.run === 'corepack enable\ncorepack install --global pnpm@11.18.0\n'));
}

export function validateBenchmark(value: unknown): void {
  const benchmark = object(value);
  assert.deepEqual(Object.keys(object(benchmark.on)), ['workflow_dispatch']);
  assert.deepEqual(benchmark.permissions, { contents: 'read' });
  assert.deepEqual(benchmark.concurrency, { group: 'benchmark-${{ github.workflow_sha }}-${{ inputs.pair }}-${{ inputs.arm }}', 'cancel-in-progress': false });
  const inputs = object(object(object(benchmark.on).workflow_dispatch).inputs);
  assert.deepEqual(object(inputs.arm).options, ['serial', 'parallel']);
  assert.deepEqual(object(inputs.pair).options, ['1', '2', '3']);
  const jobs = object(benchmark.jobs);
  assert.deepEqual(Object.keys(jobs).toSorted(), ['serial', ...requiredJobs, 'benchmark-completeness'].toSorted());
  for (const name of ['serial', ...requiredJobs]) {
    const job = object(jobs[name]);
    const arm = name === 'serial' ? 'serial' : 'parallel';
    assert.equal(job.if, "${{ inputs.arm == '" + arm + "' }}");
    assert.equal(job.uses, './.github/workflows/ci-lane.yml');
    assert.deepEqual(job.with, { script: name === 'serial' ? 'check' : `check:ci:${name}`, artifact: `benchmark-${arm}-${name}`, revision: '${{ inputs.revision }}', arm });
    assert.notEqual(job.name, 'check', 'benchmark cannot supply production status');
  }
  const gate = object(jobs['benchmark-completeness']);
  assert.equal(gate.if, '${{ always() }}');
  assert.deepEqual(gate.needs, ['serial', ...requiredJobs]);
  assert.equal(gate.permissions, undefined);
  assert.equal(gate['continue-on-error'], undefined);
  const gateSteps = steps(gate.steps);
  assert.deepEqual(gateSteps.find(step => step.uses === checkoutAction)?.with,
    { ref: '${{ github.workflow_sha }}', 'persist-credentials': false, 'fetch-depth': 0 });
  assert.ok(gateSteps.some(step => step.run === 'test "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"'
    && object(step.env).EXPECTED_REVISION === '${{ github.workflow_sha }}'));
  assert.equal(gateSteps.at(-1)?.run, 'node scripts/ci/gate.ts benchmark');
  assert.deepEqual(gateSteps.at(-1)?.env, { NEEDS: '${{ toJSON(needs) }}', BENCHMARK_ARM: '${{ inputs.arm }}' });
}

export async function conformance(root: string): Promise<void> {
  const read = (path: string) => readFile(resolve(root, path), 'utf8');
  const scripts = await readScripts(resolve(root, 'package.json'));
  assert.equal((await read('.node-version')).trim(), '24.21.0');
  validateBenchmark(parse(await read('.github/workflows/ci-benchmark.yml')));
  type Snapshot = { baseCommit: string; packageSha256: string; sourcePolicySha256: string };
  const baseline: Snapshot & { predecessor: Snapshot; scripts: Scripts; inventory: unknown } = JSON.parse(await read('scripts/ci/full-contract.json'));
  // Advance the frozen serial-root baseline only for the immutable Docs split;
  // retain its predecessor rather than accepting CI routing or a moving main.
  assert.equal(baseline.baseCommit, 'df9260b0062dcb445c3cf75ce76f8539a2b32c03');
  assert.deepEqual(baseline.predecessor, {
    baseCommit: 'ccf6d6f8dc025d6aa81ab2109a9ccc37b0dece15',
    packageSha256: '88837bba7d6623a000aa9156ef6722dd537efce0b904f855c87d823d8b427318',
    sourcePolicySha256: '7796f9ee6d1c7711745afb6630bf0bc943518482ea406749ced4374b619ce0c6',
  });
  execFileSync('git', ['merge-base', '--is-ancestor', baseline.predecessor.baseCommit, baseline.baseCommit], { cwd: root });
  const predecessorPackage = execFileSync('git', ['show', `${baseline.predecessor.baseCommit}:package.json`], { cwd: root });
  assert.equal(createHash('sha256').update(predecessorPackage).digest('hex'), baseline.predecessor.packageSha256, 'predecessor package bytes');
  const originalPackage = execFileSync('git', ['show', `${baseline.baseCommit}:package.json`], { cwd: root });
  assert.equal(createHash('sha256').update(originalPackage).digest('hex'), baseline.packageSha256, 'original package bytes');
  const originalManifest = JSON.parse(originalPackage.toString('utf8'));
  const predecessorManifest = JSON.parse(predecessorPackage.toString('utf8'));
  const { scripts: originalScripts, ...originalMetadata } = originalManifest;
  const { scripts: predecessorScripts, ...predecessorMetadata } = predecessorManifest;
  assert.deepEqual(originalMetadata, predecessorMetadata, 'Docs baseline migration preserves all package metadata and dependencies');
  const docsMigrationScripts = new Set(['docs:qualification', 'docs:qualification:typecheck', 'docs:qualification:serial', 'docs:qualification:portable']);
  const nonDocsScripts = (value: Scripts) => Object.fromEntries(Object.entries(value).filter(([name]) => !docsMigrationScripts.has(name)));
  assert.deepEqual(nonDocsScripts(originalScripts), nonDocsScripts(predecessorScripts), 'Docs baseline migration preserves all non-Docs scripts');
  assert.notEqual(originalScripts['docs:qualification'], predecessorScripts['docs:qualification'], 'Docs qualification split is explicit');
  for (const name of ['docs:qualification:typecheck', 'docs:qualification:serial', 'docs:qualification:portable']) {
    assert.equal(predecessorScripts[name], undefined, `${name} is introduced only by Docs migration`);
    assert.equal(typeof originalScripts[name], 'string', `${name} is retained by Docs migration`);
  }
  const currentManifest = JSON.parse(await read('package.json'));
  for (const key of ['engines', 'packageManager', 'dependencies', 'devDependencies']) { assert.deepEqual(currentManifest[key], originalManifest[key], `current-main ${key}`); }
  assert.deepEqual(baseline.scripts, originalManifest.scripts, 'original current-main scripts');
  assert.deepEqual(baseline.inventory, commandInventory(baseline.scripts, 'check'), 'original current-main leaf inventory');
  const originalPolicy = execFileSync('git', ['show', `${baseline.baseCommit}:architecture/foundation/source-dependencies.yaml`], { cwd: root });
  assert.equal(createHash('sha256').update(originalPolicy).digest('hex'), baseline.sourcePolicySha256, 'original source policy bytes');
  const predecessorPolicy = execFileSync('git', ['show', `${baseline.predecessor.baseCommit}:architecture/foundation/source-dependencies.yaml`], { cwd: root });
  assert.equal(createHash('sha256').update(predecessorPolicy).digest('hex'), baseline.predecessor.sourcePolicySha256, 'predecessor source policy bytes');
  assert.deepEqual(originalPolicy, predecessorPolicy, 'Docs baseline migration preserves source-policy scope');
  assertFullInventory(scripts, baseline.scripts);
  const platform: Record<string, string> = JSON.parse(await read('scripts/ci/platform-contract.json'));
  const runtime: unknown = parse(await read('.github/workflows/ci.yml'));
  validateWorkflow(runtime, parse(await read('.github/workflows/ci-lane.yml')), platform);
  validateFoundationWorkflows(parse(await read('.github/workflows/ci-foundation.yml')),
    parse(await read('.github/workflows/ci-foundation-shard.yml')));
  validateNightlyWorkflow(parse(await read('.github/workflows/ci-nightly.yml')), runtime, platform);
  for (const file of ['.github/workflows/docs-protocol.yml', '.github/workflows/commit-author-identity.yml', '.github/workflows/node-26-compatibility.yml', 'scripts/ci/audit-node-engine-compatibility.mjs', 'scripts/ci/node-engine-compatibility.test.mjs', 'scripts/ci/node-runtime-compatibility.test.mjs']) {
    assert.equal(createHash('sha256').update(await read(file)).digest('hex'), platform[file], `${file} trust contract changed`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await conformance(process.cwd());
  console.log('CI full inventory, prerequisites, event revision and platform/trust contracts verified.');
}
