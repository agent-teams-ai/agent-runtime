import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { classifyPrRegressions, supportedPrEnvironment, installationFingerprint } from './pr-regression-inputs.ts';
import type { LeafInventoryComparator } from './pr-regression-inputs.ts';
import { assertPrObligations, foundationNegativeTests, observeRegressionProcess, prObligations } from './pr-regression-command.ts';
import type { Execution, Obligation, ObservedObligation } from './pr-regression-command.ts';
import { validatePrFoundationRoute } from './conformance.ts';
import { admitPublishedComparator, createRetainedSourceCheckout, fixtureOwnerEnvironment, installNodeModulesFixture, testScratch } from './pr-regression-bootstrap-fixtures.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const rc = 'packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/adapters/outbound/codex-configuration-semantic-classifier-v1.ts';
const er = 'packages/apps/embedded-runtime/src/index.ts';
const canary = 'packages/contexts/agent-execution/tests/live/claude-contained-turn-live-canary.mjs';
// Independent source-read census, not imported from the scheduling declaration.
const anchors = [
  'packages/apps/embedded-runtime/src/composition/agent-runtime-host.ts',
  'packages/apps/embedded-runtime/src/features/contained-turn-access-authority/adapters/contained-turn-access-authority.ts',
  'packages/apps/embedded-runtime/src/features/contained-turn-authority-capability/adapters/contained-turn-authority-capability.ts',
  'packages/apps/embedded-runtime/src/features/contained-turn-route-qualification/adapters/contained-turn-route-qualification.ts',
  'packages/apps/embedded-runtime/src/features/trusted-runtime-access-scope/adapters/trusted-runtime-access-scope.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-tls-http-egress-transport-support.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/docker/node-linux-exclusive-route.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-config-wire.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/composition/docker-custodied-provider-process.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-provider-options.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-receipt-identity.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/composition/codex-credential-output-inventory.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/composition/preparation-scope-anti-corruption.ts',
  'packages/contexts/agent-execution/src/features/contained-agent-turn/composition/provider-access-anti-corruption.ts',
  'packages/apps/embedded-runtime/src/composition/contained-turn-feature-composition.ts',
  'packages/contexts/provider-access/src/features/contained-turn-access/adapters/provider-access-data.ts',
];
const trusted = {
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'agent-teams-ai/agent-runtime',
  GITHUB_REF: 'refs/pull/211/merge', GITHUB_WORKFLOW_REF: 'agent-teams-ai/agent-runtime/.github/workflows/ci.yml@refs/pull/211/merge',
  RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24', ImageVersion: '20261004.1',
  PR_REGRESSION_FROZEN_INSTALL: 'verified',
};
const facts = { node: 'v24.21.0', pnpm: '11.18.0', platform: 'linux', arch: 'x64', glibc: '2.39', execArgv: [] as string[] };
let sourceTemplate: Promise<string> | undefined;

async function createSourceTemplate(): Promise<string> {
  const root = await testScratch('ar-pr-regressions-source-TEST-');
  await createRetainedSourceCheckout(root);
  return root;
}

function sourceTemplateRoot(): Promise<string> {
  sourceTemplate ??= createSourceTemplate();
  return sourceTemplate;
}

after(async () => {
  if (sourceTemplate) {await rm(await sourceTemplate, { recursive: true, force: true });}
});

async function fixture(t: test.TestContext) {
  const root = await testScratch('ar-pr-regressions-TEST-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const comparator = await admitPublishedComparator();
  const env = fixtureOwnerEnvironment();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('clone', '--quiet', '--shared', await sourceTemplateRoot(), '.');
  const freeze = () => {
    git('add', '-A');
    const tree = git('write-tree');
    const parent = git('rev-parse', 'HEAD');
    const sha = execFileSync('git', ['commit-tree', tree, '-p', parent], { cwd: root, env, input: 'Disposable TEST snapshot\n', encoding: 'utf8' }).trim();
    git('reset', '--quiet', '--hard', sha);
    return sha;
  };
  const base = freeze();
  const event = (head: string) => ({ number: 211, action: 'synchronize', repository: { full_name: 'agent-teams-ai/agent-runtime' },
    pull_request: { number: 211, base: { sha: base, ref: 'main', repo: { full_name: 'agent-teams-ai/agent-runtime' } },
      head: { sha: head, repo: { full_name: 'agent-teams-ai/agent-runtime', fork: false } } } });
  const plan = (head: string, overrides = {}) => classifyPrRegressions(root, { base, head, event: event(head),
    environment: trusted, runtime: facts, installation: '1'.repeat(64), ...overrides }, comparator);
  const body = async (path: string) => writeFile(join(root, path), `${await readFile(join(root, path), 'utf8')}\n// Disposable TEST body mutation\n`);
  return { root, base, git, freeze, plan, body, event };
}

export function registerPrRegressionTests(): void {
  registerFoundationPrExecutionTests();
  test('the injected pure comparator relation does not grant sampling authority', async () => {
    const comparator = await admitPublishedComparator();
    const base = { version: 1, digestScheme: 'sha256', inputs: [
      { path: 'root.ts', type: 'file', mode: '100644', membership: 'closed', content: 'a'.repeat(64) },
      { path: 'body.ts', type: 'file', mode: '100644', membership: 'structural', content: '1'.repeat(64) },
    ] } as Parameters<LeafInventoryComparator>[0];
    const head = { ...base, inputs: [base.inputs[0]!, { ...base.inputs[1]!, content: '2'.repeat(64) }] } as Parameters<LeafInventoryComparator>[0];
    assert.deepEqual(comparator(base, head, ['body.ts']), { status: 'compatible-inputs', changedContentPaths: ['body.ts'] });
    assert.deepEqual(comparator(base, head, []), { status: 'rejected', reason: 'closed-input-changed' });
  });
  test('real immutable RC and ER body snapshots defer whole regressions with their independent closures', async t => {
    const f = await fixture(t);
    await f.body(rc);
    let head = f.freeze();
    let result = await f.plan(head);
    assert.equal(result.mode, 'affected-pr');
    assert.deepEqual(result.deferred, ['foundation-negative', 'fms', 'cms-regression', 'ci-selftests', 'docs-portable']);
    assert.deepEqual(result.run, []);
    assert.equal(result.scopes?.common, result.scopes?.baseCommon);
    assert.equal(result.scopes?.['ci-selftests'], result.scopes?.['base:ci-selftests']);
    f.git('reset', '--quiet', '--hard', f.base);
    await f.body(er);
    head = f.freeze(); result = await f.plan(head);
    assert.equal(result.mode, 'affected-pr');
    assert.deepEqual(result.deferred, ['foundation-negative', 'fms', 'ci-selftests', 'docs-portable']);
    assert.ok(result.run.includes('cms-regression'));
    f.git('reset', '--quiet', '--hard', f.base);
    await f.body('packages/contexts/runtime-configuration/tests/package/curated-assembly-surface.test.ts');
    result = await f.plan(f.freeze());
    assert.equal(result.mode, 'affected-pr');
    assert.deepEqual(result.run, []);
    assert.ok(result.deferred.includes('ci-selftests'));
  });
  test('validated policy reaches the closed universe census in both immutable snapshots', async t => {
    const fixtureState = await fixture(t);
    fixtureState.git('reset', '--quiet', '--hard', fixtureState.base);
    const policyPath = 'architecture/foundation/ci-pr-regressions.json';
    const policy = JSON.parse(await readFile(join(fixtureState.root, policyPath), 'utf8')) as {
      foundationAnchors: string[]; docsBodyAnchors: string[];
    };
    policy.foundationAnchors[policy.foundationAnchors.length - 1] = 'packages/contexts/runtime-configuration/src/missing-regression-input.ts';
    await writeFile(join(fixtureState.root, policyPath), `${JSON.stringify(policy, null, 2)}\n`);
    const invalidBase = fixtureState.freeze();
    await fixtureState.body(rc);
    const invalidHead = fixtureState.freeze();
    const event = fixtureState.event(invalidHead);
    event.pull_request.base.sha = invalidBase;
    const result = await fixtureState.plan(invalidHead, { base: invalidBase, event });
    assert.equal(result.mode, 'full');
    assert.match(result.reason, /missing regression input/u);
  });
  test('every one of the sixteen actual Foundation body anchors runs the entire negative obligation', async t => {
    const f = await fixture(t);
    for (const anchor of anchors) {
      f.git('reset', '--quiet', '--hard', f.base);
      await f.body(anchor);
      const result = await f.plan(f.freeze());
      assert.equal(result.mode, 'affected-pr', anchor);
      assert.ok(result.run.includes('foundation-negative'), anchor);
      assert.ok(!result.deferred.includes('foundation-negative'), anchor);
    }
  });
  test('AE live canary bytes select all five portable scenarios without launching the canary', async t => {
    const f = await fixture(t); await f.body(canary);
    const result = await f.plan(f.freeze());
    assert.equal(result.mode, 'affected-pr');
    assert.ok(result.run.includes('docs-portable'));
  });
  test('complete Git membership, common bytes and file kinds conservatively force FULL', async t => {
    const f = await fixture(t);
    const mutations: Array<[string, () => Promise<unknown>]> = [
      ['common', () => f.body('scripts/ci/policy.ts')],
      ['CI helper', () => f.body('scripts/ci/pr-regression-command.ts')],
      ['CI tests', () => f.body('scripts/ci/contracts.test.ts')],
      ['live conformance', () => f.body('scripts/ci/conformance.ts')],
      ['actual ER runner anchor', () => f.body('packages/apps/embedded-runtime/scripts/run-package-tests.mjs')],
      ['workflow', () => f.body('.github/workflows/ci-lane.yml')],
      ['regression policy', () => f.body('architecture/foundation/ci-pr-regressions.json')],
      ['frozen install input', () => f.body('pnpm-lock.yaml')],
      ['profile', () => f.body('architecture/feature-module-standard/candidate-profile.json')],
      ['manifest', () => f.body('packages/contexts/runtime-configuration/package.json')],
      ['toolchain', () => f.body('packages/contexts/runtime-configuration/tsconfig.json')],
      ['instruction', () => f.body('AGENTS.md')],
      ['add', () => writeFile(join(f.root, dirname(rc), 'extra.ts'), 'export {};\n')],
      ['delete', () => rm(join(f.root, rc))],
      ['mode', () => chmod(join(f.root, rc), 0o755)],
      ['symlink', async () => { await rm(join(f.root, rc)); await symlink('other.ts', join(f.root, rc)); }],
      ['new package', async () => { await mkdir(join(f.root, 'packages/contexts/new-root')); await writeFile(join(f.root, 'packages/contexts/new-root/package.json'), '{}\n'); }],
      ['nested marker', () => writeFile(join(f.root, dirname(rc), 'package.json'), '{}\n')],
      ['newline name', () => writeFile(join(f.root, dirname(rc), 'odd\nname.ts'), 'export {};\n')],
    ];
    for (const [name, mutate] of mutations) {
      f.git('reset', '--quiet', '--hard', f.base); f.git('clean', '-fdq'); await mutate();
      const result = await f.plan(f.freeze());
      assert.equal(result.mode, 'full', name);
      assert.deepEqual(result.deferred, [], name);
      assert.ok(result.run.includes('ci-selftests'), name);
    }
  });
  test('missing or malformed SHAs, events, worktree bytes and ambient facts never authorize deferral', async t => {
    const f = await fixture(t); await f.body(rc); const head = f.freeze();
    const overrides = [
      { base: 'main' }, { head: '0'.repeat(40) }, { head: f.base }, { event: {} },
      { event: { ...f.event(head), action: 'closed' } }, { installation: undefined },
      { environment: { ...trusted, GITHUB_EVENT_NAME: 'merge_group' } },
      ...['push', 'schedule', 'workflow_dispatch', 'workflow_call'].map(GITHUB_EVENT_NAME => ({ environment: { ...trusted, GITHUB_EVENT_NAME } })),
      { environment: { ...trusted, PR_REGRESSION_FROZEN_INSTALL: '' } },
      { environment: { ...trusted, NODE_OPTIONS: '--import=evil.mts' } },
      { environment: { ...trusted, NAPI_RS_NATIVE_LIBRARY_PATH: '/tmp/override.node' } },
      // CI selftests read these inherited fixture/observation inputs. Before
      // deferral they must refuse overrides, including formerly admitted empty
      // baseline/fixture values that differ from absence under ?? / undefined.
      ...['CI_ER_BASELINE_REPORTER', 'CI_ER_PROCESS_PLANS', 'AE_ADOPTION_CAPTURE_DIR', 'CI_FOCUSED_EVIDENCE_DIR', 'FIXTURE_OWNER']
        .flatMap(key => ['TEST override', ''].map(value => ({ environment: { ...trusted, [key]: value } }))),
      { environment: { ...trusted, RUNNER_ENVIRONMENT: 'self-hosted' } },
      { runtime: { ...facts, glibc: '' } }, { runtime: { ...facts, execArgv: ['--import=evil.mts'] } },
    ];
    for (const value of overrides) {assert.equal((await f.plan(head, value)).mode, 'full', JSON.stringify(value));}
    // Create an actual pre-adoption TEST snapshot; the repository's current
    // parent may already contain this policy after it has been committed.
    f.git('reset', '--quiet', '--hard', f.base);
    const policyFile = 'architecture/foundation/ci-pr-regressions.json';
    await rm(join(f.root, policyFile));
    const predecessor = f.freeze();
    await cp(join(repository, policyFile), join(f.root, policyFile));
    await f.body(rc);
    const firstPolicyHead = f.freeze();
    const firstPolicyEvent = f.event(firstPolicyHead); firstPolicyEvent.pull_request.base.sha = predecessor;
    assert.equal((await f.plan(firstPolicyHead, { base: predecessor, event: firstPolicyEvent })).mode, 'full', 'first policy PR runs FULL');
    f.git('reset', '--quiet', '--hard', head);
    await f.body(rc); assert.equal((await f.plan(head)).mode, 'full', 'dirty actual checkout');
    assert.equal(supportedPrEnvironment(trusted, facts), true);
    assert.equal(supportedPrEnvironment({ ...trusted, npm_config_node_options: '--require=evil' }, facts), false);
  });
  // Old: the quick route exposes only pnpm test:ci, so it cannot defer the
  // unchanged regression while retaining live conformance. New: both original
  // commands are independent obligations, with conformance always executed.
  test('complete quick obligations retain live conformance and reject deferred execution or passes', () => {
    const expected: Obligation[] = [
      { id: 'lint', command: 'pnpm lint' },
      { id: 'check:node-compat', command: 'pnpm check:node-compat' },
      { id: 'typecheck:ci', command: 'pnpm typecheck:ci' },
      { id: 'ci-selftests', command: 'node --test scripts/ci/contracts.test.ts', regression: 'ci-selftests' },
      { id: 'ci-conformance', command: 'node scripts/ci/conformance.ts' },
    ];
    assert.deepEqual(prObligations('quick'), expected);
    // Explicit unit receipt; this is validation of dispositions, not execution
    // qualification of lint/typecheck or a claim that these commands passed.
    const observed: ObservedObligation[] = expected.map(item => item.regression
      ? { ...item, disposition: 'deferred-unchanged-regression-inputs', tests: [] }
      : { ...item, disposition: 'executed', execution: { code: 0, signal: null, tests: [], mandatory: [] } });
    assertPrObligations(expected, observed, ['ci-selftests']);
    assert.throws(() => assertPrObligations(expected, observed.slice(0, -1), ['ci-selftests']));
    const lost = structuredClone(observed);
    Object.assign(lost.at(-1)!, { disposition: 'deferred-unchanged-regression-inputs', regression: 'ci-selftests', tests: [] });
    assert.throws(() => assertPrObligations(expected, lost, ['ci-selftests']));
    for (const invented of [{ tests: [{ name: 'invented pass', status: 'passed' }] }, { passed: 1 }, { execution: { code: 0 } }]) {
      const proof = structuredClone(observed); Object.assign(proof[3]!, invented);
      assert.throws(() => assertPrObligations(expected, proof, ['ci-selftests']));
    }
    assert.throws(() => assertPrObligations(expected, observed, []), /unadmitted deferral/u);
  });
  // Old: there is no live conformance obligation outside the combined test:ci
  // process. New: observe the actual standalone process and reject its failure.
  test('actual current conformance remains blocking when the CI selftests defer', async t => {
    const f = await fixture(t);
    await installNodeModulesFixture(f.root, 'linked', f.root);
    const obligation = prObligations('quick').find(item => item.id === 'ci-conformance');
    assert.deepEqual(obligation, { id: 'ci-conformance', command: 'node scripts/ci/conformance.ts' });
    assert.ok(obligation);
    const execution = await observeRegressionProcess(obligation.command, f.root, process.env);
    assert.equal(execution.code, 0);
    assertPrObligations([obligation], [{ ...obligation, disposition: 'executed', execution }], ['ci-selftests']);
    await writeFile(join(f.root, '.node-version'), '26.10.0\n');
    const failed = await observeRegressionProcess(obligation.command, f.root, process.env);
    assert.notEqual(failed.code, 0);
    assert.throws(() => assertPrObligations([obligation], [{ ...obligation, disposition: 'executed', execution: failed }], ['ci-selftests']));
  });
  test('the actual Foundation routing aggregate rejects failed, skipped, cancelled, missing and duplicate routes', async t => {
    const root = await testScratch('ar-pr-route-TEST-'); t.after(() => rm(root, { recursive: true, force: true }));
    const route = parse(await readFile(join(repository, '.github/workflows/ci-foundation-route.yml'), 'utf8')) as {
      jobs: { aggregate: { steps: Array<{ run: string }> } } };
    const pr = parse(await readFile(join(repository, '.github/workflows/ci-pr-regressions.yml'), 'utf8'));
    validatePrFoundationRoute(route, pr);
    const shell = route.jobs.aggregate.steps[0]!.run;
    const invoke = (needs: unknown, selected: boolean) => spawnSync('bash', ['-c', shell], { cwd: root,
      env: { ...process.env, NEEDS: JSON.stringify(needs), PR_ROUTE: String(selected) }, encoding: 'utf8' }).status;
    for (const selected of [true, false]) {
      const active = selected ? 'pr' : 'full', inactive = selected ? 'full' : 'pr';
      const good = { [active]: { result: 'success' }, [inactive]: { result: 'skipped' } };
      assert.equal(invoke(good, selected), 0);
      for (const result of ['failure', 'cancelled', 'skipped', 'unknown', undefined]) {
        assert.notEqual(invoke({ ...good, [active]: { result } }, selected), 0);
      }
      assert.notEqual(invoke({ [active]: good[active] }, selected), 0);
      assert.notEqual(invoke({ ...good, duplicate: { result: 'success' } }, selected), 0);
      assert.notEqual(invoke({ ...good, [inactive]: { result: 'success' } }, selected), 0);
    }
    assert.ok(prObligations('architecture').some(item => item.command === 'node --test scripts/architecture/check-cms-pin.test.mjs'));
    assert.ok(prObligations('architecture').some(item => item.command === 'agent-teams-node-test --contract architecture/foundation/mandatory-node-tests.json -- scripts/architecture/check-cms-pin.test.mjs'));
    assert.deepEqual(prObligations('docs').map(item => item.id), ['docs:protocol:check', 'docs:qualification:typecheck', 'docs:qualification:serial', 'docs-portable']);
  });
  test('current installed executable bytes, link targets and modes are actually fingerprinted', async t => {
    const root = await testScratch('ar-pr-installed-TEST-'); t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'node_modules/.pnpm/tool/node_modules/tool'), { recursive: true });
    const file = join(root, 'node_modules/.pnpm/tool/node_modules/tool/run.mts'); await writeFile(file, 'export {};\n');
    const before = await installationFingerprint(root);
    await writeFile(file, 'throw Error("TEST changed executable");\n');
    assert.notEqual(await installationFingerprint(root), before);
    await chmod(file, 0o755); assert.notEqual(await installationFingerprint(root), before);
    await symlink('/outside/unqualified', join(root, 'node_modules/unqualified'));
    await assert.rejects(installationFingerprint(root));
  });
  test('actual failed, skipped, todo and cancelled Node execution and duplicate obligations cannot green a PR receipt', async t => {
    const root = await testScratch('ar-pr-execution-TEST-'); t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'observed.test.ts');
    const command = `node --test ${file}`;
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    await writeFile(file, "import test from 'node:test'; test('observed obligation', () => {});\n");
    const green = await observeRegressionProcess(command, root, env);
    assertPrObligations([{ id: 'real', command }], [{ id: 'real', command, disposition: 'executed', execution: green }], []);
    for (const source of ["test('failed', () => { throw Error('TEST failure'); });", "test('skipped', { skip: true }, () => {});",
      "test('todo', { todo: true }, () => {});", "test('cancelled', { timeout: 20 }, async () => await new Promise(() => {}));"]) {
      await writeFile(file, `import test from 'node:test'; ${source}\n`);
      const observed = await observeRegressionProcess(command, root, env);
      assert.throws(() => assertPrObligations([{ id: 'real', command }], [{ id: 'real', command, disposition: 'executed', execution: observed }], []));
    }
    const proof = { id: 'real', command, disposition: 'executed' as const, execution: green };
    assert.throws(() => assertPrObligations([{ id: 'real', command }], [proof, proof], []));
    await writeFile(file, "import test from 'node:test'; test('duplicate identity', () => {}); test('duplicate identity', () => {});\n");
    const duplicate = await observeRegressionProcess(command, root, env);
    assert.equal(duplicate.code, 0, 'Node permits duplicate names; the PR obligation contract rejects them');
    assert.throws(() => assertPrObligations([{ id: 'real', command }], [{ ...proof, execution: duplicate }], []));
    assert.throws(() => assertPrObligations([{ id: 'real', command }], [{ id: 'real', command, disposition: 'deferred-unchanged-regression-inputs', tests: [] }], []));
    const unsupported = spawnSync(process.execPath, [join(repository, 'scripts/ci/pr-regression-command.ts')], { env, encoding: 'utf8' });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /pre-import source admission/u);
  });
}

async function foundationExecutionFixture(t: test.TestContext): Promise<string> {
  const root = await testScratch('ar-pr-foundation-execution-TEST-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ['scripts/architecture/source-dependency-adapter-boundaries.test.mjs',
    'scripts/docs/runtime-builtin-permissions.test.mjs', 'scripts/ci/run-ordinary-postgres.test.mjs'];
  await mkdir(join(root, 'scripts/ci'), { recursive: true });
  await cp(join(repository, 'scripts/ci/foundation-fixture-sharding.ts'), join(root, 'scripts/ci/foundation-fixture-sharding.ts'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {
    'foundation:boundaries:negative': `node --test ${files.join(' ')}`,
  } }));
  for (const [index, file] of files.entries()) {
    const original = await readFile(join(repository, file), 'utf8');
    const names = original.split('\n').filter(line => line.startsWith(index === 0 ? '  test("' : 'test("'))
      .map(line => JSON.parse(line.slice(line.indexOf('"'), line.indexOf('",') + 1)) as string);
    assert.equal(names.length, [25, 5, 3][index]);
    await mkdir(join(root, dirname(file)), { recursive: true });
    // Generated data at the immutable original .mjs paths exercises the real
    // selector/Node stream boundary without repeating installed CLI qualification.
    const leaves = names.map(name => `${index === 0 ? '  ' : ''}test(${JSON.stringify(name)}, () => {});`).join('\n');
    const source = index === 0
      ? `import { describe } from 'node:test';\nimport { fixtureRegistration } from '../ci/foundation-fixture-sharding.ts';\n`
        + `const fixtures = fixtureRegistration(process.env); const test = fixtures.test;\n`
        + `describe('installed Foundation adapter boundary checks', () => {\n${leaves}\nfixtures.finish();\n});\n`
      : `import test from 'node:test';\n${leaves}\n`;
    await writeFile(join(root, file), source);
  }
  return root;
}

test('CLI forwarding of repeated fixture names preserves success and still rejects a failed child', async t => {
  const root = await testScratch('ar-cli-forwarding-TEST-'); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'repeated.test.ts'), wrapper = join(root, 'forward.mts');
  await writeFile(file, "import test from 'node:test'; test('repeat', () => {}); test('repeat', () => {});\n");
  await writeFile(wrapper, "import {spawnSync} from 'node:child_process';\n"
    + "const result = spawnSync(process.execPath, ['--test', process.argv[2]!], {stdio:'inherit'}); process.exitCode = result.status ?? 1;\n");
  const command = `node ${wrapper} ${file}`, env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const execution = await observeRegressionProcess(command, root, env);
  assert.equal(execution.code, 0); assert.deepEqual(execution.tests.map(item => item.name), ['repeat', 'repeat']);
  const expected = [{ id: 'cli', command }], proof = { ...expected[0]!, disposition: 'executed' as const, execution };
  assertPrObligations(expected, [proof], []);
  await writeFile(file, "import test from 'node:test'; test('repeat', () => {}); test('repeat', () => { throw Error('TEST child failure'); });\n");
  const failed = await observeRegressionProcess(command, root, env);
  assert.notEqual(failed.code, 0);
  assert.throws(() => assertPrObligations(expected, [{ ...proof, execution: failed }], []));
});

function registerFoundationPrExecutionTests(): void {
  // Old failure: zero-exit FULL accepted 9/25 leaves because the other sixteen
  // were never registered. Observe the original command once, then independently
  // corrupt that real proof; no shard-helper name table supplies expectations.
  test('serial PR Foundation execution clears unsupported selectors and closes every original leaf and summary', async t => {
    const override = { FOUNDATION_FIXTURE_PROTOCOL: 'foundation-fixtures/1', FOUNDATION_FIXTURE_INDEX: '0', FOUNDATION_FIXTURE_COUNT: '3' };
    const f = await fixture(t); await f.body(rc); const head = f.freeze();
    assert.equal((await f.plan(head, { environment: { ...trusted, ...override } })).mode, 'full');
    const expected = prObligations('foundation').filter(item => item.regression === 'foundation-negative');
    const executionRoot = await foundationExecutionFixture(t);
    const required = await foundationNegativeTests(executionRoot);
    const execution = await observeRegressionProcess(expected[0]!.command, executionRoot, { ...process.env, ...override });
    const validate = (proof: Execution, oracle = required) => assertPrObligations(expected,
      [{ ...expected[0]!, disposition: 'executed', execution: proof }], [], oracle);
    validate(execution);
    assert.equal(execution.tests.filter(item => item.kind === 'test' && item.depth === 1).length, 25);
    assert.equal(execution.tests.filter(item => item.kind === 'test' && item.depth === 0).length, 8);
    assert.equal(execution.code, 0); assert.equal(execution.signal, null);
    assert.deepEqual(override, { FOUNDATION_FIXTURE_PROTOCOL: 'foundation-fixtures/1', FOUNDATION_FIXTURE_INDEX: '0', FOUNDATION_FIXTURE_COUNT: '3' }, 'caller environment remains owned by caller');
    const partial = structuredClone(execution);
    let position = 0;
    partial.tests = partial.tests.filter(item => item.kind !== 'test' || item.depth === 0 || position++ % 3 === 0);
    partial.nodeSummaries![0]!.counts.tests = 17; partial.nodeSummaries![0]!.counts.passed = 17;
    assert.throws(() => validate(partial), /original Foundation test execution/u, 'green 9/25 plus eight other tests rejects independently');
    const leaf = (proof: Execution) => proof.tests.find(item => item.kind === 'test' && item.suite === required[0]!.suite)!;
    const mutations: Array<(proof: Execution) => void> = [
      proof => { proof.tests.splice(proof.tests.indexOf(leaf(proof)), 1); },
      proof => { leaf(proof).name += ' mutated'; },
      proof => { leaf(proof).suite = 'wrong-original.test.mjs'; },
      proof => { leaf(proof).ancestry = ['wrong parent']; },
      proof => { leaf(proof).kind = 'suite'; },
      proof => { leaf(proof).depth = 0; },
      proof => { proof.tests.push(structuredClone(leaf(proof))); },
      proof => { proof.tests = proof.tests.filter(item => item.kind !== 'suite'); },
      proof => { delete proof.nodeSummaries; },
      proof => { proof.nodeSummaries = []; },
      proof => { proof.nodeSummaries!.push(structuredClone(proof.nodeSummaries![0]!)); },
      proof => { proof.nodeSummaries![0]!.success = false; },
      proof => { Object.assign(proof.nodeSummaries![0]!.counts, { failed: 1 }); },
      proof => { proof.code = 1; },
      proof => { proof.signal = 'SIGTERM'; },
    ];
    for (const key of ['tests', 'passed', 'suites', 'cancelled', 'skipped', 'todo', 'topLevel'] as const) {
      mutations.push(proof => { proof.nodeSummaries![0]!.counts[key]++; });
    }
    for (const status of ['failed', 'skip', 'todo', 'cancelled']) {mutations.push(proof => { leaf(proof).status = status; });}
    for (const mutate of mutations) {
      const proof = structuredClone(execution); mutate(proof); assert.throws(() => validate(proof));
    }
    for (const suite of new Set(required.filter(item => item.kind === 'test').map(item => item.suite))) {
      const proof = structuredClone(execution);
      const index = proof.tests.findIndex(item => item.suite === suite && item.kind === 'test');
      proof.tests.splice(index, 1); assert.throws(() => validate(proof), /original Foundation test execution/u);
    }
    assert.throws(() => assertPrObligations(expected, [{ ...expected[0]!, disposition: 'executed', execution }], []),
      /independent original Foundation registrations/u, 'exit zero alone cannot qualify Foundation');
    const deferred = [{ ...expected[0]!, disposition: 'deferred-unchanged-regression-inputs' as const, tests: [] as [] }];
    assertPrObligations(expected, deferred, ['foundation-negative']);

    // Missing/duplicate source registrations must fail the independent census.
    // A source-name mutant with the right count must reject the unchanged proof.
    const root = await testScratch('ar-pr-originals-TEST-'); t.after(() => rm(root, { recursive: true, force: true }));
    const originalFiles = new Set(required.filter(item => item.depth === 0).map(item => item.suite));
    for (const suite of originalFiles) {
      await mkdir(join(root, dirname(suite)), { recursive: true }); await cp(join(executionRoot, suite), join(root, suite));
    }
    for (const suite of originalFiles) {
      const original = await readFile(join(root, suite), 'utf8');
      const registrations = [...original.matchAll(/^ *test\("([^"]+)",/gmu)];
      await writeFile(join(root, suite), original.replace(registrations[0]![0], '  omittedRegistration('));
      await assert.rejects(foundationNegativeTests(root), /incomplete original Foundation registrations/u);
      await writeFile(join(root, suite), original.replace(registrations[1]![0], registrations[0]![0]));
      await assert.rejects(foundationNegativeTests(root), /duplicate original Foundation registration/u);
      await writeFile(join(root, suite), original.replace(registrations[0]![0],
        registrations[0]![0].replace(registrations[0]![1]!, 'independent original name mutant')));
      const mutated = await foundationNegativeTests(root);
      assert.throws(() => validate(execution, mutated), /original Foundation test execution/u);
      await writeFile(join(root, suite), original);
    }
    const manifest = JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    manifest.scripts['foundation:boundaries:negative'] += ' --test-name-pattern=one';
    await writeFile(join(f.root, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(observeRegressionProcess(expected[0]!.command, f.root, process.env), /original three-file Foundation command drift/u);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {registerPrRegressionTests();}
