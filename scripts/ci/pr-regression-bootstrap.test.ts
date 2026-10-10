import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { installationMetadataMaxBytes, parseInstallationMetadata } from './pr-regression-bootstrap.ts';
import {
  actualMeasureFixture,
  copySourceTree,
  regressionGraphTestName,
  runActualMeasureGraph,
  runActualRegressionImportGraph,
  runFixtureBootstrapAdmission,
  runFixtureOptimizerComparison,
  testScratch,
} from './pr-regression-bootstrap-fixtures.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const bodyPath = 'packages/contexts/runtime-configuration/src/features/bootstrap-body.ts';
const fixturePath = 'scripts/sdk-growth-source/fixtures/pr-regression-bootstrap.txt';
type Mutation = 'none' | 'body' | 'bootstrap' | 'helper' | 'config' | 'lock' | 'fixture' | 'installed' | 'add' | 'delete' | 'mode' | 'symlink'
  | 'worktree-file' | 'worktree-link' | 'incomplete-census' | 'push-tuple' | 'base-tuple' | 'merge-tuple';
type Optimizer = 'valid' | 'absent' | 'manifest' | 'marker' | 'mode' | 'extra' | 'foreign-link';
type ModulesMetadata = 'real' | 'yaml' | 'wrong-manager' | 'wrong-layout' | 'malformed' | 'oversized' | 'duplicate-identity'
  | 'escaped-identity-shadow' | 'duplicate-layout' | 'escaped-layout' | 'duplicate-nested-identity' | 'duplicate-nested-layout'
  | 'virtual-store-only' | 'escaped-virtual-store-only-shadow' | 'symlink';

async function modulesFixtureBytes(modules: ModulesMetadata): Promise<Buffer> {
  const realModules = await readFile(process.env.TEST_PNPM_MODULES_FIXTURE ?? join(repository, 'node_modules/.modules.yaml'));
  parseInstallationMetadata(realModules);
  const parsedModules = JSON.parse(realModules.toString('utf8')) as Record<string, unknown>;
  switch (modules) {
    case 'real': case 'symlink': return realModules;
    case 'yaml': return Buffer.from('packageManager: pnpm@11.18.0\nvirtualStoreDir: .pnpm\n');
    case 'wrong-manager': return Buffer.from(JSON.stringify({ ...parsedModules, packageManager: 'pnpm@11.17.0' }));
    case 'wrong-layout': return Buffer.from(JSON.stringify({ ...parsedModules, virtualStoreDir: 'node_modules/.pnpm' }));
    case 'malformed': return Buffer.concat([realModules, Buffer.from('\n// TEST malformed JSON\n')]);
    case 'oversized': return Buffer.from(JSON.stringify({ ...parsedModules, padding: 'x'.repeat(installationMetadataMaxBytes) }));
    case 'duplicate-identity': return Buffer.from('{"packageManager":"pnpm@11.18.0","packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm"}');
    case 'escaped-identity-shadow': return Buffer.from('{"packageManager":"pnpm@11.17.0","package\\u004danager":"pnpm@11.18.0","virtualStoreDir":".pnpm"}');
    case 'duplicate-layout': return Buffer.from('{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","virtualStoreDir":".pnpm"}');
    case 'escaped-layout': return Buffer.from('{"packageManager":"pnpm@11.18.0","virtualStoreDir":"wrong","virtual\\u0053toreDir":".pnpm"}');
    case 'duplicate-nested-identity': return Buffer.from('{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","nested":{"packageManager":"pnpm@11.18.0"}}');
    case 'duplicate-nested-layout': return Buffer.from('{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","nested":{"virtualStoreDir":".pnpm"}}');
    case 'virtual-store-only': return Buffer.from(JSON.stringify({ ...parsedModules, virtualStoreOnly: true }));
    case 'escaped-virtual-store-only-shadow': return Buffer.from('{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","virtualStoreOnly":false,"virtual\\u0053toreOnly":false}');
  }
}

async function workflowBootstrapShell(): Promise<string> {
  const workflow = parse(await readFile(join(repository, '.github/workflows/ci-lane.yml'), 'utf8')) as {
    jobs?: { lane?: { steps?: Array<{ name?: unknown; shell?: unknown; run?: unknown }> } };
  };
  const step = workflow.jobs?.lane?.steps?.find(candidate => candidate.name === 'Execute current-source PR obligations and whole regression decisions');
  assert.ok(step && (step.shell === undefined || step.shell === 'bash') && typeof step.run === 'string', 'exact workflow bootstrap shell');
  return step.run;
}

interface WorkflowFixture { root: string; evidence: string; shell: string; env: NodeJS.ProcessEnv }

async function workflowSourceFixture(t: test.TestContext,
  mutation: 'missing' | 'syntax' | 'early-success' | 'clean-filter-early-success'): Promise<WorkflowFixture> {
  const root = await testScratch('ar-pr-workflow-TEST-');
  const evidence = `${root}-evidence`, temporary = `${root}-tmp`;
  await Promise.all([mkdir(join(root, 'scripts/ci'), { recursive: true }), mkdir(evidence), mkdir(temporary)]);
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(evidence, { recursive: true, force: true }), rm(temporary, { recursive: true, force: true })]));
  const bootstrapPath = join(root, 'scripts/ci/pr-regression-bootstrap.ts');
  const fullMarker = join(evidence, 'full-ran'), bootstrapMarker = join(evidence, 'bootstrap-ran');
  const fakeFullMarker = join(evidence, 'fake-full-ran');
  const measure = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(fullMarker)}, 'current-full\\n');\n`
    + `writeFileSync(${JSON.stringify(join(evidence, 'full-env.json'))}, JSON.stringify({protocol: process.env.FOUNDATION_FIXTURE_PROTOCOL ?? null, index: process.env.FOUNDATION_FIXTURE_INDEX ?? null, count: process.env.FOUNDATION_FIXTURE_COUNT ?? null}));\n`
    + `process.exitCode = Number(process.env.TEST_FULL_EXIT ?? '0');\n`;
  const admitted = `export {};\n`;
  const earlySuccess = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(bootstrapMarker)}, 'executed\\n');\nwriteFileSync(${JSON.stringify(fakeFullMarker)}, 'fake-full\\n');\n`;
  await writeFile(join(root, 'scripts/ci/measure.ts'), measure);
  await writeFile(bootstrapPath, admitted);
  if (mutation === 'clean-filter-early-success') {
    await writeFile(join(root, '.gitattributes'), 'scripts/ci/pr-regression-bootstrap.ts filter=trusted-bootstrap\n');
    await writeFile(join(root, 'clean-bootstrap'),
      `#!/bin/sh\ncat ${JSON.stringify(join(root, 'trusted-bootstrap.ts'))}\n`);
    await chmod(join(root, 'clean-bootstrap'), 0o755);
    await writeFile(join(root, 'trusted-bootstrap.ts'), admitted);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = (message: string) => {
    git('add', '-A');
    const tree = git('write-tree');
    return execFileSync('git', ['commit-tree', tree], { cwd: root,
      env: { GIT_AUTHOR_NAME: 'TEST', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'TEST', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
      input: message, encoding: 'utf8' }).trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'TEST');
  git('config', 'user.email', 'test@example.invalid');
  if (mutation === 'clean-filter-early-success') {
    git('config', 'filter.trusted-bootstrap.clean', `sh ${join(root, 'clean-bootstrap')}`);
  }
  const base = commit('Disposable TEST workflow base\n');
  if (mutation === 'early-success' || mutation === 'clean-filter-early-success') {await writeFile(bootstrapPath, earlySuccess);}
  const head = commit('Disposable TEST workflow head\n');
  if (mutation === 'missing') {await rm(bootstrapPath);}
  if (mutation === 'syntax') {
    await writeFile(bootstrapPath, `${earlySuccess}\nthis is not valid TypeScript syntax;\n`);
  }
  return {
    root,
    evidence,
    shell: await workflowBootstrapShell(),
    env: {
      PATH: process.env.PATH, TMPDIR: temporary, EXPECTED_BASE_REVISION: base, EXPECTED_REVISION: head,
      PR_REGRESSION_GROUP: 'quick', TEST_FULL_EXIT: '23', TEST_FULL_MARKER: fullMarker,
      FOUNDATION_FIXTURE_PROTOCOL: 'foundation-fixtures/1', FOUNDATION_FIXTURE_INDEX: '0', FOUNDATION_FIXTURE_COUNT: '3',
    },
  };
}

async function foundationRegistrationCensus(root: string): Promise<string[]> {
  const files = ['scripts/architecture/source-dependency-adapter-boundaries.test.mjs',
    'scripts/docs/runtime-builtin-permissions.test.mjs', 'scripts/ci/run-ordinary-postgres.test.mjs'] as const;
  const census: string[] = [];
  for (const [index, path] of files.entries()) {
    const source = await readFile(join(root, path), 'utf8');
    const pattern = index === 0 ? /^  test\("([^"]+)",/gmu : /^test\("([^"]+)",/gmu;
    census.push(...[...source.matchAll(pattern)].map(match => match[1]!));
  }
  assert.deepEqual(census.length, 33, 'original complete Foundation registration census');
  assert.equal(new Set(census).size, census.length, 'original Foundation registration names remain unique');
  return census;
}

function plainFoundationSuite(names: readonly string[]): string {
  return `import assert from 'node:assert/strict';\n`
    + `import test from 'node:test';\n`
    + `for (const name of ${JSON.stringify(names)}) test(name, () => assert.ok(true));\n`;
}

async function writeFoundationFixture(root: string, census: readonly string[], failureName: string): Promise<void> {
  const boundaryNames = census.slice(0, 25), docsNames = census.slice(25, 30), postgresNames = census.slice(30);
  const boundary = `import assert from 'node:assert/strict';\n`
    + `import { describe } from 'node:test';\n`
    + `import { fixtureRegistration } from '../ci/foundation-fixture-sharding.ts';\n`
    + `const fixtures = fixtureRegistration(process.env);\n`
    + `describe('installed Foundation adapter boundary checks', { concurrency: 2 }, () => {\n`
    + `  for (const name of ${JSON.stringify(boundaryNames)}) {\n`
    + `    fixtures.test(name, async () => {\n`
    + `      if (name === ${JSON.stringify(failureName)}) throw new Error('TEST shard0-excluded Foundation leaf failure');\n`
    + `      assert.ok(true);\n`
    + `    });\n`
    + `  }\n`
    + `  const registration = fixtures.finish();\n`
    + `  if (registration) console.log(registration);\n`
    + `});\n`;
  await writeFile(join(root, 'scripts/architecture/source-dependency-adapter-boundaries.test.mts'), boundary);
  await writeFile(join(root, 'scripts/docs/runtime-builtin-permissions.test.mts'), plainFoundationSuite(docsNames));
  await writeFile(join(root, 'scripts/ci/run-ordinary-postgres.test.mts'), plainFoundationSuite(postgresNames));
}

async function prepareSourceFixture(t: test.TestContext, optimizer: Optimizer, badCandidate: boolean,
  modules: ModulesMetadata): Promise<{ root: string; evidence: string; temporary: string; packageDirectory: string }> {
  const root = await testScratch('ar-pr-bootstrap-TEST-');
  const evidence = `${root}-evidence`, temporary = `${root}-tmp`;
  await mkdir(join(root, 'scripts/ci'), { recursive: true });
  await mkdir(join(root, 'architecture/foundation'), { recursive: true });
  await mkdir(join(root, 'scripts/sdk-growth-source/fixtures'), { recursive: true });
  await mkdir(join(root, dirname(bodyPath)), { recursive: true });
  await Promise.all([mkdir(evidence), mkdir(temporary)]);
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(evidence, { recursive: true, force: true }), rm(temporary, { recursive: true, force: true })]));

  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const installedLock = await readFile(join(repository, 'node_modules/.pnpm/lock.yaml'));
  await writeFile(join(root, 'pnpm-lock.yaml'), installedLock);
  await writeFile(join(root, bodyPath), 'export const body = "base";\n');
  await writeFile(join(root, fixturePath), 'TEST fixture base\n');
  await writeFile(join(root, 'architecture/foundation/ci-pr-regressions.json'), '{"selfAuthorization":false}\n');
  await cp(join(repository, 'scripts/ci/pr-regression-bootstrap.ts'), join(root, 'scripts/ci/pr-regression-bootstrap.ts'));
  await writeFile(join(root, 'scripts/ci/pr-regression-inputs.ts'), badCandidate
    ? `import { writeFile } from 'node:fs/promises';\n`
      + `await writeFile(${JSON.stringify(join(evidence, 'candidate-import-marker'))}, 'executed\\n');\n`
      + 'throw Error("TEST import-time candidate policy");\n'
    : `export async function currentPrInput() { return { installation: "1".repeat(64) }; }\n`
      + `export async function classifyPrRegressions() { return { mode: "affected-pr" }; }\n`);
  await writeFile(join(root, 'scripts/ci/pr-regression-command.ts'),
    `import { writeFile } from 'node:fs/promises';\n`
    + `export async function runPrRegressions() { await writeFile(${JSON.stringify(join(evidence, 'candidate-ran'))}, 'current\\n'); }\n`);
  await writeFile(join(root, 'scripts/ci/measure.ts'),
    `import { writeFile } from 'node:fs/promises';\n`
    + `await writeFile(${JSON.stringify(join(evidence, 'full-ran'))}, 'current-full\\n');\n`
    + `process.exitCode = Number(process.env.TEST_FULL_EXIT ?? '0');\n`);

  await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true });
  await writeFile(join(root, 'node_modules/.pnpm/lock.yaml'), installedLock);
  const modulesBytes = await modulesFixtureBytes(modules);
  if (modules === 'symlink') {
    await writeFile(join(root, 'node_modules/real-modules.yaml'), modulesBytes);
    await symlink('real-modules.yaml', join(root, 'node_modules/.modules.yaml'));
  } else {
    await writeFile(join(root, 'node_modules/.modules.yaml'), modulesBytes);
  }
  const packageDirectory = join(root, 'node_modules/.pnpm/@agent-teams+ci-input-proof@0.1.0/node_modules/@agent-teams/ci-input-proof');
  await mkdir(packageDirectory, { recursive: true });
  if (optimizer !== 'absent') {
    const installedOptimizer = join(repository,
      'node_modules/.pnpm/@agent-teams+ci-input-proof@0.1.0/node_modules/@agent-teams/ci-input-proof');
    await cp(installedOptimizer, packageDirectory, { recursive: true, dereference: true });
    if (optimizer === 'manifest') {await writeFile(join(packageDirectory, 'package.json'), '{broken\n');}
    if (optimizer === 'marker') {
      await writeFile(join(packageDirectory, 'dist/index.js'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(evidence, 'optimizer-import-marker'))}, 'executed\\n');\n`
        + `export { compareLeafInventories } from './features/input-comparison/application/compare-leaf-inventories.js';\n`);
    }
    if (optimizer === 'mode') {await chmod(join(packageDirectory, 'dist/index.js'), 0o755);}
    if (optimizer === 'extra') {await writeFile(join(packageDirectory, 'unexpected.js'), 'throw Error("TEST extra optimizer source");\n');}
  }
  const publicPackage = join(root, 'node_modules/@agent-teams/ci-input-proof');
  await mkdir(dirname(publicPackage), { recursive: true });
  if (optimizer === 'foreign-link') {
    const foreign = join(root, 'foreign-optimizer');
    await mkdir(foreign, { recursive: true });
    await symlink(relative(dirname(publicPackage), foreign), publicPackage, 'dir');
  } else if (optimizer !== 'absent') {
    await symlink(relative(dirname(publicPackage), packageDirectory), publicPackage, 'dir');
  }

  return { root, evidence, temporary, packageDirectory };
}

async function sourceFixture(t: test.TestContext, mutation: Mutation = 'body', optimizer: Optimizer = 'valid', badCandidate = false,
  modules: ModulesMetadata = 'real') {
  const { root, evidence, temporary, packageDirectory } = await prepareSourceFixture(t, optimizer, badCandidate, modules);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, TMPDIR: temporary, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'agent-teams-ai/agent-runtime', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24', ImageVersion: '20261009.1',
    PR_REGRESSION_FROZEN_INSTALL: 'verified',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const freeze = () => {
    git('add', '-A');
    const tree = git('write-tree');
    const parent = git('rev-parse', 'HEAD');
    const sha = execFileSync('git', ['commit-tree', tree, '-p', parent], { cwd: root,
      env: { ...env, GIT_AUTHOR_NAME: 'TEST', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'TEST', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
      input: 'Disposable TEST snapshot\n', encoding: 'utf8' }).trim();
    git('reset', '--quiet', '--hard', sha);
    return sha;
  };
  git('init', '--quiet');
  git('config', 'user.name', 'TEST');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '-A');
  const baseTree = git('write-tree');
  const base = execFileSync('git', ['commit-tree', baseTree], { cwd: root,
    env: { ...env, GIT_AUTHOR_NAME: 'TEST', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'TEST', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    input: 'Disposable TEST base\n', encoding: 'utf8' }).trim();
  git('reset', '--quiet', '--hard', base);

  if (!['none', 'push-tuple', 'worktree-file', 'worktree-link'].includes(mutation)) {
    const path = mutation === 'body' ? bodyPath
      : mutation === 'bootstrap' ? 'scripts/ci/pr-regression-bootstrap.ts'
        : mutation === 'helper' ? 'scripts/ci/pr-regression-command.ts'
          : mutation === 'config' ? 'architecture/foundation/ci-pr-regressions.json'
            : mutation === 'lock' ? 'pnpm-lock.yaml' : fixturePath;
    if (mutation === 'add') {await writeFile(join(root, 'packages/contexts/runtime-configuration/src/added.ts'), 'export {};\n');}
    else if (mutation === 'delete') {await rm(join(root, bodyPath));}
    else if (mutation === 'mode') {await chmod(join(root, bodyPath), 0o755);}
    else if (mutation === 'symlink') {await rm(join(root, bodyPath)); await symlink('other.ts', join(root, bodyPath));}
    else {await writeFile(join(root, path), `${await readFile(join(root, path), 'utf8')}\n// TEST change\n`);}
  }
  const head = freeze();
  if (mutation === 'worktree-file') {
    await writeFile(join(root, bodyPath), `${await readFile(join(root, bodyPath), 'utf8')}\n// TEST uncommitted checkout drift\n`);
  } else if (mutation === 'worktree-link') {
    await rm(join(root, bodyPath)); await symlink('other.ts', join(root, bodyPath));
  }
  if (mutation === 'installed' && optimizer === 'valid') {
    await writeFile(join(packageDirectory, 'dist/index.js'), 'throw Error("TEST installed optimizer drift");\n');
  }
  if (mutation === 'incomplete-census') {
    const bin = join(root, 'fake-bin'), realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "ls-tree" ]; then printf 'incomplete'; exit 0; fi\nexec ${realGit} "$@"\n`);
    await chmod(join(bin, 'git'), 0o755);
    env.PATH = `${bin}:${process.env.PATH}`;
  }
  const event = {
    number: 211, action: 'synchronize', repository: { full_name: 'agent-teams-ai/agent-runtime' },
    pull_request: { number: 211, base: { sha: base, ref: 'main', repo: { full_name: 'agent-teams-ai/agent-runtime' } },
      head: { sha: head, repo: { full_name: 'agent-teams-ai/agent-runtime', fork: false } } },
  };
  const eventPath = join(evidence, 'event.json');
  await writeFile(eventPath, JSON.stringify(event));
  Object.assign(env, {
    GITHUB_EVENT_PATH: eventPath, GITHUB_REF: 'refs/pull/211/merge',
    GITHUB_WORKFLOW_REF: 'agent-teams-ai/agent-runtime/.github/workflows/ci.yml@refs/pull/211/merge',
    EXPECTED_BASE_REVISION: base, EXPECTED_REVISION: head,
  });
  if (mutation === 'push-tuple') {
    env.GITHUB_EVENT_NAME = 'push';
    env.GITHUB_REF = 'refs/heads/main';
    env.GITHUB_WORKFLOW_REF = 'agent-teams-ai/agent-runtime/.github/workflows/ci.yml@refs/heads/main';
  }
  if (mutation === 'base-tuple') {
    event.pull_request.base.sha = '0'.repeat(40);
    await writeFile(eventPath, JSON.stringify(event));
  }
  if (mutation === 'merge-tuple') {
    env.GITHUB_REF = 'refs/pull/211/head';
    env.GITHUB_WORKFLOW_REF = 'agent-teams-ai/agent-runtime/.github/workflows/ci.yml@refs/pull/211/head';
  }
  return { root, evidence, env, packageDirectory };
}

async function invoke(t: test.TestContext, mutation: Mutation = 'body', optimizer: Optimizer = 'valid', badCandidate = false, fullExit = 0,
  modules: ModulesMetadata = 'real') {
  const fixture = await sourceFixture(t, mutation, optimizer, badCandidate, modules);
  fixture.env.TEST_FULL_EXIT = String(fullExit);
  const result = spawnSync(process.execPath, [join(fixture.root, 'scripts/ci/pr-regression-bootstrap.ts'), 'quick'],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8' });
  return { ...fixture, result };
}

interface InstalledOptions { mutation?: 'body' | 'bootstrap'; optimizer?: 'valid' | 'absent' | 'malformed' | 'foreign-link';
  badCandidate?: boolean; fullExit?: number; group?: 'quick' | 'foundation'; foundationFailure?: boolean }

async function installedSourceFixture(t: test.TestContext, options: InstalledOptions = {}) {
  const root = await testScratch('ar-pr-operational-TEST-');
  const evidence = `${root}-evidence`, temporary = `${root}-tmp`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(evidence, { recursive: true, force: true }),
    rm(temporary, { recursive: true, force: true })]));
  await copySourceTree(repository, root);
  const installedLock = await readFile(join(repository, 'node_modules/.pnpm/lock.yaml'));
  await writeFile(join(root, 'pnpm-lock.yaml'), installedLock);
  await mkdir(join(root, dirname(bodyPath)), { recursive: true });
  await writeFile(join(root, bodyPath), 'export const body = "base";\n');
  if ((options.group ?? 'quick') === 'foundation') {
    await writeFoundationFixture(root, await foundationRegistrationCensus(repository),
      'contained-turn domain and application remain dependency-free core');
  }
  await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true });
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
  await Promise.all([mkdir(evidence), mkdir(temporary)]);

  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { scripts: Record<string, string> };
  if ((options.group ?? 'quick') === 'quick') {
    for (const name of ['lint', 'check:node-compat', 'typecheck:ci', 'test:ci']) {
      manifest.scripts[name] = 'node scripts/ci/test-phase.mjs';
    }
    manifest.scripts['test:ci'] = 'node --test scripts/ci/contracts.test.ts';
    manifest.scripts['check:ci:quick'] = 'pnpm lint && pnpm check:node-compat && pnpm typecheck:ci && pnpm test:ci';
  } else {
    manifest.scripts['foundation:boundaries:negative'] =
      'node --test scripts/architecture/source-dependency-adapter-boundaries.test.mts scripts/docs/runtime-builtin-permissions.test.mts scripts/ci/run-ordinary-postgres.test.mts';
    manifest.scripts['foundation:check'] = 'node scripts/ci/test-phase.mjs && pnpm foundation:boundaries:negative';
    manifest.scripts['foundation:scaffold:check'] = 'node scripts/ci/test-phase.mjs';
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, 'scripts/ci/test-phase.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(evidence, 'phase-ran'))}, 'phase\\\\n');\nprocess.exitCode = Number(process.env.TEST_FULL_EXIT ?? '0');\n`);
  await writeFile(join(root, 'scripts/ci/contracts.test.ts'),
    "import test from 'node:test';\ntest('operational CI selftest', () => {});\n");
  await writeFile(join(root, 'scripts/ci/conformance.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(evidence, 'conformance-ran'))}, 'conformance\\\\n');\nprocess.exitCode = Number(process.env.TEST_FULL_EXIT ?? '0');\n`);

  const optimizerSource = join(repository, 'node_modules/.pnpm/@agent-teams+ci-input-proof@0.1.0/node_modules/@agent-teams/ci-input-proof');
  const yamlSource = await realpath(join(repository, 'node_modules/yaml')).catch(() =>
    join(repository, 'node_modules/.pnpm/yaml@2.9.0/node_modules/yaml'));
  const optimizerStore = join(root, 'node_modules/.pnpm/@agent-teams+ci-input-proof@0.1.0/node_modules/@agent-teams/ci-input-proof');
  const yamlStore = join(root, 'node_modules/.pnpm/yaml@2.9.0/node_modules/yaml');
  await mkdir(join(optimizerStore, '..'), { recursive: true });
  await mkdir(join(yamlStore, '..'), { recursive: true });
  if (options.optimizer !== 'absent') {
    await cp(optimizerSource, optimizerStore, { recursive: true, dereference: true });
    if (options.optimizer === 'malformed') {
      await writeFile(join(optimizerStore, 'dist/index.js'), 'throw Error("TEST malformed optimizer");\n');
    }
  }
  await cp(yamlSource, yamlStore, { recursive: true, dereference: true });
  await writeFile(join(root, 'node_modules/.pnpm/lock.yaml'), installedLock);
  await writeFile(join(root, 'node_modules/.modules.yaml'),
    await readFile(process.env.TEST_PNPM_MODULES_FIXTURE ?? join(repository, 'node_modules/.modules.yaml')));
  await writeFile(join(root, 'node_modules/.bin/tsc'), '#!/bin/sh\nprintf "Version 7.0.2\\\\n"\n');
  await chmod(join(root, 'node_modules/.bin/tsc'), 0o755);
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'pnpm'),
    `#!/bin/sh\nset -eu\nif [ "\${1-}" = "--version" ]; then printf '11.18.0\\n'; exit 0; fi\nif [ "\${1-}" = "exec" ] && [ "\${2-}" = "tsc" ]; then shift 2; exec ./node_modules/.bin/tsc "$@"; fi\nif [ "\${1-}" = "run" ]; then command=$(node -e 'const p=require("./package.json"); process.stdout.write(p.scripts[process.argv[1]] ?? "")' "\${2-}"); [ -n "$command" ] || exit 1; PATH="$PWD/node_modules/.bin:$PATH"; export PATH; exec sh -c "$command"; fi\nif [ "$#" -eq 1 ]; then command=$(node -e 'const p=require("./package.json"); process.stdout.write(p.scripts[process.argv[1]] ?? "")' "$1"); if [ -n "$command" ]; then exec sh -c "$command"; fi; fi\nexit 1\n`);
  await chmod(join(fakeBin, 'pnpm'), 0o755);
  const publicOptimizer = join(root, 'node_modules/@agent-teams/ci-input-proof');
  await mkdir(dirname(publicOptimizer), { recursive: true });
  if (options.optimizer === 'foreign-link') {
    const foreign = join(root, 'foreign-optimizer');
    await mkdir(foreign, { recursive: true });
    await symlink(relative(dirname(publicOptimizer), foreign), publicOptimizer, 'dir');
  } else if (options.optimizer !== 'absent') {
    await symlink(relative(dirname(publicOptimizer), optimizerStore), publicOptimizer, 'dir');
  }
  const publicYaml = join(root, 'node_modules/yaml');
  await symlink(relative(dirname(publicYaml), yamlStore), publicYaml, 'dir');

  const inputPath = join(root, 'scripts/ci/pr-regression-inputs.ts');
  if (options.badCandidate) {
    await writeFile(inputPath, `${await readFile(inputPath, 'utf8')}\n`
      + `import { writeFile as writeMarker } from 'node:fs/promises';\n`
      + `await writeMarker(${JSON.stringify(join(evidence, 'candidate-import-marker'))}, 'executed\\\\n');\n`
      + 'throw Error("TEST import-time candidate policy");\n');
  }

  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    TMPDIR: temporary,
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'agent-teams-ai/agent-runtime', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24', ImageVersion: '20261009.1',
    PR_REGRESSION_FROZEN_INSTALL: 'verified',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const freeze = () => {
    git('add', '-A');
    const tree = git('write-tree');
    const parent = git('rev-parse', 'HEAD');
    const sha = execFileSync('git', ['commit-tree', tree, '-p', parent], {
      cwd: root,
      env: { ...env, GIT_AUTHOR_NAME: 'TEST', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'TEST', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
      input: 'Disposable TEST operational snapshot\n', encoding: 'utf8',
    }).trim();
    git('reset', '--quiet', '--hard', sha);
    return sha;
  };
  git('init', '--quiet');
  git('config', 'user.name', 'TEST');
  git('config', 'user.email', 'test@example.invalid');
  git('add', '-A');
  const baseTree = git('write-tree');
  const base = execFileSync('git', ['commit-tree', baseTree], {
    cwd: root,
    env: { ...env, GIT_AUTHOR_NAME: 'TEST', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'TEST', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    input: 'Disposable TEST operational base\n', encoding: 'utf8',
  }).trim();
  git('reset', '--quiet', '--hard', base);
  if (options.mutation === 'body') {
    await writeFile(join(root, bodyPath), `${await readFile(join(root, bodyPath), 'utf8')}\n// Disposable TEST operational body mutation\n`);
  } else if (options.mutation === 'bootstrap') {
    await writeFile(join(root, 'scripts/ci/pr-regression-bootstrap.ts'), `${await readFile(join(root, 'scripts/ci/pr-regression-bootstrap.ts'), 'utf8')}\n// Disposable TEST bootstrap mutation\n`);
  }
  const head = freeze();
  const event = {
    number: 211, action: 'synchronize', repository: { full_name: 'agent-teams-ai/agent-runtime' },
    pull_request: { number: 211, base: { sha: base, ref: 'main', repo: { full_name: 'agent-teams-ai/agent-runtime' } },
      head: { sha: head, repo: { full_name: 'agent-teams-ai/agent-runtime', fork: false } } },
  };
  const eventPath = join(evidence, 'event.json');
  await writeFile(eventPath, JSON.stringify(event));
  Object.assign(env, {
    GITHUB_EVENT_PATH: eventPath, GITHUB_REF: 'refs/pull/211/merge',
    GITHUB_WORKFLOW_REF: 'agent-teams-ai/agent-runtime/.github/workflows/ci.yml@refs/pull/211/merge',
    EXPECTED_BASE_REVISION: base, EXPECTED_REVISION: head, CI_EVIDENCE_DIR: evidence,
    TEST_FULL_EXIT: String(options.fullExit ?? 0),
  });
  return { root, evidence, env, group: options.group ?? 'quick' as const };
}

async function invokeInstalled(t: test.TestContext, options: InstalledOptions = {}) {
  const fixture = await installedSourceFixture(t, options);
  const result = spawnSync(process.execPath, [join(fixture.root, 'scripts/ci/pr-regression-bootstrap.ts'), fixture.group],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8' });
  return { ...fixture, result };
}

function registerWorkflowAndMeasureTests(): void {
  test('nominal pnpm metadata keys reject semantic duplicates and escaped identity aliases', () => {
    const accepted = '{"packageManager" : "pnpm@11.18.0","virtualStoreDir":".pnpm"}';
    assert.deepEqual(parseInstallationMetadata(Buffer.from(accepted)),
      { packageManager: 'pnpm@11.18.0', virtualStoreDir: '.pnpm' });
    for (const source of [
      '{"packageManager":"pnpm@11.17.0","package\\u004danager":"pnpm@11.18.0","virtualStoreDir":".pnpm"}',
      '{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","virtualStoreDir":".pnpm"}',
      '{"packageManager":"pnpm@11.18.0","virtualStoreDir":"wrong","virtual\\u0053toreDir":".pnpm"}',
      '{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","nested":{"packageManager":"pnpm@11.18.0"}}',
      '{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","nested":{"virtualStoreDir":".pnpm"}}',
      '{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","virtualStoreOnly":true}',
      '{"packageManager":"pnpm@11.18.0","virtualStoreDir":".pnpm","virtualStoreOnly":false,"virtual\\u0053toreOnly":false}',
    ]) {
      assert.throws(() => parseInstallationMetadata(Buffer.from(source)), /key drift|key spelling drift|virtual-store-only/u);
    }
  });

  test('the actual trusted workflow shell rejects changed, missing and uncertain bootstrap before execution', async t => {
    for (const mutation of ['missing', 'syntax', 'early-success'] as const) {
      const fixture = await workflowSourceFixture(t, mutation);
      const result = spawnSync('bash', ['-c', fixture.shell],
        { cwd: fixture.root, env: fixture.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.status, 23, `${mutation}: ${result.stdout}\n${result.stderr}`);
      assert.equal(result.signal, null, mutation);
      assert.equal(await readFile(join(fixture.evidence, 'full-ran'), 'utf8'), 'current-full\n', mutation);
      assert.deepEqual(JSON.parse(await readFile(join(fixture.evidence, 'full-env.json'), 'utf8')),
        { protocol: null, index: null, count: null }, mutation);
      await assert.rejects(readFile(join(fixture.evidence, 'bootstrap-ran')), mutation);
      await assert.rejects(readFile(join(fixture.evidence, 'fake-full-ran')), mutation);
    }
  });

  test('raw-byte bootstrap admission rejects a configured clean-filter early-success mapping', async t => {
    const fixture = await workflowSourceFixture(t, 'clean-filter-early-success');
    assert.match(fixture.shell, /git hash-object --no-filters -- "\$bootstrap"/u, 'workflow uses raw-byte admission');
    const legacyShell = fixture.shell.replace('git hash-object --no-filters -- "$bootstrap"', 'git hash-object -- "$bootstrap"');
    assert.notEqual(legacyShell, fixture.shell, 'legacy filtered shell fixture');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim();
    const expected = git('ls-tree', fixture.env.EXPECTED_REVISION!, '--', 'scripts/ci/pr-regression-bootstrap.ts').split(/\s+/u)[2];
    const filtered = git('hash-object', '--', 'scripts/ci/pr-regression-bootstrap.ts');
    const raw = git('hash-object', '--no-filters', '--', 'scripts/ci/pr-regression-bootstrap.ts');
    assert.equal(filtered, expected, 'legacy filter maps altered raw bytes to the trusted blob');
    assert.notEqual(raw, expected, 'raw bootstrap bytes differ from the trusted blob');

    const legacy = spawnSync('bash', ['-c', legacyShell],
      { cwd: fixture.root, env: fixture.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(legacy.status, 0, `${legacy.stdout}\n${legacy.stderr}`);
    assert.equal(await readFile(join(fixture.evidence, 'bootstrap-ran'), 'utf8'), 'executed\n');
    assert.equal(await readFile(join(fixture.evidence, 'fake-full-ran'), 'utf8'), 'fake-full\n');
    await Promise.all([rm(join(fixture.evidence, 'bootstrap-ran')), rm(join(fixture.evidence, 'fake-full-ran'))]);

    const fixed = spawnSync('bash', ['-c', fixture.shell],
      { cwd: fixture.root, env: fixture.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(fixed.status, 23, `${fixed.stdout}\n${fixed.stderr}`);
    assert.equal(await readFile(join(fixture.evidence, 'full-ran'), 'utf8'), 'current-full\n');
    await assert.rejects(readFile(join(fixture.evidence, 'bootstrap-ran')));
    await assert.rejects(readFile(join(fixture.evidence, 'fake-full-ran')));
  });

  test('actual pre-import recovery regression graph never loads a rejected optimizer', async t => {
    for (const optimizer of ['marker', 'absent'] as const) {
      const rejected = await sourceFixture(t, 'none', optimizer);
      const admission = runFixtureBootstrapAdmission(rejected.root, rejected.env);
      assert.equal(admission.status, 24, `${optimizer}: ${admission.stdout}\n${admission.stderr}`);
      assert.equal(admission.signal, null, optimizer);
      const rejection = JSON.parse(admission.stdout) as { rejected?: string };
      assert.ok(typeof rejection.rejected === 'string' && rejection.rejected.length > 0, optimizer);
      await assert.rejects(readFile(join(rejected.evidence, 'optimizer-import-marker')), optimizer);

      const fixture = await actualMeasureFixture(t, { optimizer });
      const graph = await runActualRegressionImportGraph(fixture);
      assert.equal(graph.status, 0, `${optimizer}: ${graph.stdout}\n${graph.stderr}`);
      assert.match(graph.stdout, new RegExp(`^ok \\d+ - ${regressionGraphTestName}$`, 'm'),
        `${optimizer}: actual regression import graph did not load\n${graph.stdout}\n${graph.stderr}`);
      assert.doesNotMatch(graph.stdout, /^not ok /mu, `${optimizer}: original regression failed\n${graph.stdout}\n${graph.stderr}`);
      await assert.rejects(readFile(join(fixture.root, 'optimizer-import-marker')), optimizer);
    }
  });

  test('actual measure records missing admission inputs and still attempts real FULL regression', async t => {
    for (const missing of ['bootstrap', 'bootstrap-test'] as const) {
      const fixture = await actualMeasureFixture(t, { missing });
      const run = await runActualMeasureGraph(fixture);
      assert.notEqual(run.status, 0, `${missing}: ${run.stdout}\n${run.stderr}`);
      const report = JSON.parse(await readFile(join(fixture.evidence, 'check-ci-quick.json'), 'utf8')) as {
        sourceComplete: boolean; sourceDisposition: string; receiptReuseAllowed: boolean;
        inputAdmission: Array<{ path: string; status: string; reason?: string }>;
        phases: Array<{ script: string; code: number | null; signal: string | null; started: string; ended: string;
          tests: Array<{ name: string; status: string }> }>;
      };
      assert.equal(report.sourceComplete, false, missing);
      assert.equal(report.sourceDisposition, 'blocking-source-incomplete', missing);
      assert.equal(report.receiptReuseAllowed, false, missing);
      const missingPath = missing === 'bootstrap'
        ? 'scripts/ci/pr-regression-bootstrap.ts' : 'scripts/ci/pr-regression-bootstrap.test.ts';
      assert.deepEqual(report.inputAdmission.find(input => input.path === missingPath),
        { path: missingPath, status: 'unavailable', reason: 'missing' }, missing);
      assert.deepEqual(report.phases.map(phase => phase.script),
        ['lint', 'check:node-compat', 'typecheck:ci', 'test:ci'], missing);
      const regression = report.phases.find(phase => phase.script === 'test:ci');
      assert.notEqual(regression?.code, 0, missing);
      assert.equal(regression?.signal, null, missing);
      assert.ok(Date.parse(regression!.started) <= Date.parse(regression!.ended), missing);
      assert.equal(regression!.tests.some(testResult => testResult.status === 'passed'), false,
        `${missing}: unavailable source must not claim a passed regression child\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /pr-regression-bootstrap\.(?:test\.)?ts/u, missing);
    }
  });
}

export function registerPrRegressionBootstrapTests(): void {
  registerWorkflowAndMeasureTests();
  test('authentic retained history closes ccf->df and passes the original package/workflow validators', async t => {
    const root = await testScratch('ar-pr-history-TEST-');
    t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(`${root}-evidence`, { recursive: true, force: true })]));
    const bundle = process.env.TEST_HISTORY_BUNDLE;
    if (bundle) {
      execFileSync('git', ['clone', '--quiet', '--no-local', bundle, root]);
    } else {
      execFileSync('git', ['clone', '--quiet', '--shared', repository, root]);
    }
    const revision = '47a79675fac84436e96bc6119478d740848f4f02';
    execFileSync('git', ['checkout', '--quiet', '-B', 'TEST-history', revision], { cwd: root });
    execFileSync('git', ['merge-base', '--is-ancestor', 'ccf6d6f8dc025d6aa81ab2109a9ccc37b0dece15',
      'df9260b0062dcb445c3cf75ce76f8539a2b32c03'], { cwd: root });
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, ['scripts/ci/conformance.ts'], {
      cwd: root,
      env: { ...process.env, EXPECTED_REVISION: revision, BENCHMARK_ARM: 'production', CI_EVIDENCE_DIR: `${root}-evidence` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /CI full inventory, prerequisites, event revision and platform\/trust contracts verified\./u);
  });

  test('the frozen installed classifier reaches affected-pr through the bootstrap process', async t => {
    const run = await invokeInstalled(t, { mutation: 'body' });
    const fullReport = await readFile(join(run.evidence, 'check-ci-quick.json'), 'utf8').catch(() => 'missing FULL report');
    assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}\n${fullReport}`);
    const planBytes = await readFile(join(run.evidence, 'pr-quick.json'), 'utf8').catch(() => {
      throw new Error(`${run.result.stdout}\n${run.result.stderr}\n${fullReport}`);
    });
    const plan = JSON.parse(planBytes) as { plan: { mode: string } };
    assert.equal(plan.plan.mode, 'affected-pr');
    await assert.rejects(readFile(join(run.evidence, 'check-ci-quick.json')));
  });

  test('the frozen installed route sends optimizer/import failures and hard FULL failures through current FULL', async t => {
    for (const options of [
      { optimizer: 'absent' as const }, { optimizer: 'malformed' as const }, { optimizer: 'foreign-link' as const },
      { badCandidate: true }, { mutation: 'bootstrap' as const, fullExit: 23 },
    ]) {
      const run = await invokeInstalled(t, options);
      const expected = 'fullExit' in options ? options.fullExit : 0;
      const fullReport = await readFile(join(run.evidence, 'check-ci-quick.json'), 'utf8').catch(() => 'missing FULL report');
      assert.equal(run.result.status, expected, `${JSON.stringify(options)}\n${run.result.stdout}\n${run.result.stderr}\n${fullReport}`);
      await readFile(join(run.evidence, 'check-ci-quick.json'));
      await assert.rejects(readFile(join(run.evidence, 'pr-quick.json')), JSON.stringify(options));
    }
  });

  test('bootstrap serial FULL drops Foundation shard selection and executes the original 33-test census', async t => {
    const fixture = await installedSourceFixture(t, { group: 'foundation', foundationFailure: true });
    const boundary = join(fixture.root, 'scripts/architecture/source-dependency-adapter-boundaries.test.mts');
    const reporter = join(fixture.root, 'scripts/ci/foundation-fixture-sharding.ts');
    const shardEvidence = join(fixture.evidence, 'foundation-shard0.json');
    const shardEnv = {
      ...fixture.env,
      FOUNDATION_FIXTURE_PROTOCOL: 'foundation-fixtures/1',
      FOUNDATION_FIXTURE_INDEX: '0',
      FOUNDATION_FIXTURE_COUNT: '3',
    };
    const shard = spawnSync(process.execPath,
      ['--test', `--test-reporter=${reporter}`, `--test-reporter-destination=${shardEvidence}`, boundary],
      { cwd: fixture.root, env: shardEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const shardOutput = await readFile(shardEvidence, 'utf8').catch(() => 'missing shard report');
    assert.equal(shard.status, 0, `${shard.stdout}\n${shard.stderr}\n${shardOutput}`);
    const shardReport = JSON.parse(await readFile(shardEvidence, 'utf8')) as {
      registrations: Array<{ encountered: string[]; registered: string[]; excluded: string[] }>;
      events: Array<{ name: string; status: string }>;
    };
    const registration = shardReport.registrations[0];
    assert.ok(registration);
    assert.equal(registration.encountered.length, 25);
    assert.equal(registration.registered.length, 9);
    assert.equal(registration.excluded.length, 16);
    assert.ok(registration.excluded.includes('contained-turn domain and application remain dependency-free core'));
    assert.ok(shardReport.events.every(event => event.status === 'passed'));

    const fullProcess = spawnSync(process.execPath, [join(fixture.root, 'scripts/ci/pr-regression-bootstrap.ts'), 'foundation'],
      { cwd: fixture.root, env: shardEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(fullProcess.status, 1, `${fullProcess.stdout}\n${fullProcess.stderr}`);
    assert.equal(fullProcess.signal, null);
    const report = JSON.parse(await readFile(join(fixture.evidence, 'check-ci-foundation.json'), 'utf8')) as {
      phases: Array<{ script: string; code: number | null; signal: string | null;
        tests: Array<{ name: string; status: string }> }>;
    };
    const phase = report.phases.find(candidate => candidate.script === 'foundation:check');
    assert.ok(phase);
    assert.equal(phase.code, 1);
    assert.equal(phase.signal, null);
    const census = await foundationRegistrationCensus(repository);
    const observed = new Set(phase.tests.filter(testResult => census.includes(testResult.name)).map(testResult => testResult.name));
    assert.equal(observed.size, 33);
    assert.deepEqual([...observed].toSorted(), census.toSorted());
    const failed = phase.tests.find(result => result.name === 'contained-turn domain and application remain dependency-free core');
    assert.equal(failed?.status, 'failed');
    assert.deepEqual([...new Set(phase.tests.filter(testResult => census.includes(testResult.name) && testResult.status !== 'passed')
      .map(testResult => testResult.name))],
      ['contained-turn domain and application remain dependency-free core']);
  });

  test('bootstrap admits only unchanged control source and executes the current candidate', async t => {
    const run = await invoke(t);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(await readFile(join(run.evidence, 'candidate-ran'), 'utf8'), 'current\n');
    await assert.rejects(readFile(join(run.evidence, 'full-ran')));
  });

  test('actual pnpm11 JSON metadata admits while real-format identity and layout mutations reject before import', async t => {
    const run = await invoke(t, 'none', 'valid', false, 0, 'real');
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(await readFile(join(run.evidence, 'candidate-ran'), 'utf8'), 'current\n');
    for (const modules of ['yaml', 'wrong-manager', 'wrong-layout', 'malformed', 'oversized', 'duplicate-identity',
      'escaped-identity-shadow', 'duplicate-layout', 'escaped-layout', 'duplicate-nested-identity', 'duplicate-nested-layout',
      'virtual-store-only', 'escaped-virtual-store-only-shadow', 'symlink'] as const) {
      const rejected = await invoke(t, 'none', 'valid', true, 0, modules);
      assert.equal(rejected.result.status, 0, `${modules}: ${rejected.result.stderr}`);
      assert.equal(await readFile(join(rejected.evidence, 'full-ran'), 'utf8'), 'current-full\n', modules);
      await assert.rejects(readFile(join(rejected.evidence, 'candidate-ran')), modules);
      await assert.rejects(readFile(join(rejected.evidence, 'candidate-import-marker')), modules);
    }
  });

  test('absent, malformed and marker-bearing optimizer source reject before import and select current FULL', async t => {
    for (const optimizer of ['absent', 'manifest', 'marker', 'extra', 'foreign-link'] as const) {
      const run = await invoke(t, 'body', optimizer, true);
      assert.equal(run.result.status, 0, `${optimizer}: ${run.result.stderr}`);
      assert.equal(await readFile(join(run.evidence, 'full-ran'), 'utf8'), 'current-full\n');
      await assert.rejects(readFile(join(run.evidence, 'candidate-ran')));
      await assert.rejects(readFile(join(run.evidence, 'candidate-import-marker')));
      await assert.rejects(readFile(join(run.evidence, 'optimizer-import-marker')));
    }
    const policy = await invoke(t, 'body', 'valid', true);
    assert.equal(policy.result.status, 0, policy.result.stderr);
    assert.equal(await readFile(join(policy.evidence, 'full-ran'), 'utf8'), 'current-full\n');
    assert.equal(await readFile(join(policy.evidence, 'candidate-import-marker'), 'utf8'), 'executed\n');
    await assert.rejects(readFile(join(policy.evidence, 'candidate-ran')));
  });

  test('published optimizer mode drift rejects before comparator import', async t => {
    const run = await invoke(t, 'none', 'mode');
    assert.equal((await lstat(join(run.packageDirectory, 'dist/index.js'))).mode & 0o777, 0o755);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(await readFile(join(run.evidence, 'full-ran'), 'utf8'), 'current-full\n');
    await assert.rejects(readFile(join(run.evidence, 'candidate-ran')));
    await assert.rejects(readFile(join(run.evidence, 'candidate-import-marker')));
    await assert.rejects(readFile(join(run.evidence, 'optimizer-import-marker')));
  });

  test('additional optimizer integration observation runs only after independent admission', async t => {
    const fixture = await sourceFixture(t, 'none', 'valid');
    const observation = runFixtureOptimizerComparison(fixture.root, fixture.env);
    assert.equal(observation.status, 0, `${observation.stdout}\n${observation.stderr}`);
    assert.deepEqual(JSON.parse(observation.stdout),
      { status: 'compatible-inputs', changedContentPaths: ['body.ts'] });
  });

  test('bootstrap/helper/config/lock/fixture/installed drift and structural changes select FULL', async t => {
    for (const mutation of ['bootstrap', 'helper', 'config', 'lock', 'fixture', 'installed', 'add', 'delete', 'mode', 'symlink',
      'worktree-file', 'worktree-link'] as const) {
      const run = await invoke(t, mutation);
      assert.equal(run.result.status, 0, `${mutation}: ${run.result.stderr}`);
      assert.equal(await readFile(join(run.evidence, 'full-ran'), 'utf8'), 'current-full\n', mutation);
      await assert.rejects(readFile(join(run.evidence, 'candidate-ran')), mutation);
    }
  });

  test('incomplete census and new push/base/merge tuples remain fail-closed at FULL', async t => {
    for (const mutation of ['incomplete-census', 'push-tuple', 'base-tuple', 'merge-tuple'] as const) {
      const run = await invoke(t, mutation);
      assert.equal(run.result.status, 0, `${mutation}: ${run.result.stderr}`);
      assert.equal(await readFile(join(run.evidence, 'full-ran'), 'utf8'), 'current-full\n', mutation);
      await assert.rejects(readFile(join(run.evidence, 'candidate-ran')), mutation);
    }
  });

  test('FULL is the independent existing command and its failure remains hard', async t => {
    const run = await invokeInstalled(t, { mutation: 'bootstrap', fullExit: 23 });
    assert.equal(run.result.status, 23, run.result.stderr);
    const report = JSON.parse(await readFile(join(run.evidence, 'check-ci-quick.json'), 'utf8')) as {
      phases: Array<{ script: string; code: number | null; signal: string | null }>;
    };
    assert.equal(report.phases[0]?.script, 'lint');
    assert.equal(report.phases[0]?.code, 23);
    assert.equal(report.phases[0]?.signal, null);
    await assert.rejects(readFile(join(run.evidence, 'pr-quick.json')));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {registerPrRegressionBootstrapTests();}
