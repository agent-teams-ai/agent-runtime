import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LeafInventoryComparator } from './pr-regression-inputs.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export const retainedHistorySource = process.env.TEST_HISTORY_BUNDLE ?? repository;
const fixtureBootstrapImport = "import { admitAndImportOptimizer } from './scripts/ci/pr-regression-bootstrap.ts';";
const retainedHistoryRevision = '47a79675fac84436e96bc6119478d740848f4f02';
const fixtureOwner = { name: 'iliya', email: 'iliyazelenkog@gmail.com' } as const;

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

export type MeasureChildOutcome = { kind: 'exit'; code: number } | { kind: 'signal'; signal: NodeJS.Signals } | { kind: 'success' };
export interface MeasurePhaseFixtureOptions {
  child: MeasureChildOutcome;
  phaseOrder?: readonly string[];
  sourceComplete?: boolean;
}

export const testScratch = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

export const fixtureOwnerEnvironment = (environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...environment,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: fixtureOwner.name,
  GIT_AUTHOR_EMAIL: fixtureOwner.email,
  GIT_COMMITTER_NAME: fixtureOwner.name,
  GIT_COMMITTER_EMAIL: fixtureOwner.email,
});

export function fixtureExecutionEnvironment(temporary: string,
  overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('NODE_TEST_')) {delete environment[key];}
  }
  delete environment.NODE_OPTIONS;
  const storeDirectory = overrides.TEST_PNPM_STORE_DIR ?? environment.TEST_PNPM_STORE_DIR;
  return {
    ...environment,
    ...overrides,
    TMPDIR: temporary,
    ...(storeDirectory ? { TEST_PNPM_STORE_DIR: storeDirectory, pnpm_config_store_dir: storeDirectory } : {}),
  };
}

export async function copySourceTree(source: string, destination: string): Promise<void> {
  const excluded = new Set(['.git', '.cache', '.agents', '.aws', '.codex', 'node_modules', 'tmp', 'fake-bin']);
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
      await chmod(target, stat.mode & 0o7777);
    } else {
      throw new Error('operational source fixture contains an unsupported kind');
    }
  };
  await visit(source, destination);
}

export async function createRetainedSourceCheckout(root: string): Promise<string> {
  execFileSync('git', ['clone', '--quiet', '--no-local', retainedHistorySource, root]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('checkout', '--quiet', '-B', 'TEST-retained-source', retainedHistoryRevision);
  git('merge-base', '--is-ancestor', 'ccf6d6f8dc025d6aa81ab2109a9ccc37b0dece15',
    'df9260b0062dcb445c3cf75ce76f8539a2b32c03');
  git('rm', '--quiet', '-r', '--ignore-unmatch', '.');
  await copySourceTree(repository, root);
  git('add', '-A');
  git('config', 'user.name', fixtureOwner.name);
  git('config', 'user.email', fixtureOwner.email);
  const tree = git('write-tree');
  const revision = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD'], {
    cwd: root,
    env: fixtureOwnerEnvironment(),
    input: 'Disposable TEST retained-history source\n',
    encoding: 'utf8',
  }).trim();
  git('reset', '--quiet', '--hard', revision);
  return revision;
}

async function assertPublishedPackageMode(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {throw new Error('published optimizer archive contains a symlink');}
  if (stat.isDirectory()) {
    assert.equal(stat.mode & 0o7777, 0o755, 'published optimizer archive directory mode');
    for (const child of (await readdir(path)).toSorted()) {await assertPublishedPackageMode(join(path, child));}
  } else if (stat.isFile()) {
    assert.equal(stat.mode & 0o7777, 0o644, 'published optimizer archive file mode');
  } else {
    throw new Error('published optimizer archive contains an unsupported kind');
  }
}

export async function admitPublishedComparator(): Promise<LeafInventoryComparator> {
  const root = process.env.TEST_PUBLISHED_COMPARATOR_ROOT ?? repository;
  return ((base, head, structuralPaths) => {
    const source = `${fixtureBootstrapImport}
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const compare = await admitAndImportOptimizer(process.cwd());
process.stdout.write(JSON.stringify(compare(input.base, input.head, input.structuralPaths)));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: root,
      env: fixtureExecutionEnvironment(process.env.TMPDIR ?? tmpdir()),
      input: JSON.stringify({ base, head, structuralPaths }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null);
    return JSON.parse(result.stdout) as ReturnType<LeafInventoryComparator>;
  }) as LeafInventoryComparator;
}

export async function copyPublishedOptimizer(target: string): Promise<void> {
  const source = await realpath(join(repository, 'node_modules/@agent-teams/ci-input-proof'));
  await assertPublishedPackageMode(source);
  await cp(source, target, { recursive: true, dereference: true });
  await assertPublishedPackageMode(target);
}

async function installPnpmFixture(root: string, temporary: string): Promise<void> {
  const env = fixtureExecutionEnvironment(temporary);
  const storeDirectory = process.env.TEST_PNPM_STORE_DIR;
  const installArguments = ['install', '--frozen-lockfile'];
  if (storeDirectory) {installArguments.push('--offline', '--store-dir', storeDirectory);}
  assert.equal(execFileSync('pnpm', ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(), '11.18.0');
  execFileSync('pnpm', installArguments, { cwd: root, env, stdio: 'pipe' });
  assert.equal(execFileSync('pnpm', ['exec', 'tsc', '--version'], { cwd: root, env, encoding: 'utf8' }).trim(), 'Version 7.0.2');
}

async function resetNodeModules(root: string): Promise<string> {
  const targetModules = join(root, 'node_modules');
  await rm(targetModules, { recursive: true, force: true });
  return targetModules;
}

export async function installHistoricalNodeModulesFixture(root: string,
  temporary = process.env.TMPDIR ?? tmpdir()): Promise<void> {
  await resetNodeModules(root);
  await installPnpmFixture(root, temporary);
}

export async function installNodeModulesFixture(root: string, optimizer: ActualMeasureOptimizer,
  temporary = process.env.TMPDIR ?? tmpdir()): Promise<void> {
  const targetModules = await resetNodeModules(root);
  await installPnpmFixture(root, temporary);
  const optimizerTarget = join(targetModules, '.pnpm/@agent-teams+ci-input-proof@0.1.0/node_modules/@agent-teams/ci-input-proof');
  if (optimizer === 'absent') {
    await rm(optimizerTarget, { recursive: true, force: true });
    await mkdir(optimizerTarget, { recursive: true });
  } else {
    const isolated = await mkdtemp(join(temporary, 'ar-optimizer-entry-TEST-'));
    try {
      await chmod(isolated, 0o755);
      await cp(optimizerTarget, isolated, { recursive: true, dereference: true });
      await rm(optimizerTarget, { recursive: true, force: true });
      await cp(isolated, optimizerTarget, { recursive: true, dereference: true });
      await assertPublishedPackageMode(optimizerTarget);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
    if (optimizer === 'marker') {
      const entry = join(optimizerTarget, 'dist/index.js');
      await writeFile(entry, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'optimizer-import-marker'))}, 'executed\\n');\n${await readFile(entry, 'utf8')}`);
    }
  }
}

export async function actualMeasureFixture(t: TestContext, options: ActualMeasureFixtureOptions = {}): Promise<ActualMeasureFixture> {
  const root = await testScratch('ar-actual-measure-TEST-');
  const evidence = `${root}-evidence`, temporary = `${root}-tmp`;
  await Promise.all([mkdir(evidence), mkdir(temporary)]);
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(evidence, { recursive: true, force: true }), rm(temporary, { recursive: true, force: true })]));
  const revision = await createRetainedSourceCheckout(root);
  await installNodeModulesFixture(root, options.optimizer ?? 'linked', temporary);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('config', 'user.name', fixtureOwner.name); git('config', 'user.email', fixtureOwner.email);
  if (options.missing === 'bootstrap-test') {await rm(join(root, 'scripts/ci/pr-regression-bootstrap.test.ts'));}
  if (options.missing === 'bootstrap') {await rm(join(root, 'scripts/ci/pr-regression-bootstrap.ts'));}
  return { root, evidence, env: fixtureExecutionEnvironment(temporary, {
    EXPECTED_REVISION: revision, CI_EVIDENCE_DIR: evidence,
    TEST_PUBLISHED_COMPARATOR_ROOT: process.env.TEST_PUBLISHED_COMPARATOR_ROOT ?? repository }) };
}

export function runActualMeasureGraph(fixture: ActualMeasureFixture): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...fixture.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ['scripts/ci/measure.ts', 'check:ci:quick'], { cwd: fixture.root, env, encoding: 'utf8' });
}

interface MeasureFailureReport {
  sourceComplete: boolean;
  phases: Array<{ script: string; code: number | null; signal: NodeJS.Signals | null; tests: Array<{ name: string }> }>;
}

async function measureFailureReport(fixture: ActualMeasureFixture): Promise<MeasureFailureReport> {
  return JSON.parse(await readFile(join(fixture.evidence, 'check-ci-quick.json'), 'utf8')) as MeasureFailureReport;
}

export async function assertMeasureFailureHandling(t: TestContext): Promise<void> {
  const complete = await actualMeasureFixture(t);
  await configureMeasurePhaseFixture(complete, { child: { kind: 'exit', code: 23 }, phaseOrder: ['test:ci'] });
  const failed = runActualMeasureGraph(complete);
  assert.equal(failed.status, 23, `${failed.stdout}\n${failed.stderr}`);
  assert.equal(failed.signal, null);
  const failedReport = await measureFailureReport(complete);
  assert.equal(failedReport.sourceComplete, true);
  assert.deepEqual(failedReport.phases.map(phase => phase.script), ['test:ci']);
  assert.equal(failedReport.phases[0]?.code, 23);
  assert.equal(failedReport.phases[0]?.signal, null);
  assert.deepEqual(failedReport.phases[0]?.tests, []);

  const incomplete = await actualMeasureFixture(t);
  await configureMeasurePhaseFixture(incomplete, {
    child: { kind: 'exit', code: 23 }, sourceComplete: false,
    phaseOrder: ['test:ci', 'lint', 'check:node-compat', 'typecheck:ci'],
  });
  const continued = runActualMeasureGraph(incomplete);
  assert.equal(continued.status, 23, `${continued.stdout}\n${continued.stderr}`);
  const continuedReport = await measureFailureReport(incomplete);
  assert.equal(continuedReport.sourceComplete, false);
  assert.deepEqual(continuedReport.phases.map(phase => [phase.script, phase.code, phase.signal]),
    [['test:ci', 23, null], ['lint', 0, null], ['check:node-compat', 0, null], ['typecheck:ci', 0, null]]);
  assert.deepEqual(continuedReport.phases[0]?.tests, []);

  const signalled = await actualMeasureFixture(t);
  await configureMeasurePhaseFixture(signalled, { child: { kind: 'signal', signal: 'SIGKILL' }, phaseOrder: ['test:ci'] });
  const signalResult = runActualMeasureGraph(signalled);
  assert.equal(signalResult.signal, 'SIGKILL');
  assert.equal(signalResult.status, null,
    `${signalResult.status ?? ''} ${signalResult.signal ?? ''}`);
  const signalReport = await measureFailureReport(signalled);
  assert.equal(signalReport.phases[0]?.code, null);
  assert.equal(signalReport.phases[0]?.signal, 'SIGKILL');
  assert.deepEqual(signalReport.phases[0]?.tests, []);

  const successful = await actualMeasureFixture(t);
  await configureMeasurePhaseFixture(successful, { child: { kind: 'success' }, phaseOrder: ['test:ci'] });
  const noIdentity = runActualMeasureGraph(successful);
  assert.notEqual(noIdentity.status, 0);
  assert.equal(noIdentity.signal, null);
  const successfulReport = await measureFailureReport(successful);
  assert.equal(successfulReport.phases[0]?.code, 0);
  assert.equal(successfulReport.phases[0]?.signal, null);
  assert.deepEqual(successfulReport.phases[0]?.tests, []);
}

export async function configureMeasurePhaseFixture(fixture: ActualMeasureFixture,
  options: MeasurePhaseFixtureOptions): Promise<void> {
  const child = join(fixture.root, 'scripts/ci/disposable-measure-child.ts');
  const source = options.child.kind === 'exit' ? `process.exitCode = ${options.child.code};\n`
    : options.child.kind === 'signal'
      ? `process.kill(process.ppid, ${JSON.stringify(options.child.signal)});\nprocess.kill(process.pid, ${JSON.stringify(options.child.signal)});\n`
      : 'process.exitCode = 0;\n';
  await writeFile(child, source);
  const manifestPath = join(fixture.root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { scripts: Record<string, string> };
  const phaseOrder = options.phaseOrder ?? ['lint', 'check:node-compat', 'typecheck:ci', 'test:ci'];
  for (const phase of phaseOrder) {
    manifest.scripts[phase] = phase === 'test:ci' ? `node ${relative(fixture.root, child)}` : 'node -e ""';
  }
  manifest.scripts['check:ci:quick'] = phaseOrder.map(phase => `pnpm ${phase}`).join(' && ');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (options.sourceComplete === false) {await rm(join(fixture.root, 'scripts/ci/pr-regression-bootstrap.ts'));}
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

export function runActualRegressionImportGraph(fixture: ActualMeasureFixture): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...fixture.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  if (env.TEST_ACTUAL_REGRESSION_GRAPH === '1') {
    return spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', 'scripts/ci/pr-regression-inputs.test.ts'],
      { cwd: fixture.root, env, encoding: 'utf8' });
  }
  return runActualMeasureGraph({ ...fixture, env: { ...fixture.env, TEST_ACTUAL_REGRESSION_GRAPH: '1' } });
}
