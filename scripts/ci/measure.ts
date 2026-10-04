import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { assertRevision, productPhases, requiredJobs } from './policy.ts';
import { readScripts } from './inventory.ts';
import { commandInventory } from './script-routing.ts';
import type { TestEvent } from 'node:test/reporters';
import type { Command, Scripts } from './script-routing.ts';

export interface TestResult { suite: string; name: string; ancestry: string[]; depth: number; status: string; kind?: 'suite' | 'test' }
export const cmsFile = 'scripts/architecture/check-cms-pin.test.mjs';
export const cmsContract = 'architecture/foundation/mandatory-node-tests.json';
export const cmsDirectCommand = `node --test ${cmsFile}`;
export const cmsMandatoryCommand = `agent-teams-node-test --contract ${cmsContract} -- ${cmsFile}`;
export type NodeSummary = Pick<Extract<TestEvent, { type: 'test:summary' }>['data'], 'counts' | 'success'>;

// Public reporting starts retain parent ancestry; execution enqueue order can interleave unrelated tests.
export function createNodeEventCollector() {
  const stacks = new Map<string, Array<{ depth: number; name: string }>>();
  const identities = new Map<string, string[]>();
  return (event: TestEvent): TestResult | undefined => {
    if (event.type !== 'test:start' && event.type !== 'test:pass' && event.type !== 'test:fail') { return; }
    const data = event.data;
    const suite = data.file ? relative(process.cwd(), data.file).replaceAll('\\', '/') : 'root';
    const key = JSON.stringify([suite, data.line, data.column, data.nesting, data.name]);
    if (event.type === 'test:start') {
      const parents = (stacks.get(suite) ?? []).filter(frame => frame.depth < data.nesting);
      identities.set(key, parents.map(frame => frame.name));
      stacks.set(suite, [...parents, { depth: data.nesting, name: data.name }]);
      return;
    }
    const ancestry = identities.get(key);
    assert.ok(ancestry, `missing Node reporting identity: ${data.name}`);
    return { suite, name: data.name, ancestry, depth: data.nesting, kind: event.data.details.type ?? 'test',
      status: event.data.skip ? 'skip' : event.data.todo ? 'todo' : event.type === 'test:pass' ? 'passed' : 'failed' };
  };
}

// The exact direct leaf selects this reporter via NODE_OPTIONS, never a private runner import.
export default async function* nodeEventReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const observe = createNodeEventCollector();
  for await (const event of source) {
    const result = observe(event);
    if (result) { yield `CI_NODE_EVENT ${JSON.stringify(result)}\n`; }
    if (event.type === 'test:summary' && event.data.file === undefined) {
      yield `CI_NODE_SUMMARY ${JSON.stringify({ counts: event.data.counts, success: event.data.success })}\n`;
    }
  }
}

export interface ProcessProof {
  command: string; code: number | null; signal: string | null; timedOut: boolean;
  before: Record<string, string>; after: Record<string, string>;
}
export interface CmsComposite {
  phase: 'test:consumer-modules'; exceptions: unknown[];
  direct: ProcessProof & { tests: TestResult[]; summaries: NodeSummary[] };
  mandatory: (ProcessProof & { summaries: string[] }) | null;
}
const protectedCmsNames = ['rejects split profile pins', 'rejects retained standard bytes that differ from the pin',
  'rejects a delta detached from its review digest'];
const cmsInputPaths = [cmsFile, cmsContract, 'scripts/architecture/check-cms-pin.mjs',
  'architecture/get-modular/consumer-profile.json', 'architecture/consumer-module-standard/contained-turn-profile.json',
  'architecture/get-modular/evidence/consumer-module-standard.md',
  'architecture/get-modular/evidence/consumer-module-standard-9c722ce.md',
  'architecture/get-modular/evidence/smart-ci-cms-pin-review.json',
  'architecture/get-modular/evidence/smart-ci-cms-pin-delta.diff',
  'architecture/get-modular/evidence/runtime-profile-cms-pin-review.json',
  'architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json',
  'architecture/get-modular/evidence/creation-cleanup-cms-pin-delta.diff'];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function cmsBinding(): Promise<Record<string, string>> {
  const binding: Record<string, string> = {};
  for (const path of [...inputPaths, ...cmsInputPaths]) { binding[path] = hash(await readFile(path)); }
  const installed = 'node_modules/@agent-teams/engineering-foundation';
  const files = (await readdir(installed, { recursive: true, withFileTypes: true })).filter(file => file.isFile());
  const fingerprints = await Promise.all(files.map(async file => {
    const path = join(file.parentPath, file.name);
    return [relative(installed, path), hash(await readFile(path))];
  }));
  binding.installedFoundation = hash(JSON.stringify(fingerprints.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  return binding;
}
export function assertCmsComposite(cms: CmsComposite, binding: Record<string, string>, phaseTests: readonly TestResult[],
  contract: { schemaVersion: number; required: Array<{ file: string; names: string[]; kind: string }>; exceptions: unknown[] }): void {
  assert.equal(cms.phase, 'test:consumer-modules');
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.exceptions, [], 'CMS exceptions forbidden');
  assert.deepEqual(cms.exceptions, [], 'CMS exceptions forbidden');
  assert.deepEqual(contract.required.map(identity => ({ file: identity.file, names: identity.names, kind: identity.kind })),
    protectedCmsNames.map(name => ({ file: cmsFile, names: [name], kind: 'test' })), 'protected CMS contract drift');
  assert.ok(cms.mandatory, 'missing mandatory process');
  for (const proof of [cms.direct, cms.mandatory]) {
    assert.equal(proof.code, 0, 'CMS process failed or missing');
    assert.equal(proof.signal, null, 'CMS process cancelled');
    assert.equal(proof.timedOut, false, 'CMS process timed out');
    assert.deepEqual(proof.before, binding, 'CMS input fingerprint drift');
    assert.deepEqual(proof.after, binding, 'CMS input fingerprint drift during execution');
  }
  assert.equal(cms.direct.command, cmsDirectCommand, 'direct CMS command drift');
  assert.equal(cms.mandatory.command, cmsMandatoryCommand, 'mandatory CMS command drift');
  assert.deepEqual(Object.keys(cms.mandatory).toSorted(), ['command', 'code', 'signal', 'timedOut', 'before', 'after', 'summaries'].toSorted(), 'CLI cannot claim individual events');
  assert.deepEqual(cms.mandatory.summaries, [`Mandatory Node tests: ${contract.required.length} required identities completed or exactly excepted`], 'wrong mandatory success summary');
  assert.equal(cms.direct.summaries.length, 1, 'missing Node summary');
  const summary = cms.direct.summaries[0];
  assert.ok(summary?.success && summary.counts.tests > 0, 'Node execution incomplete');
  for (const key of ['cancelled', 'skipped', 'todo'] as const) { assert.equal(summary.counts[key], 0, `CMS ${key}`); }
  const observed = cms.direct.tests;
  assert.ok(observed.every(test => test.suite === cmsFile && test.status === 'passed' && ['suite', 'test'].includes(test.kind ?? '')), 'CMS identity failed/skipped/todo or file drift');
  assert.equal(observed.filter(test => test.kind === 'test').length, summary.counts.tests, 'missing direct CMS identity');
  assert.equal(summary.counts.passed, summary.counts.tests, 'incomplete Node pass count');
  assert.equal(observed.filter(test => test.kind === 'suite').length, summary.counts.suites, 'missing direct CMS suite');
  const identities = observed.map(test => JSON.stringify([test.suite, test.ancestry, test.name, test.kind]));
  assert.equal(new Set(identities).size, identities.length, 'duplicate CMS identity');
  for (const required of contract.required) {
    assert.ok(observed.some(test => test.kind === required.kind && JSON.stringify([...test.ancestry, test.name]) === JSON.stringify(required.names)), 'missing protected CMS identity');
  }
  assert.deepEqual(phaseTests.filter(test => test.suite === cmsFile), observed, 'CMS phase identity binding');
}

async function cmsProcess(command: string, direct: boolean) {
  const before = await cmsBinding();
  const tests: TestResult[] = [], summaries: string[] = [], nodeSummaries: NodeSummary[] = [];
  const observe = createTestResultCollector();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (direct) { env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --test-reporter=${fileURLToPath(import.meta.url)}`.trim(); }
  const executable = command.startsWith('node ') ? process.execPath : resolvePath('node_modules/.bin/agent-teams-node-test');
  const args = command.startsWith('node ') ? command.split(' ').slice(1) : ['--contract', cmsContract, '--', cmsFile];
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 300_000);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (line.startsWith('CI_NODE_EVENT ')) { tests.push(JSON.parse(line.slice(14)) as TestResult); }
    else if (line.startsWith('CI_NODE_SUMMARY ')) { nodeSummaries.push(JSON.parse(line.slice(16)) as NodeSummary); }
    else { const result = observe(line); if (result) { tests.push(result); } }
    if (command === cmsMandatoryCommand) {
      const summary = mandatoryRunnerSummary(line);
      if (summary) { summaries.push(summary); }
    }
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  return { command, ...outcome, timedOut, before, after: await cmsBinding(), tests, summaries, nodeSummaries };
}
export async function captureCmsComposite(): Promise<CmsComposite> {
  const contract: { exceptions: unknown[] } = JSON.parse(await readFile(cmsContract, 'utf8'));
  const direct = await cmsProcess(cmsDirectCommand, true);
  const mandatory = direct.code === 0 && direct.signal === null ? await cmsProcess(cmsMandatoryCommand, false) : null;
  return { phase: 'test:consumer-modules', exceptions: contract.exceptions,
    direct: { command: direct.command, code: direct.code, signal: direct.signal, timedOut: direct.timedOut,
      before: direct.before, after: direct.after, tests: direct.tests, summaries: direct.nodeSummaries },
    mandatory: mandatory && { command: mandatory.command, code: mandatory.code, signal: mandatory.signal,
      timedOut: mandatory.timedOut, before: mandatory.before, after: mandatory.after, summaries: mandatory.summaries } };
}

export function tapResult(line: string): TestResult | undefined {
  const tap = /^(?:(.*?) (?:test|check): )?(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: .*)?)?$/u.exec(line);
  if (tap) {
    return { suite: tap[1] ?? 'root', ancestry: [], depth: (tap[2] ?? '').length, name: tap[4] ?? '',
      status: tap[5]?.toLowerCase() ?? (tap[3] === 'ok' ? 'passed' : 'failed') };
  }
  // Node 24's default spec reporter is also used by the existing full scripts.
  const spec = /^(?:(.*?) (?:test|check): )?(\s*)([✔✖﹣-]) (.*?) \([\d.]+ms\)(?: # (SKIP|TODO)(?: .*)?)?$/u.exec(line);
  if (!spec) { return undefined; }
  return { suite: spec[1] ?? 'root', ancestry: [], depth: (spec[2] ?? '').length, name: spec[4] ?? '',
    status: spec[5]?.toLowerCase() ?? (spec[3] === '✔' ? 'passed' : spec[3] === '✖' ? 'failed' : 'skip') };
}

// One collector per process; pnpm's package prefixes isolate multiplexed suites.
// TAP emits parent headings before children and parent results after children.
export function createTestResultCollector(): (line: string) => TestResult | undefined {
  const stacks = new Map<string, Array<{ depth: number; name: string }>>();
  return line => {
    const prefix = /^(.*?) (?:test|check): (.*)$/u.exec(line);
    const suite = prefix?.[1] ?? 'root';
    const body = prefix?.[2] ?? line;
    const heading = /^(\s*)(?:# Subtest: |▶ )(.*)$/u.exec(body);
    const result = tapResult(line);
    if (!heading && !result) { return; }
    const depth = heading ? (heading[1] ?? '').length : result?.depth ?? 0;
    const parents = (stacks.get(suite) ?? []).filter(frame => frame.depth < depth);
    if (heading) {
      stacks.set(suite, [...parents, { depth, name: heading[2] ?? '' }]);
      return;
    }
    assert.ok(result);
    stacks.set(suite, parents);
    return { ...result, ancestry: parents.map(frame => frame.name) };
  };
}


export const inputPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version',
  'scripts/ci/full-contract.json', 'experiments/rust-system-boundaries/rust-toolchain.toml',
  'experiments/rust-system-boundaries/Cargo.lock', 'scripts/ci/measure.ts', 'scripts/ci/compare.ts',
  'scripts/ci/policy.ts', 'scripts/ci/script-routing.ts', 'scripts/ci/conformance.ts', 'scripts/ci/gate.ts',
  'scripts/ci/inventory.ts', 'scripts/ci/contracts.test.ts', 'scripts/ci/tsconfig.json',
  'scripts/ci/cms-pin-review.ts', 'scripts/ci/cms-pin-review.test.ts'] as const;

export function toolchainKeys(entry: string): string[] {
  return entry === 'check' || /^check:ci:product(?::(?:packages|root|native))?$/u.test(entry)
    ? ['typescript', 'rustc', 'cargo', 'cc', 'ld'] : ['typescript'];
}

const toolVersion = (command: string, args: string[], cwd?: string) =>
  execFileSync(command, args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) }).trim();

function observedToolchain(entry: string): Record<string, string> {
  const toolchain: Record<string, string> = { typescript: toolVersion('pnpm', ['exec', 'tsc', '--version']) };
  if (toolchainKeys(entry).includes('rustc')) {
    // Use the same directory as the guardian build, so rustup selects its pin.
    toolchain.rustc = toolVersion('rustc', ['--version', '--verbose'], 'experiments/rust-system-boundaries');
    toolchain.cargo = toolVersion('cargo', ['--version'], 'experiments/rust-system-boundaries');
    toolchain.cc = toolVersion('cc', ['--version']);
    toolchain.ld = toolVersion('ld', ['--version']);
  }
  return toolchain;
}

export function mandatoryRunnerSummary(line: string): string | undefined {
  return /^Mandatory Node tests: [1-9][0-9]* required identities completed or exactly excepted$/u.exec(line)?.[0];
}

export function assertPhaseTestExecution(phase: { script: string; commands: readonly Command[];
  tests: readonly TestResult[]; unqualifiedRunners: readonly string[] }): void {
  if (phase.commands.some(command => /(?:node --test|agent-teams-node-test|\brun test\b)/u.test(command.command))
    || /^(?:test(?::|$)|quality:native$)/u.test(phase.script)) {
    assert.ok(phase.tests.length > 0 || phase.unqualifiedRunners.some(summary => mandatoryRunnerSummary(summary)),
      `${phase.script} emitted no test execution evidence`);
  }
}

function phases(scripts: Scripts, entry: string): string[] {
  if (entry === 'check') { return requiredJobs.flatMap(group => phases(scripts, `check:ci:${group}`)); }
  assert.ok([...requiredJobs.map(group => `check:ci:${group}`), ...Object.keys(productPhases)].includes(entry), 'unknown full lane');
  const command = scripts[entry];
  assert.ok(command);
  return command.split(' && ').flatMap(token => {
    const name = /^pnpm ([\w:-]+)$/u.exec(token)?.[1];
    assert.ok(name, 'lane must be a blocking pnpm chain');
    return name.startsWith('check:ci:') ? phases(scripts, name) : [name];
  });
}

async function runPhase(script: string, scripts: Scripts) {
  if (script === 'test:consumer-modules') {
    assert.deepEqual(commandInventory(scripts, script).map(command => command.command), ['node --test scripts/architecture/check-consumer-module-standard.test.mjs', cmsDirectCommand, cmsMandatoryCommand], 'CMS process commands');
    const started = new Date().toISOString(), start = performance.now();
    const fixtures = await cmsProcess('node --test scripts/architecture/check-consumer-module-standard.test.mjs', false);
    const cms = fixtures.code === 0 && fixtures.signal === null ? await captureCmsComposite() : undefined;
    const outcome = cms?.mandatory ?? cms?.direct ?? fixtures;
    return { script, commands: commandInventory(scripts, script), started, ended: new Date().toISOString(),
      wallMs: performance.now() - start, code: outcome.code, signal: outcome.signal,
      tests: [...fixtures.tests, ...(cms?.direct.tests ?? [])], unqualifiedRunners: [] as string[], cms };
  }
  const started = new Date().toISOString();
  const start = performance.now();
  const tests: TestResult[] = [];
  const observe = createTestResultCollector();
  const unqualifiedRunners: string[] = [];
  console.log(`::group::pnpm ${script}`);
  const child = spawn('pnpm', ['run', script], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    console.log(line);
    const result = observe(line);
    if (result) { tests.push(result); }
    const summary = mandatoryRunnerSummary(line);
    if (summary) { unqualifiedRunners.push(summary); }
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  console.log('::endgroup::');
  return { script, commands: commandInventory(scripts, script), started, ended: new Date().toISOString(),
    wallMs: performance.now() - start, ...outcome, tests, unqualifiedRunners };
}

export async function measure(entry: string, output: string): Promise<number> {
  const scripts = await readScripts('package.json');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assertRevision(sha, process.env.EXPECTED_REVISION ?? '');
  const digests: Record<string, string> = {};
  for (const path of inputPaths) {
    digests[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  const report = { entry, sha, inputTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    workflow: process.env.GITHUB_WORKFLOW_REF ?? 'local', workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? sha,
    runId: process.env.GITHUB_RUN_ID ?? 'local', attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    job: process.env.GITHUB_JOB ?? entry, arm: process.env.BENCHMARK_ARM ?? 'production',
    platform: process.platform, runnerOS: process.env.RUNNER_OS ?? process.platform,
    node: process.version, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    runnerImage: { os: process.env.ImageOS ?? 'unobserved', version: process.env.ImageVersion ?? 'unobserved',
      arch: process.env.RUNNER_ARCH ?? process.arch },
    toolchain: observedToolchain(entry),
    cachePolicy: 'no Actions dependency or build cache', digests, inventory: commandInventory(scripts, entry),
    phases: [] as Awaited<ReturnType<typeof runPhase>>[] };
  await mkdir(output, { recursive: true });
  const save = () => writeFile(join(output, `${entry.replaceAll(':', '-')}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await save();
  for (const script of phases(scripts, entry)) {
    const phase = await runPhase(script, scripts);
    report.phases.push(phase);
    await save();
    if (phase.code !== 0 || phase.signal !== null) { return phase.code || 1; }
    if (phase.cms) {
      assertCmsComposite(phase.cms, await cmsBinding(), phase.tests, JSON.parse(await readFile(cmsContract, 'utf8')));
    }
    assertPhaseTestExecution(phase);
  }
  return 0;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2]);
  // The helper records only selected identity fields and TAP identities/statuses,
  // never environment dumps, raw logs, auth roots or failure diagnostic payloads.
  process.exitCode = await measure(process.argv[2], process.env.CI_EVIDENCE_DIR ?? 'tmp/root-export-evidence/phases');
}
