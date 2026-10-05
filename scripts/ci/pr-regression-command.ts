import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readScripts } from './inventory.ts';
import { groups } from './policy.ts';
import type { Group } from './policy.ts';
import { assertCmsComposite, captureCmsComposite, cmsBinding, cmsContract, cmsDirectCommand, cmsMandatoryCommand,
  createTestResultCollector, mandatoryRunnerSummary } from './measure.ts';
import type { NodeSummary, TestResult } from './measure.ts';
import { classifyPrRegressions, currentPrInput, installationFingerprint, regressionCommands } from './pr-regression-inputs.ts';
import type { PrPlan, RegressionId } from './pr-regression-inputs.ts';

export interface Execution { code: number | null; signal: string | null; tests: TestResult[]; mandatory: string[]; nodeSummaries?: NodeSummary[] }
export interface Obligation { id: string; command: string; regression?: RegressionId }
export type ObservedObligation = Obligation & (
  { disposition: 'executed'; execution: Execution }
  | { disposition: 'deferred-unchanged-regression-inputs'; tests: [] }
);

type RequiredTest = Pick<TestResult, 'suite' | 'ancestry' | 'name' | 'kind' | 'depth'>;
const foundationFiles = ['scripts/architecture/source-dependency-adapter-boundaries.test.mjs',
  'scripts/docs/runtime-builtin-permissions.test.mjs', 'scripts/ci/run-ordinary-postgres.test.mjs'] as const;
const foundationCommand = `node --test ${foundationFiles.join(' ')}`;
const foundationSuite = 'installed Foundation adapter boundary checks';
const foundationRegistrationFile = 'scripts/ci/foundation-fixture-sharding.ts';

// The existing Foundation aggregate's original-source oracle, independent of
// the sharding helper's name table. The other two original files remain required.
export async function foundationNegativeTests(root: string): Promise<RequiredTest[]> {
  const required: RequiredTest[] = [];
  for (const [index, suite] of foundationFiles.entries()) {
    const source = await readFile(join(root, suite), 'utf8');
    const pattern = index === 0 ? /^  test\("([^"]+)",/gmu : /^test\("([^"]+)",/gmu;
    const names = [...source.matchAll(pattern)].map(match => match[1]!);
    assert.equal(names.length, [25, 5, 3][index], `incomplete original Foundation registrations: ${suite}`);
    assert.equal(new Set(names).size, names.length, `duplicate original Foundation registration: ${suite}`);
    // Node reports the boundary leaves at their registration wrapper's file;
    // the containing suite reports the original file. Retain both real sites.
    required.push(...names.map(name => ({ suite: index === 0 ? foundationRegistrationFile : suite, name,
      ancestry: [], depth: index === 0 ? 1 : 0, kind: 'test' as const })));
    if (index === 0) {required.push({ suite, name: foundationSuite, ancestry: [], depth: 0, kind: 'suite' });}
  }
  return required;
}

const testIdentity = (result: RequiredTest) => JSON.stringify([result.suite, result.ancestry, result.name, result.kind, result.depth]);
function assertFoundationNegativeExecution(execution: Execution, required: readonly RequiredTest[] | undefined): void {
  assert.ok(required?.length === 34, 'missing independent original Foundation registrations');
  assert.deepEqual(execution.tests.map(testIdentity).toSorted(), required.map(testIdentity).toSorted(),
    'missing, mutated or duplicate original Foundation test execution');
  assert.equal(execution.nodeSummaries?.length, 1, 'missing or duplicate Foundation Node summary');
  const summary = execution.nodeSummaries[0]!;
  assert.equal(summary.success, true, 'incomplete Foundation Node execution');
  assert.deepEqual(summary.counts, { tests: 33, suites: 1, passed: 33, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 9 },
    'incomplete Foundation Node counts');
}

// Fixed commands come from the reviewed script inventory, never an event payload.
// This observes real stdout and exit/signal; deferrals never enter this function.
export async function observeRegressionProcess(command: string, root: string, env: NodeJS.ProcessEnv): Promise<Execution> {
  const foundation = command === regressionCommands['foundation-negative'];
  if (foundation) {
    assert.equal((await readScripts(join(root, 'package.json')))['foundation:boundaries:negative'], foundationCommand,
      'original three-file Foundation command drift');
  }
  const serialCommand = foundation ? foundationCommand : command;
  const tokens = serialCommand.split(' '), executable = tokens.shift(); assert.ok(executable);
  const directNodeTest = executable === 'node' && tokens[0] === '--test';
  const file = executable === 'node' ? process.execPath : executable === 'pnpm' ? 'pnpm' : resolvePath(root, 'node_modules/.bin', executable);
  const args = directNodeTest ? [...tokens.slice(0, 1), `--test-reporter=${fileURLToPath(new URL('./measure.ts', import.meta.url))}`, ...tokens.slice(1)] : tokens;
  const childEnv = { ...env }; delete childEnv.NODE_TEST_CONTEXT;
  if (foundation) {
    // Serial PR FULL and sampled execution never inherit the non-PR shard route.
    for (const key of ['FOUNDATION_FIXTURE_PROTOCOL', 'FOUNDATION_FIXTURE_INDEX', 'FOUNDATION_FIXTURE_COUNT']) {delete childEnv[key];}
  }
  const child = spawn(file, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  const execution: Execution = { code: null, signal: null, tests: [], mandatory: [], nodeSummaries: [] };
  const observe = createTestResultCollector();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    console.log(line);
    const result = directNodeTest && line.startsWith('CI_NODE_EVENT ') ? JSON.parse(line.slice(14)) as TestResult : observe(line);
    if (result) {execution.tests.push(result);}
    if (directNodeTest && line.startsWith('CI_NODE_SUMMARY ')) {execution.nodeSummaries!.push(JSON.parse(line.slice(16)) as NodeSummary);}
    const summary = mandatoryRunnerSummary(line); if (summary) {execution.mandatory.push(summary);}
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { execution.code = code; execution.signal = signal; resolve(); });
  });
  return execution;
}

export function assertPrObligations(expected: readonly Obligation[], observed: readonly ObservedObligation[], deferred: readonly RegressionId[], foundationRequired?: readonly RequiredTest[]): void {
  assert.deepEqual(observed.map(({ id, command }) => ({ id, command })), expected.map(({ id, command }) => ({ id, command })), 'missing, duplicate or reordered PR obligation');
  assert.equal(new Set(observed.map(item => item.id)).size, observed.length, 'duplicate obligation');
  for (const [i, item] of observed.entries()) {
    const declaration = expected[i]!;
    assert.equal(item.regression, declaration.regression, 'regression identity drift');
    if (item.disposition === 'deferred-unchanged-regression-inputs') {
      assert.ok(declaration.regression && deferred.includes(declaration.regression), 'unadmitted deferral');
      assert.deepEqual(item.tests, [], 'a deferral claims zero executed test identities');
      assert.deepEqual(Object.keys(item).toSorted(), ['id', 'command', 'regression', 'disposition', 'tests'].toSorted());
    } else {
      assert.equal(item.disposition, 'executed');
      assert.ok(!declaration.regression || !deferred.includes(declaration.regression), 'wrong disposition');
      assert.equal(item.execution.code, 0, 'failed or missing command'); assert.equal(item.execution.signal, null, 'cancelled command');
      assert.ok(item.execution.tests.every(result => result.status === 'passed'), 'failed, skipped, todo or cancelled test');
      if (declaration.regression === 'foundation-negative') {assertFoundationNegativeExecution(item.execution, foundationRequired);}
      // Pretty CLI output lacks source sites and can forward repeated fixture
      // names. Enforce identity uniqueness for actual public Node events only.
      if (declaration.regression === 'foundation-negative' || /^node --test(?: |$)/u.test(item.command)) {
        const identities = item.execution.tests.map(result => JSON.stringify([result.suite, result.ancestry, result.name, result.kind]));
        assert.equal(new Set(identities).size, identities.length, 'duplicate observed test identity');
      }
      if (/node --test|agent-teams-node-test/u.test(item.command) || /^pnpm (?:test:|foundation:boundaries:negative|docs:qualification:(?:serial|portable))/u.test(item.command)) {
        assert.ok(item.execution.tests.length > 0 || item.execution.mandatory.length === 1, 'no observed test execution');
      }
    }
  }
}

const phase = (id: string, command = `pnpm ${id}`): Obligation => ({ id, command });
const regression = (id: RegressionId): Obligation => ({ id, command: regressionCommands[id], regression: id });
export function prObligations(group: Group): Obligation[] {
  if (group === 'foundation') {return [phase('foundation-source', 'agent-teams-foundation check'), regression('foundation-negative'),
    phase('foundation:assert-dev-only'), phase('foundation:assert-registry'), phase('quality:adoption'), phase('foundation:scaffold:check')];}
  if (group === 'docs') {return [phase('docs:protocol:check'), phase('docs:qualification:typecheck'), phase('docs:qualification:serial'), regression('docs-portable')];}
  assert.ok(group === 'quick' || group === 'architecture', 'product scheduling stays with Runtime full product route');
  return groups[group].flatMap(id => {
    if (id === 'test:feature-modules') {return [regression('fms')];}
    if (id === 'test:consumer-modules') {return [regression('cms-regression'), phase('cms-direct', cmsDirectCommand), phase('cms-mandatory', cmsMandatoryCommand)];}
    return [phase(id)];
  });
}

export async function runPrRegressions(group: Group, output: string): Promise<void> {
  const root = process.cwd(), scripts = await readScripts(join(root, 'package.json'));
  assert.ok(scripts[`check:ci:${group}`], 'known CI group');
  const input = await currentPrInput(root, process.env);
  const plan: PrPlan = await classifyPrRegressions(root, input);
  const expected = prObligations(group);
  const foundationRequired = expected.some(item => item.regression === 'foundation-negative' && !plan.deferred.includes(item.regression))
    ? await foundationNegativeTests(root) : undefined;
  const report = { protocol: 'pr-regression-execution/1', group, plan,
    runner: { runtime: input.runtime, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
      environment: process.env.RUNNER_ENVIRONMENT, repository: process.env.GITHUB_REPOSITORY,
      workflowRef: process.env.GITHUB_WORKFLOW_REF, workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT },
    obligations: [] as ObservedObligation[] };
  await mkdir(output, { recursive: true });
  const save = () => writeFile(join(output, `pr-${group}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await save();
  for (const item of expected) {
    if (item.regression && plan.deferred.includes(item.regression)) {
      report.obligations.push({ ...item, disposition: 'deferred-unchanged-regression-inputs', tests: [] });
    } else if (item.id === 'cms-direct') {
      const cms = await captureCmsComposite();
      // The existing pin contract remains authoritative for BOTH processes.
      assertCmsComposite(cms, await cmsBinding(), cms.direct.tests, JSON.parse(await readFile(cmsContract, 'utf8')));
      assert.ok(cms.mandatory);
      report.obligations.push({ ...item, disposition: 'executed', execution: { ...cms.direct, mandatory: [] } },
        { ...expected.find(value => value.id === 'cms-mandatory')!, disposition: 'executed', execution: { ...cms.mandatory, tests: [], mandatory: cms.mandatory.summaries } });
    } else if (item.id !== 'cms-mandatory') {
      // currentPrInput already observes the frozen installation before this lane.
      // The final observation rejects drift across the entire execution.
      const execution = await observeRegressionProcess(item.command, root, process.env);
      report.obligations.push({ ...item, disposition: 'executed', execution });
      await save();
      assertPrObligations(expected.slice(0, report.obligations.length), report.obligations, plan.deferred, foundationRequired);
    }
    await save();
  }
  if (plan.mode === 'affected-pr') {
    assert.equal(await installationFingerprint(root), plan.installation, 'installed drift during PR');
    assert.deepEqual(await classifyPrRegressions(root, input), plan, 'current source/scope drift during PR');
  }
  assertPrObligations(expected, report.obligations, plan.deferred, foundationRequired);
  console.log(`PR regression sampling ${plan.mode}: ${plan.deferred.join(', ') || 'all regressions executed'}; no historical pass reused.`);
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const group = process.argv[2]?.replace('check:ci:', '');
  assert.ok(group === 'quick' || group === 'foundation' || group === 'architecture' || group === 'docs', 'known PR group');
  await runPrRegressions(group, process.env.CI_EVIDENCE_DIR ?? 'tmp/root-export-evidence/pr-regressions');
}
