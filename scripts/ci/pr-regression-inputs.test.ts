import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { classifyPrRegressions, supportedPrEnvironment, installationFingerprint } from './pr-regression-inputs.ts';
import { assertPrObligations, observeRegressionProcess, prObligations } from './pr-regression-command.ts';
import { validatePrFoundationRoute } from './conformance.ts';

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

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ar-pr-regressions-TEST-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'TEST', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'TEST', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('clone', '--quiet', '--shared', repository, '.');
  // Seed the new common policy at both immutable TEST revisions. First adoption
  // is tested separately; these fixtures model the next package-only PR.
  for (const path of ['architecture/foundation/ci-pr-regressions.json', 'architecture/foundation/source-dependencies.yaml',
    'scripts/ci/pr-regression-inputs.ts', 'scripts/ci/pr-regression-inputs.test.ts', 'scripts/ci/pr-regression-command.ts',
    '.github/workflows/ci-foundation-route.yml', '.github/workflows/ci-pr-regressions.yml']) {
    await cp(join(repository, path), join(root, path));
  }
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
    environment: trusted, runtime: facts, installation: '1'.repeat(64), ...overrides });
  const body = async (path: string) => writeFile(join(root, path), `${await readFile(join(root, path), 'utf8')}\n// Disposable TEST body mutation\n`);
  return { root, base, git, freeze, plan, body, event };
}

export function registerPrRegressionTests(): void {
  test('real immutable RC and ER body snapshots defer whole regressions with their independent closures', async t => {
    const f = await fixture(t);
    await f.body(rc);
    let head = f.freeze();
    let result = await f.plan(head);
    assert.equal(result.mode, 'affected-pr');
    assert.deepEqual(result.deferred, ['foundation-negative', 'fms', 'cms-regression', 'docs-portable']);
    assert.equal(result.run.includes('ci-selftests'), true, 'scope-reading classifier tests stay current');
    f.git('reset', '--quiet', '--hard', f.base);
    await f.body(er);
    head = f.freeze(); result = await f.plan(head);
    assert.equal(result.mode, 'affected-pr');
    assert.deepEqual(result.deferred, ['foundation-negative', 'fms', 'docs-portable']);
    assert.ok(result.run.includes('cms-regression'));
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
      assert.equal((await f.plan(f.freeze())).mode, 'full', name);
    }
  });
  test('missing or malformed SHAs, events, worktree bytes and ambient facts never authorize deferral', async t => {
    const f = await fixture(t); await f.body(rc); const head = f.freeze();
    const overrides = [
      { base: 'main' }, { head: '0'.repeat(40) }, { head: f.base }, { event: {} },
      { event: { ...f.event(head), action: 'closed' } }, { installation: undefined },
      { environment: { ...trusted, GITHUB_EVENT_NAME: 'merge_group' } },
      { environment: { ...trusted, NODE_OPTIONS: '--import=evil.mts' } },
      { environment: { ...trusted, NAPI_RS_NATIVE_LIBRARY_PATH: '/tmp/override.node' } },
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
  test('the actual Foundation routing aggregate rejects failed, skipped, cancelled, missing and duplicate routes', async t => {
    const root = await mkdtemp(join(tmpdir(), 'ar-pr-route-TEST-')); t.after(() => rm(root, { recursive: true, force: true }));
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
    const root = await mkdtemp(join(tmpdir(), 'ar-pr-installed-TEST-')); t.after(() => rm(root, { recursive: true, force: true }));
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
    const root = await mkdtemp(join(tmpdir(), 'ar-pr-execution-TEST-')); t.after(() => rm(root, { recursive: true, force: true }));
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
    const unsupported = spawnSync(process.execPath, [join(repository, 'scripts/ci/pr-regression-command.ts'), 'unknown'], { env, encoding: 'utf8' });
    assert.notEqual(unsupported.status, 0);
  });
}
