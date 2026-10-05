import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { assertAggregate, assertFullInventory, assertRevision, productPhases, requiredJobs } from './policy.ts';
import { commandInventory, routedScripts } from './script-routing.ts';
import type { Scripts } from './script-routing.ts';
import { readScripts } from './inventory.ts';
import { assertCmsComposite, captureCmsComposite, cmsBinding, cmsContract, cmsFile, inputPaths, assertPhaseTestExecution, createTestResultCollector, mandatoryRunnerSummary, tapResult, toolchainKeys } from './measure.ts';
import { object as workflowObject, schedulingForEvent, validateBenchmark, validateWorkflow } from './conformance.ts';
import type { SchedulingEvent } from './conformance.ts';
import { compare } from './compare.ts';
import type { Receipt } from './compare.ts';
import { registerCmsPinReviewTests } from './cms-pin-review.test.ts';
import { registerNightlyContractTests } from './nightly-contract.test.ts';
import { registerFoundationFixtureShardingTests } from './foundation-fixture-sharding.test.ts';

registerCmsPinReviewTests();
registerNightlyContractTests();
registerFoundationFixtureShardingTests();

const scripts = await readScripts(new URL('../../package.json', import.meta.url));
const baseline: { scripts: Scripts } = JSON.parse(await readFile(new URL('./full-contract.json', import.meta.url), 'utf8'));
const successful = () => Object.fromEntries(requiredJobs.map(name => [name, { result: 'success' }]));

test('aggregate runs the real CLI and fails on every incomplete required result', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ar-ci-aggregate-TEST-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const invoke = (needs: unknown) => spawnSync(process.execPath,
    [new URL('./gate.ts', import.meta.url).pathname, 'aggregate'], {
      env: { ...process.env, HOME: home, NEEDS: JSON.stringify(needs), BENCHMARK_ARM: 'serial' }, encoding: 'utf8',
    });
  assert.equal(invoke(successful()).status, 0);
  for (const name of requiredJobs) {
    for (const status of ['failure', 'cancelled', 'skipped', 'timed_out', 'unknown', undefined]) {
      const needs = successful();
      Reflect.set(needs, name, { result: status });
      assert.notEqual(invoke(needs).status, 0, `${name}=${String(status)} must fail`);
    }
    const missing = successful();
    Reflect.deleteProperty(missing, name);
    assert.notEqual(invoke(missing).status, 0);
  }
  assert.throws(() => assertAggregate(null));
  assert.throws(() => assertAggregate({ ...successful(), extra: { result: 'success' } }));
});

test('routing rejects missing scripts, no-op replacements and cycles at execution reachability', () => {
  for (const source of ['true', ':', 'echo success', 'true # && pnpm leaf', 'node test.ts || true']) {
    assert.throws(() => commandInventory({ check: 'pnpm leaf', leaf: source }, 'check'));
  }
  assert.throws(() => commandInventory({ check: 'pnpm absent' }, 'check'), /missing script/u);
  assert.throws(() => commandInventory({ check: 'pnpm a', a: 'pnpm check' }, 'check'), /cycle/u);
  assert.deepEqual(routedScripts({ check: 'pnpm lane', lane: 'pnpm leaf', leaf: 'node --test fixture.ts' }, 'check'), ['pnpm leaf']);
});

test('the original command inventory survives routing and rejects lost leaves and prerequisites', () => {
  assertFullInventory(scripts, baseline.scripts);
  const faults: Array<(value: Record<string, string>) => void> = [
    value => { value['check:ci:architecture'] = (value['check:ci:architecture'] ?? '').replace(' && pnpm test:ar2-contract', ''); },
    value => { value['check:ci:quick'] += ' && pnpm docs:protocol:check'; },
    value => { value['check:ci:quick'] = value['check:ci:quick']!.replace(' && pnpm check:node-compat', ''); },
    value => { value['check:fast'] = value['check:fast']!.replace(' && pnpm check:node-compat', ''); },
    value => { value['test:consumer-modules'] = value['test:consumer-modules']!.replace(` && node --test ${cmsFile}`, ''); },
    value => { value['docs:qualification'] = 'true'; },
    value => { delete value['test:ar2-contract']; },
    value => { value.check = 'pnpm check:ci:quick'; },
    value => { value['product:check'] = "pnpm product:build && pnpm --filter './packages/**' -r run clean && pnpm --filter './packages/**' -r run test"; },
    value => { value['product:check'] += ' --test-name-pattern=one'; },
    value => { value['typecheck:ci'] = "node -e 'process.exit(0)'"; },
    value => { value['test:ci'] = "node -e 'process.exit(0)'"; },
  ];
  for (const mutate of faults) {
    const changed = { ...scripts };
    mutate(changed);
    assert.throws(() => assertFullInventory(changed, baseline.scripts));
  }
});

test('event checkout binding rejects a wrong, absent or moving revision', () => {
  const sha = '1'.repeat(40);
  assertRevision(`${sha}\n`, sha);
  assert.throws(() => assertRevision('2'.repeat(40), sha), /mismatch/u);
  for (const expected of ['', 'main', '1'.repeat(39)]) {
    assert.throws(() => assertRevision(sha, expected), /immutable/u);
  }
});

test('Docs successor rejects semantic bypasses, qualification drift and lost Runtime scopes', async t => {
  assertFullInventory(scripts, baseline.scripts);
  const faults: Array<[string, (value: Record<string, string>) => void]> = [
    ['semantic gate omits docs check', value => { value['docs:protocol:check'] = 'pnpm docs:governance'; }],
    ['semantic gate omits governance', value => { value['docs:protocol:check'] = 'pnpm docs:check'; }],
    ['semantic gate becomes a no-op', value => { value['docs:protocol:check'] = 'true'; }],
    ['semantic gate reverses check and governance with identical leaves', value => {
      value['docs:protocol:check'] = 'pnpm docs:governance && pnpm docs:check';
    }],
    ['qualification changes phase order with identical leaves', value => {
      value['docs:qualification'] = 'pnpm docs:qualification:serial && pnpm docs:qualification:portable && pnpm docs:qualification:typecheck';
    }],
    ['semantic gate retains predecessor nesting', value => {
      value['docs:protocol:check'] += ' && pnpm docs:qualification';
      for (const gate of ['check:ci:docs', 'check:fast']) {
        value[gate] = value[gate]!.replace(' && pnpm docs:qualification', '');
      }
    }],
    ['fast gate qualifies before semantics with identical leaves', value => {
      value['check:fast'] = value['check:fast']!.replace(
        'pnpm docs:protocol:check && pnpm docs:qualification',
        'pnpm docs:qualification && pnpm docs:protocol:check');
    }],
    ['fast gate delays qualification with identical leaves', value => {
      value['check:fast'] = value['check:fast']!.replace(' && pnpm docs:qualification', '') + ' && pnpm docs:qualification';
    }],
  ];
  for (const gate of ['check:ci:docs', 'check:fast']) {
    faults.push([`${gate} omits qualification`, value => {
      value[gate] = value[gate]!.replace(' && pnpm docs:qualification', '');
    }], [`${gate} duplicates qualification`, value => { value[gate] += ' && pnpm docs:qualification'; }]);
  }
  for (const phase of ['typecheck', 'serial', 'portable']) {
    const command = `pnpm docs:qualification:${phase}`;
    faults.push([`qualification omits ${phase}`, value => {
      value['docs:qualification'] = value['docs:qualification']!.split(' && ').filter(step => step !== command).join(' && ');
    }], [`qualification duplicates ${phase}`, value => { value['docs:qualification'] += ` && ${command}`; }]);
  }
  for (const scope of ['index', 'architecture', 'adr', 'evidence', 'qualification-plan']) {
    faults.push([`portable qualification omits ${scope}`, value => {
      value['docs:qualification:portable'] = value['docs:qualification:portable']!.replace(
        ` scripts/docs/portable-authoring-${scope}.test.mts`, '');
    }]);
  }
  for (const leaf of ['docs:check', 'docs:governance', 'docs:qualification:typecheck', 'docs:qualification:serial', 'docs:qualification:portable']) {
    faults.push([`${leaf} becomes a successful Node no-op`, value => { value[leaf] = "node -e 'process.exit(0)'"; }]);
  }
  for (const leaf of ['docs:qualification:typecheck', 'docs:qualification:serial', 'docs:qualification:portable']) {
    faults.push([`${leaf} duplicates its terminal command`, value => { value[leaf] += ` && ${value[leaf]}`; }]);
  }
  for (const [name, mutate] of faults) {
    await t.test(name, () => {
      const changed = { ...scripts };
      mutate(changed);
      assert.throws(() => assertFullInventory(changed, baseline.scripts), name);
    });
  }
});

test('real workflow policy rejects omitted jobs, wrong PR checkout, shallow history and platform drift', async () => {
  const main: unknown = parse(await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const lane: unknown = parse(await readFile(new URL('../../.github/workflows/ci-lane.yml', import.meta.url), 'utf8'));
  const platform: Record<string, string> = JSON.parse(await readFile(new URL('./platform-contract.json', import.meta.url), 'utf8'));
  validateWorkflow(main, lane, platform);
  // Mutants are passed to the actual validator, not assertions about YAML strings.
  const value = structuredClone(main) as { jobs: Record<string, Record<string, unknown>> };
  const check = value.jobs.check;
  assert.ok(check);
  check.needs = ['quick', 'foundation', 'architecture', 'product'];
  assert.throws(() => validateWorkflow(value, lane, platform));
  const changed = structuredClone(main) as { jobs: Record<string, { with?: Record<string, unknown>; steps?: unknown[] }> };
  const docs = changed.jobs.docs;
  assert.ok(docs?.with);
  docs.with.revision = '${{ github.sha }}';
  assert.throws(() => validateWorkflow(changed, lane, platform));
  const platformDrift = structuredClone(main) as { jobs: Record<string, { steps?: unknown[] }> };
  const pg = platformDrift.jobs['postgres-durability'];
  assert.ok(pg);
  pg.steps = [];
  assert.throws(() => validateWorkflow(platformDrift, lane, platform), /platform contract changed/u);
  const shallow = structuredClone(lane) as { jobs: { lane: { steps: Array<{ uses?: string; with?: Record<string, unknown> }> } } };
  const checkout = shallow.jobs.lane.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout?.with);
  checkout.with['fetch-depth'] = 1;
  assert.throws(() => validateWorkflow(main, shallow, platform));
  const unbound = structuredClone(lane) as { jobs: { lane: { steps: Array<{ run?: string }> } } };
  const guard = unbound.jobs.lane.steps.find(step => step.run?.includes('GITHUB_WORKFLOW_SHA'));
  assert.ok(guard);
  guard.run = 'test "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"';
  assert.throws(() => validateWorkflow(main, unbound, platform), /immutable revision/u);
});

test('current scheduling rejects pending main loss, non-PR cancellation, stale PR heads and cross-talk', async t => {
  const main: unknown = parse(await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const lane: unknown = parse(await readFile(new URL('../../.github/workflows/ci-lane.yml', import.meta.url), 'utf8'));
  const platform: Record<string, string> = JSON.parse(await readFile(new URL('./platform-contract.json', import.meta.url), 'utf8'));
  validateWorkflow(main, lane, platform);
  const faults: Array<[string, Record<string, unknown>]> = [
    ['former policy cancels distinct main SHAs', { group: 'check-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true }],
    ['shared main ref replaces pending SHAs despite PR-only cancellation', {
      ...workflowObject(workflowObject(main).concurrency), group: 'check-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}',
    }],
    ['disabling cancellation alone still replaces pending main SHAs', {
      group: 'check-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': false,
    }],
    ['non-PR running work is cancellable', { ...workflowObject(workflowObject(main).concurrency), 'cancel-in-progress': true }],
    ['obsolete PR heads survive', { ...workflowObject(workflowObject(main).concurrency), 'cancel-in-progress': false }],
    ['PR group follows the merge SHA instead of stable identity', {
      ...workflowObject(workflowObject(main).concurrency), group: 'check-${{ github.workflow }}-${{ github.event_name }}-${{ github.sha }}',
    }],
    ['PR group follows the head SHA instead of stable identity', {
      ...workflowObject(workflowObject(main).concurrency), group: 'check-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.head.sha || github.sha }}',
    }],
    ['different PRs with equal branch names interfere', {
      ...workflowObject(workflowObject(main).concurrency), group: 'check-${{ github.workflow }}-${{ github.event_name }}-${{ github.head_ref || github.sha }}',
    }],
    ['equal SHA or PR number in different events interferes', {
      ...workflowObject(workflowObject(main).concurrency), group: 'check-${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}',
    }],
    ['different workflows interfere', {
      ...workflowObject(workflowObject(main).concurrency), group: 'check-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}',
    }],
  ];
  for (const [name, concurrency] of faults) {
    await t.test(name, () => {
      const changed = workflowObject(structuredClone(main));
      changed.concurrency = concurrency;
      assert.throws(() => validateWorkflow(changed, lane, platform), /CI scheduling/u);
    });
  }
});

test('admitted scheduling separates three main SHAs and merge-group work while grouping only the same PR', async () => {
  const concurrency = workflowObject(parse(await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'))).concurrency;
  // Literal expected groups are independent of the projection and its constants.
  // Three main arrivals cover the pending-slot replacement risk; PR github.sha
  // represents a changing merge revision and never determines the PR group.
  const rows: Array<[SchedulingEvent, string, boolean]> = [
    [{ workflow: 'CI', eventName: 'push', sha: 'a'.repeat(40) }, `check-CI-push-${'a'.repeat(40)}`, false],
    [{ workflow: 'CI', eventName: 'push', sha: 'b'.repeat(40) }, `check-CI-push-${'b'.repeat(40)}`, false],
    [{ workflow: 'CI', eventName: 'push', sha: 'c'.repeat(40) }, `check-CI-push-${'c'.repeat(40)}`, false],
    [{ workflow: 'CI', eventName: 'merge_group', sha: 'a'.repeat(40) }, `check-CI-merge_group-${'a'.repeat(40)}`, false],
    [{ workflow: 'CI', eventName: 'merge_group', sha: 'b'.repeat(40) }, `check-CI-merge_group-${'b'.repeat(40)}`, false],
    [{ workflow: 'CI', eventName: 'pull_request', sha: 'a'.repeat(40), pullRequestNumber: 201 }, 'check-CI-pull_request-201', true],
    [{ workflow: 'CI', eventName: 'pull_request', sha: 'b'.repeat(40), pullRequestNumber: 201 }, 'check-CI-pull_request-201', true],
    [{ workflow: 'CI', eventName: 'pull_request', sha: 'a'.repeat(40), pullRequestNumber: 202 }, 'check-CI-pull_request-202', true],
    [{ workflow: 'Other CI', eventName: 'push', sha: 'a'.repeat(40) }, `check-Other CI-push-${'a'.repeat(40)}`, false],
    [{ workflow: 'Other CI', eventName: 'merge_group', sha: 'a'.repeat(40) }, `check-Other CI-merge_group-${'a'.repeat(40)}`, false],
    [{ workflow: 'Other CI', eventName: 'pull_request', sha: 'a'.repeat(40), pullRequestNumber: 201 }, 'check-Other CI-pull_request-201', true],
  ];
  const groups: string[] = [];
  for (const [event, group, cancelInProgress] of rows) {
    const actual = schedulingForEvent(concurrency, event);
    assert.deepEqual(actual, { group, cancelInProgress });
    groups.push(actual.group.toLowerCase()); // GitHub concurrency is case insensitive.
  }
  const expectedRepeated = 'check-ci-pull_request-201';
  assert.equal(groups.filter(group => group === expectedRepeated).length, 2);
  assert.equal(new Set(groups).size, rows.length - 1, 'all other event/workflow/SHA/PR identities must be isolated');
});

test('measurement observes real Node test identities including failure and skip', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-ci-tap-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'observed.test.ts');
  await writeFile(fixture, "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('observed passing identity', () => assert.equal(1, 1));\ntest('observed failure identity', () => assert.fail('intentional disposable TEST failure'));\ntest('observed skip identity', { skip: true }, () => {});\n");
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  delete environment.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], {
    env: environment, encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  const observed = run.stdout.split('\n').flatMap(line => {
    const result = tapResult(line);
    return result ? [[result.name, result.status]] : [];
  });
  assert.deepEqual(observed, [['observed passing identity', 'passed'], ['observed failure identity', 'failed'], ['observed skip identity', 'skip']]);
  const spec = spawnSync(process.execPath, ['--test', '--test-reporter=spec', fixture], { env: environment, encoding: 'utf8' });
  assert.equal(spec.status, 1);
  const reported = spec.stdout.split('\n').flatMap(line => { const result = tapResult(line); return result ? [[result.name, result.status]] : []; });
  for (const identity of observed) { assert.ok(reported.some(row => JSON.stringify(row) === JSON.stringify(identity)), `missing spec identity: ${JSON.stringify(identity)}`); }
});


test('installed mandatory runner remains blocking while opaque identity receipts stay unqualified', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-ci-mandatory-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'contract.json'), JSON.stringify({ schemaVersion: 1,
    required: [{ file: 'protected.test.ts', names: ['required observed fixture'], kind: 'test' }], exceptions: [] }));
  const fixture = join(root, 'protected.test.ts');
  await writeFile(fixture, "import test from 'node:test';\ntest('required observed fixture', () => {});\n");
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  delete environment.NODE_TEST_CONTEXT;
  const invoke = () => spawnSync(new URL('../../node_modules/.bin/agent-teams-node-test', import.meta.url).pathname,
    ['--contract', 'contract.json', '--', 'protected.test.ts'], { cwd: root, env: environment, encoding: 'utf8' });
  const green = invoke();
  assert.equal(green.status, 0, green.stderr);
  const summaries = green.stdout.split('\n').map(mandatoryRunnerSummary).filter((value): value is string => value !== undefined);
  assert.equal(summaries.length, 1, green.stdout);
  const phase = { script: 'test:protected', commands: [{ script: 'test:protected', command: 'agent-teams-node-test --contract contract.json -- protected.test.ts' }],
    tests: green.stdout.split('\n').flatMap(line => { const result = tapResult(line); return result ? [result] : []; }), unqualifiedRunners: summaries };
  assert.equal(phase.tests.length, 0, 'installed CLI currently suppresses individual success identities');
  assertPhaseTestExecution(phase);
  assert.throws(() => assertPhaseTestExecution({ ...phase, unqualifiedRunners: [] }), /no test execution/u);
  assert.throws(() => assertPhaseTestExecution({ ...phase, unqualifiedRunners: ['Mandatory Node tests: 0 required identities completed or exactly excepted'] }), /no test execution/u);
  for (const source of ["test('different observed fixture', () => {});", "test('required observed fixture', { skip: true }, () => {});", "test('required observed fixture', { todo: true }, () => {});", "test('required observed fixture', () => { throw Error('intentional TEST failure'); });"]) {
    await writeFile(fixture, `import test from 'node:test';\n${source}\n`);
    assert.notEqual(invoke().status, 0, 'missing, failed, skipped or todo identity must remain red');
  }
  await rm(fixture);
  assert.notEqual(invoke().status, 0, 'missing selected file must remain red');
});

test('TAP and spec retain full ancestry for equal leaf names under equal immediate parents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-ci-ancestry-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'nested.test.ts');
  await writeFile(fixture, "import { describe, it } from 'node:test';\nfor (const branch of ['left', 'right']) { describe(branch, () => { describe('shared parent', () => { it('same leaf', () => {}); }); }); }\n");
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  delete environment.NODE_TEST_CONTEXT;
  for (const reporter of ['tap', 'spec']) {
    const run = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, fixture], { env: environment, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const observe = createTestResultCollector();
    const leaves = run.stdout.split('\n').flatMap(line => {
      const result = observe(line);
      return result?.name === 'same leaf' ? [{ ancestry: result.ancestry, status: result.status }] : [];
    });
    assert.deepEqual(leaves, [
      { ancestry: ['left', 'shared parent'], status: 'passed' },
      { ancestry: ['right', 'shared parent'], status: 'passed' },
    ], `${reporter} collapsed distinct nested identities`);
  }
  // Recursive pnpm can interleave package output; a sibling must not inherit it.
  const observe = createTestResultCollector();
  observe('packages/a test: # Subtest: parent a');
  observe('packages/b test: # Subtest: parent b');
  assert.deepEqual(observe('packages/a test:     ok 1 - child')?.ancestry, ['parent a']);
  assert.deepEqual(observe('packages/b test:     ok 1 - child')?.ancestry, ['parent b']);
});

test('benchmark stays dispatch-only, immutable and separate from production status/concurrency', async () => {
  const source: unknown = parse(await readFile(new URL('../../.github/workflows/ci-benchmark.yml', import.meta.url), 'utf8'));
  validateBenchmark(source);
  const changed = structuredClone(source) as { concurrency: Record<string, unknown>; jobs: Record<string, { with?: Record<string, unknown> }> };
  changed.concurrency.group = 'shared-ref';
  assert.throws(() => validateBenchmark(changed));
  const wrongRef = structuredClone(source) as { jobs: Record<string, { with?: Record<string, unknown> }> };
  const serial = wrongRef.jobs.serial;
  assert.ok(serial?.with);
  serial.with.revision = '${{ github.sha }}';
  assert.throws(() => validateBenchmark(wrongRef));
});

test('paired evidence rejects missing phases, missing test identities, new skips and input drift', async () => {
  const cms = await captureCmsComposite();
  const binding = await cmsBinding();
  const contract = JSON.parse(await readFile(cmsContract, 'utf8'));
  assertCmsComposite(cms, binding, cms.direct.tests, contract);
  const entries = ['check:ci:quick', 'check:ci:foundation', 'check:ci:architecture', 'check:ci:docs', ...Object.keys(productPhases)];
  const receipt = (entry: string): Receipt => {
    const commands = commandInventory(scripts, entry).filter(command => entry !== 'check:ci:architecture' || command.script !== 'test:consumer-modules');
    const inventory = commandInventory(scripts, entry);
    return { entry, sha: '1'.repeat(40), workflowSha: '1'.repeat(40), inputTree: '2'.repeat(40),
      node: 'v24.21.0', pnpm: '11.18.0', runnerOS: 'Linux', cachePolicy: 'none',
      runnerImage: { os: 'ubuntu24', version: 'explicit receipt unit fixture', arch: 'X64' },
      toolchain: Object.fromEntries(toolchainKeys(entry).map(key => [key,
        key === 'rustc' ? 'rustc 1.97.1 (explicit unit fixture)' : key === 'cargo' ? 'cargo 1.97.1 (explicit unit fixture)' : 'explicit compiler unit fixture'])),
      digests: Object.fromEntries(inputPaths.map(key => [key, binding[key] ?? '3'.repeat(64)])),
      inventory, phases: [{ script: entry, commands, code: 0, signal: null, wallMs: 100,
        started: '2026-10-03T00:00:00.000Z', ended: '2026-10-03T00:00:00.100Z',
        tests: [{ suite: 'explicit receipt unit fixture', name: entry, ancestry: [], depth: 0, status: 'passed' }] }, ...(entry === 'check:ci:architecture' ? [{ script: 'test:consumer-modules', commands: commandInventory(scripts, 'test:consumer-modules'), code: 0, signal: null, wallMs: 100, started: '2026-10-03T00:00:00.000Z', ended: '2026-10-03T00:00:00.100Z', tests: cms.direct.tests, cms }] : [])] };
  };
  const serial = entries.map(receipt);
  const parallel = structuredClone(serial);
  const independentlyObserved = await captureCmsComposite();
  const cmsPhase = parallel.find(value => value.entry === 'check:ci:architecture')?.phases.find(value => value.script === 'test:consumer-modules');
  assert.ok(cmsPhase); cmsPhase.cms = independentlyObserved; cmsPhase.tests = independentlyObserved.direct.tests;
  compare(serial, parallel);
  console.log('Actual direct CMS Node events:', JSON.stringify(cms.direct.tests));
  const mandatoryDiagnostic = `Independent mandatory CLI process: ${JSON.stringify({ code: cms.mandatory?.code, signal: cms.mandatory?.signal, summaries: cms.mandatory?.summaries })}`;
  assert.equal(mandatoryRunnerSummary(mandatoryDiagnostic), undefined, 'quoted test:ci evidence is not standalone mandatory runner output');
  console.log(mandatoryDiagnostic);
  if (process.env.CI_FOCUSED_EVIDENCE_DIR) { await writeFile(join(process.env.CI_FOCUSED_EVIDENCE_DIR, 'cms-public-observation.json'), `${JSON.stringify({ serialFixture: cms, parallelFixture: independentlyObserved }, null, 2)}\n`); }
  const faults: Array<(value: Receipt[]) => void> = [
    value => { value.pop(); },
    value => { const first = value[0]; assert.ok(first); first.phases = []; },
    value => { const first = value[0]; assert.ok(first); first.digests['pnpm-lock.yaml'] = '4'.repeat(64); },
    value => { const first = value[0]; assert.ok(first); first.workflowSha = '5'.repeat(40); },
    value => { const first = value[0]; assert.ok(first); first.runnerImage.version = 'different runner image'; },
    value => { const first = value[0]; assert.ok(first); first.runnerImage.version = 'unobserved'; },
    value => { const first = value[0]; assert.ok(first); first.toolchain = {}; },
    value => { const first = value.find(candidate => candidate.entry === 'check:ci:product:root'); assert.ok(first); first.toolchain.rustc = 'rustc 1.96.0'; },
    value => { const first = value.find(candidate => candidate.entry === 'check:ci:product:native'); assert.ok(first); first.toolchain.cc = 'different observed compiler'; },
    value => { const first = value[0]?.phases[0]; assert.ok(first); first.code = 1; },
    value => { const first = value[0]?.phases[0]; assert.ok(first); first.tests = []; },
    value => { const first = value[0]?.phases[0]; assert.ok(first); first.unqualifiedRunners = ['opaque installed runner']; },
    value => { const first = value[0]?.phases[0]?.tests[0]; assert.ok(first); first.status = 'skip'; },
    value => { const first = value[0]?.phases[0]?.tests[0]; assert.ok(first); first.ancestry = ['different observed parent']; },
  ];
  const compositeFaults: Array<(value: NonNullable<Receipt['phases'][number]['cms']>) => void> = [
    value => { value.direct.tests.pop(); },
    value => { value.direct.tests.push(value.direct.tests[0]!); },
    value => { value.direct.tests[0]!.status = 'failed'; },
    value => { value.direct.tests[0]!.status = 'skip'; },
    value => { value.direct.tests[0]!.status = 'todo'; },
    value => { value.direct.tests[0]!.suite = 'other-file'; },
    value => { value.direct.tests[0]!.ancestry = ['invented parent']; },
    value => { value.direct.command += ' --test-name-pattern=one'; },
    value => { value.direct.summaries = []; },
    value => { value.direct.code = null; },
    value => { value.direct.signal = 'SIGTERM'; },
    value => { value.direct.timedOut = true; },
    value => { value.direct.before[cmsFile] = '0'.repeat(64); },
    value => { value.direct.after[cmsContract] = '0'.repeat(64); },
    value => { value.exceptions = [{}]; },
    value => { value.mandatory = null; },
    value => { value.mandatory!.code = null; },
    value => { value.mandatory!.code = 1; },
    value => { value.mandatory!.signal = 'SIGTERM'; },
    value => { value.mandatory!.timedOut = true; },
    value => { value.mandatory!.summaries = []; },
    value => { value.mandatory!.summaries = [`Mandatory Node tests: ${contract.required.length + 1} required identities completed or exactly excepted`]; },
    value => { value.mandatory!.command += ' --test-name-pattern=one'; },
    value => { value.mandatory!.after.installedFoundation = '0'.repeat(64); },
  ];
  for (const mutate of compositeFaults) {
    const changed = structuredClone(parallel);
    const phase = changed.find(value => value.entry === 'check:ci:architecture')?.phases.find(value => value.script === 'test:consumer-modules');
    assert.ok(phase?.cms); mutate(phase.cms);
    assert.throws(() => compare(serial, changed));
  }
  for (const mutate of faults) {
    const changed = structuredClone(parallel);
    mutate(changed);
    assert.throws(() => compare(serial, changed));
  }
});


test('public Node reporter retains flat, nested and concurrent identities from actual events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-ci-events-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await Promise.all(['left', 'right'].map(async branch => {
    const file = join(root, `${branch}.test.ts`);
    await writeFile(file, `import { describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
describe('${branch}', { concurrency: true }, () => {
  describe('shared parent', () => { it('same leaf', async () => { await setTimeout(30); }); });
  it('flat sibling', async () => { await setTimeout(1); });
});
it('observed skip', { skip: true }, () => {});
it('observed todo', { todo: true }, () => {});
`);
    return file;
  }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2',
    `--test-reporter=${new URL('./measure.ts', import.meta.url).pathname}`, ...files], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const events: Array<{ name: string; suite: string; ancestry: string[]; status: string }> = result.stdout.split('\n')
    .filter(line => line.startsWith('CI_NODE_EVENT ')).map(line => JSON.parse(line.slice(14)));
  assert.deepEqual(events.filter(event => event.name === 'same leaf').map(event => event.ancestry),
    [['left', 'shared parent'], ['right', 'shared parent']]);
  for (const branch of ['left', 'right']) {
    const observed = events.filter(event => event.suite.endsWith(`/${branch}.test.ts`));
    assert.ok(observed.some(event => event.name === 'flat sibling' && event.ancestry.join('/') === branch && event.status === 'passed'));
    assert.ok(observed.some(event => event.name === 'observed skip' && event.status === 'skip'));
    assert.ok(observed.some(event => event.name === 'observed todo' && event.status === 'todo'));
  }
});

test('strict retained C0 retrieval restores an unreachable object before source execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ar-ci-history-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  const object = '8e5e859d10981e1623d0617e933afc68a9e8770c';
  assert.equal(git('init', '--quiet').status, 0);
  assert.equal(git('remote', 'add', 'origin', new URL('../../', import.meta.url).pathname).status, 0);
  assert.notEqual(git('cat-file', '-e', `${object}^{commit}`).status, 0);
  const lane = parse(await readFile(new URL('../../.github/workflows/ci-lane.yml', import.meta.url), 'utf8')) as {
    jobs: { lane: { steps: Array<{ name?: string; run?: string }> } } };
  const step = lane.jobs.lane.steps.find(value => value.name === 'Retain exact C0 review history before repository code');
  assert.ok(step?.run);
  const run = () => spawnSync('bash', ['-c', step.run!], { cwd: root, env, encoding: 'utf8' });
  assert.equal(run().status, 0, 'pinned local TEST-origin retrieval must succeed');
  assert.equal(git('rev-parse', `${object}^{commit}`).stdout.trim(), object);
  assert.equal(git('cat-file', '-e', `${object}^1^{commit}`).status, 0, 'retained parent history');
  assert.equal(git('fsck', '--connectivity-only', '--no-reflogs', object).status, 0, 'retained tree/blob connectivity');
  assert.equal(run().status, 0, 'present object needs no fetch');
});
