import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const fixtureBootstrapImport = "import { admitAndImportOptimizer } from './scripts/ci/pr-regression-bootstrap.ts';";

export const regressionGraphTestName = 'complete quick obligations retain live conformance and reject deferred execution or passes';

export type ActualMeasureOptimizer = 'linked' | 'absent' | 'marker';
export type ActualMeasureMissingFile = 'bootstrap' | 'bootstrap-test';

export interface ActualMeasureFixtureOptions {
  optimizer?: ActualMeasureOptimizer;
  missing?: ActualMeasureMissingFile;
}

export interface ActualMeasureFixture {
  root: string;
  evidence: string;
  env: NodeJS.ProcessEnv;
}

export const testScratch = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function copySourceTree(source: string, destination: string): Promise<void> {
  const excluded = new Set(['.git', '.cache', '.agents', '.aws', '.codex', 'node_modules', 'tmp']);
  const visit = async (path: string, target: string): Promise<void> => {
    const name = relative(source, path);
    if (name && name.split(sep).some(part => excluded.has(part))) {return;}
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      await symlink(await readlink(path), target);
    } else if (stat.isDirectory()) {
      await mkdir(target, { recursive: true });
      for (const child of (await readdir(path)).toSorted()) {await visit(join(path, child), join(target, child));}
    } else if (stat.isFile()) {
      await copyFile(path, target);
      await chmod(target, stat.mode & 0o777);
    } else {
      throw new Error('operational source fixture contains an unsupported kind');
    }
  };
  await visit(source, destination);
}

async function installNodeModulesFixture(root: string, optimizer: ActualMeasureOptimizer): Promise<void> {
  const sourceModules = await realpath(join(repository, 'node_modules')), targetModules = join(root, 'node_modules');
  await mkdir(targetModules, { recursive: true });
  for (const name of (await readdir(sourceModules)).toSorted()) {
    if (name === '.pnpm' || name === '.modules.yaml') {continue;}
    const source = join(sourceModules, name), target = join(targetModules, name);
    if (name === '@agent-teams') {
      await mkdir(target, { recursive: true });
      for (const packageEntry of (await readdir(source)).toSorted()) {
        const packageSource = await realpath(join(source, packageEntry));
        const packageTarget = join(target, packageEntry);
        if (packageEntry !== 'ci-input-proof') {
          await symlink(packageSource, packageTarget, (await lstat(packageSource)).isDirectory() ? 'dir' : 'file');
        }
      }
      continue;
    }
    const resolved = await realpath(source);
    await symlink(resolved, target, (await lstat(resolved)).isDirectory() ? 'dir' : 'file');
  }
  await mkdir(join(targetModules, '.pnpm'), { recursive: true });
  await copyFile(join(sourceModules, '.pnpm/lock.yaml'), join(targetModules, '.pnpm/lock.yaml'));
  await copyFile(join(sourceModules, '.modules.yaml'), join(targetModules, '.modules.yaml'));
  const optimizerSource = join(sourceModules, '.pnpm/@agent-teams+ci-input-proof@0.1.0/node_modules/@agent-teams/ci-input-proof');
  const optimizerTarget = join(targetModules, '.pnpm/@agent-teams+ci-input-proof@0.1.0/node_modules/@agent-teams/ci-input-proof');
  await mkdir(dirname(optimizerTarget), { recursive: true });
  if (optimizer !== 'absent') {
    await cp(optimizerSource, optimizerTarget, { recursive: true, dereference: true });
    if (optimizer === 'marker') {
      const entry = join(optimizerTarget, 'dist/index.js');
      await writeFile(entry, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'optimizer-import-marker'))}, 'executed\\n');\n${await readFile(entry, 'utf8')}`);
    }
  }
  const publicOptimizer = join(targetModules, '@agent-teams/ci-input-proof');
  await mkdir(dirname(publicOptimizer), { recursive: true });
  if (optimizer !== 'absent') {
    await symlink(relative(dirname(publicOptimizer), optimizerTarget), publicOptimizer, 'dir');
  }
}

export async function actualMeasureFixture(t: TestContext, options: ActualMeasureFixtureOptions = {}): Promise<ActualMeasureFixture> {
  const root = await testScratch('ar-actual-measure-TEST-');
  const evidence = `${root}-evidence`, temporary = `${root}-tmp`, fakeBin = join(root, 'fake-bin');
  await Promise.all([mkdir(evidence), mkdir(temporary), mkdir(fakeBin)]);
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(evidence, { recursive: true, force: true }), rm(temporary, { recursive: true, force: true })]));
  await copySourceTree(repository, root);
  await installNodeModulesFixture(root, options.optimizer ?? 'linked');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet'); git('config', 'user.name', 'TEST'); git('config', 'user.email', 'test@example.invalid'); git('add', '-A');
  const tree = git('write-tree');
  const sha = execFileSync('git', ['commit-tree', tree], {
    cwd: root,
    env: { GIT_AUTHOR_NAME: 'TEST', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'TEST', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    input: 'Disposable TEST actual measure graph\n', encoding: 'utf8',
  }).trim();
  git('reset', '--quiet', '--hard', sha);
  if (options.missing === 'bootstrap-test') {await rm(join(root, 'scripts/ci/pr-regression-bootstrap.test.ts'));}
  if (options.missing === 'bootstrap') {await rm(join(root, 'scripts/ci/pr-regression-bootstrap.ts'));}
  const realTsc = shellQuote(join(repository, 'node_modules/.bin/tsc'));
  await writeFile(join(fakeBin, 'pnpm'),
    `#!/bin/sh\nset -eu\nif [ "\${1-}" = "--version" ]; then printf '11.18.0\\n'; exit 0; fi\nif [ "\${1-}" = "exec" ] && [ "\${2-}" = "tsc" ]; then shift 2; exec ${realTsc} "$@"; fi\nif [ "\${1-}" = "run" ]; then command=$(node -e 'const p=require("./package.json"); process.stdout.write(p.scripts[process.argv[1]] ?? "")' "\${2-}"); [ -n "$command" ] || exit 1; PATH="$PWD/node_modules/.bin:$PATH"; export PATH; exec sh -c "$command"; fi\nexit 1\n`);
  await chmod(join(fakeBin, 'pnpm'), 0o755);
  return { root, evidence, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, TMPDIR: temporary,
    EXPECTED_REVISION: sha, CI_EVIDENCE_DIR: evidence } satisfies NodeJS.ProcessEnv };
}

export function runActualMeasureGraph(fixture: ActualMeasureFixture): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...fixture.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ['scripts/ci/measure.ts', 'check:ci:quick'], { cwd: fixture.root, env, encoding: 'utf8' });
}

function fixtureBootstrapProbe(root: string, environment: NodeJS.ProcessEnv, source: string): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...environment };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], { cwd: root, env, encoding: 'utf8' });
}

export function runFixtureBootstrapAdmission(root: string, environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return fixtureBootstrapProbe(root, environment, `${fixtureBootstrapImport}
try {
  await admitAndImportOptimizer(process.cwd());
  process.stdout.write('admitted');
} catch (error) {
  process.stdout.write(JSON.stringify({ rejected: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 24;
}`);
}

export function runFixtureOptimizerComparison(root: string, environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return fixtureBootstrapProbe(root, environment, `${fixtureBootstrapImport}
const compare = await admitAndImportOptimizer(process.cwd());
const base = { version: 1, digestScheme: 'sha256', inputs: [
  { path: 'root.ts', type: 'file', mode: '100644', membership: 'closed', content: 'a'.repeat(64) },
  { path: 'body.ts', type: 'file', mode: '100644', membership: 'structural', content: '1'.repeat(64) },
] };
const head = { ...base, inputs: [base.inputs[0], { ...base.inputs[1], content: '2'.repeat(64) }] };
process.stdout.write(JSON.stringify(compare(base, head, ['body.ts'])));`);
}

export async function runActualRegressionImportGraph(fixture: ActualMeasureFixture): Promise<SpawnSyncReturns<string>> {
  const env: NodeJS.ProcessEnv = { ...fixture.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const contracts = await readFile(join(fixture.root, 'scripts/ci/contracts.test.ts'), 'utf8');
  assert.match(contracts, /import \{ registerPrRegressionTests \} from '\.\/pr-regression-inputs\.test\.ts';/u);
  assert.match(contracts, /registerPrRegressionTests\(\);/u);
  return spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', `--test-name-pattern=^${regressionGraphTestName}$`, 'scripts/ci/pr-regression-inputs.test.ts'],
    { cwd: fixture.root, env, encoding: 'utf8' });
}
