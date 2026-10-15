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

export interface TestResult { suite: string; name: string; ancestry: string[]; depth: number; status: string; kind?: 'suite' | 'test';
  bodyless?: boolean }
export const cmsFile = 'scripts/architecture/check-cms-pin.test.mjs';
export const cmsContract = 'architecture/foundation/mandatory-node-tests.json';
export const cmsDirectCommand = `node --test ${cmsFile}`;
export const cmsMandatoryCommand = `agent-teams-node-test --contract ${cmsContract} -- ${cmsFile}`;
export type NodeSummary = Pick<Extract<TestEvent, { type: 'test:summary' }>['data'], 'counts' | 'success'>;
export type InputAdmission = { path: string; status: 'available'; digest: string }
  | { path: string; status: 'unavailable'; reason: 'missing' | 'unreadable' };

const trustedNodeReporterOptions = 'CI_TRUSTED_NODE_REPORTER_OPTIONS';
const reporterPath = fileURLToPath(import.meta.url);
const reporterOption = `--test-reporter=${reporterPath}`;

function clearTrustedNodeReporterOptions(environment: NodeJS.ProcessEnv): void {
  const configured = environment[trustedNodeReporterOptions]?.trim();
  delete environment[trustedNodeReporterOptions];
  if (!configured || !environment.NODE_OPTIONS) { return; }
  const configuredWords = configured.split(/\s+/u).filter(Boolean);
  const trustedConfiguration = configuredWords[0] === reporterOption
    && configuredWords.length >= 2
    && configuredWords.slice(1).every(word => word === '--test-reporter-destination=stdout');
  if (!trustedConfiguration) { return; }
  const words = environment.NODE_OPTIONS.split(/\s+/u).filter(Boolean);
  const cleaned: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const startsTrusted = word === configuredWords[0]
      && configuredWords.every((part, offset) => words[index + offset] === part);
    if (startsTrusted) {
      index += configuredWords.length - 1;
      continue;
    }
    cleaned.push(word);
  }
  if (cleaned.length > 0) { environment.NODE_OPTIONS = cleaned.join(' '); } else { delete environment.NODE_OPTIONS; }
}

clearTrustedNodeReporterOptions(process.env);

export function isExecutedTestLeaf(result: TestResult): boolean {
  return result.kind === 'test' && result.status === 'passed' && result.bodyless === false;
}

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
      status: event.data.skip ? 'skip' : event.data.todo ? 'todo' : event.type === 'test:pass' ? 'passed' : 'failed',
      bodyless: !('entryFile' in data) };
  };
}

// The exact direct leaf selects this reporter via NODE_OPTIONS, never a private runner import.
export default async function* nodeEventReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const observe = createNodeEventCollector();
  for await (const event of source) {
    if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      process.stderr.write(event.data.message);
      continue;
    }
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
export async function admissionInputs(root = process.cwd()): Promise<InputAdmission[]> {
  const inputs: InputAdmission[] = [];
  for (const path of inputPaths) {
    try {
      inputs.push({ path, status: 'available', digest: hash(await readFile(resolvePath(root, path))) });
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
      inputs.push({ path, status: 'unavailable', reason });
    }
  }
  return inputs;
}
export async function cmsBinding(root = process.cwd()): Promise<Record<string, string>> {
  const binding: Record<string, string> = {};
  for (const input of await admissionInputs(root)) {
    if (input.status === 'available') { binding[input.path] = input.digest; }
  }
  for (const path of cmsInputPaths) { binding[path] = hash(await readFile(resolvePath(root, path))); }
  const installed = 'node_modules/@agent-teams/engineering-foundation';
  const installedRoot = resolvePath(root, installed);
  const files = (await readdir(installedRoot, { recursive: true, withFileTypes: true })).filter(file => file.isFile());
  const fingerprints = await Promise.all(files.map(async file => {
    const path = join(file.parentPath, file.name);
    return [relative(installedRoot, path), hash(await readFile(path))];
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

async function cmsProcess(command: string) {
  const before = await cmsBinding();
  const tests: TestResult[] = [], summaries: string[] = [], nodeSummaries: NodeSummary[] = [];
  const observe = createTestResultCollector();
  const env = authoritativeNodeEventEnvironment([{ script: command, command }]);
  delete env.NODE_TEST_CONTEXT;
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
  const direct = await cmsProcess(cmsDirectCommand);
  const mandatory = direct.code === 0 && direct.signal === null ? await cmsProcess(cmsMandatoryCommand) : null;
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

function assignPendingType(pendingResults: Map<string, TestResult>, suite: string, type: 'suite' | 'test'): void {
  const pending = pendingResults.get(suite);
  if (!pending) { return; }
  pending.kind = type;
  pendingResults.delete(suite);
}

function observedKind(result: TestResult, possibleSuites: Map<string, string>, suite: string, depth: number): 'suite' | 'test' {
  return result.kind ?? (possibleSuites.has(JSON.stringify([suite, depth, result.name])) ? 'suite' : 'test');
}

// One collector per process; pnpm's package prefixes isolate multiplexed suites.
// TAP emits parent headings before children and parent results after children.
export function createTestResultCollector(): (line: string) => TestResult | undefined {
  const stacks = new Map<string, Array<{ depth: number; name: string }>>();
  const possibleSuites = new Map<string, string>();
  const pendingResults = new Map<string, TestResult>();
  const observedResults = new Map<string, TestResult[]>();
  const summaryCounts = new Map<string, { tests?: number; suites?: number }>();
  const applySummary = (suite: string, key: 'tests' | 'suites', value: number): void => {
    const counts = summaryCounts.get(suite) ?? {};
    counts[key] = value;
    summaryCounts.set(suite, counts);
    if (counts.tests === 0 && counts.suites !== undefined && counts.suites > 0) {
      for (const result of observedResults.get(suite) ?? []) { result.kind = 'suite'; }
    }
  };
  return line => {
    const prefix = /^(.*?) (?:test|check): (.*)$/u.exec(line);
    const suite = prefix?.[1] ?? 'root';
    const body = prefix?.[2] ?? line;
    const summary = /^\s*ℹ (tests|suites) (\d+)$/u.exec(body);
    if (summary) {
      applySummary(suite, summary[1] as 'tests' | 'suites', Number(summary[2]));
      return;
    }
    const heading = /^(\s*)(?:# Subtest: |▶ )(.*)$/u.exec(body);
    const type = /^\s*type: '(suite|test)'$/u.exec(body);
    if (type) {
      assignPendingType(pendingResults, suite, type[1] as 'suite' | 'test');
      return;
    }
    const result = tapResult(line);
    if (!heading && !result) { return; }
    const depth = heading ? (heading[1] ?? '').length : result?.depth ?? 0;
    const parents = (stacks.get(suite) ?? []).filter(frame => frame.depth < depth);
    if (heading) {
      stacks.set(suite, [...parents, { depth, name: heading[2] ?? '' }]);
      possibleSuites.set(JSON.stringify([suite, depth, heading[2] ?? '']), heading[2] ?? '');
      return;
    }
    assert.ok(result);
    stacks.set(suite, parents);
    const observed: TestResult = {
      ...result,
      ancestry: parents.map(frame => frame.name),
      kind: observedKind(result, possibleSuites, suite, depth),
    };
    const observedForSuite = observedResults.get(suite) ?? [];
    observedForSuite.push(observed);
    observedResults.set(suite, observedForSuite);
    pendingResults.set(suite, observed);
    return observed;
  };
}


export const inputPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version',
  'scripts/ci/full-contract.json', 'experiments/rust-system-boundaries/rust-toolchain.toml',
  'experiments/rust-system-boundaries/Cargo.lock', 'scripts/ci/measure.ts', 'scripts/ci/compare.ts',
  'scripts/ci/policy.ts', 'scripts/ci/script-routing.ts', 'scripts/ci/conformance.ts', 'scripts/ci/gate.ts',
  'scripts/ci/inventory.ts', 'scripts/ci/contracts.test.ts', 'scripts/ci/tsconfig.json',
  'scripts/ci/cms-pin-review.ts', 'scripts/ci/cms-pin-review.test.ts',
  'scripts/ci/nightly-contract.ts', 'scripts/ci/nightly-contract.test.ts',
  'scripts/ci/foundation-fixture-sharding.ts', 'scripts/ci/foundation-fixture-sharding.test.ts',
  'scripts/ci/foundation-fanout-contract.ts',
  'scripts/ci/pr-regression-bootstrap.ts', 'scripts/ci/pr-regression-bootstrap.test.ts',
  'scripts/ci/pr-regression-bootstrap-fixtures.ts',
  'scripts/ci/pr-regression-inputs.ts', 'scripts/ci/pr-regression-inputs.test.ts',
  'scripts/ci/pr-regression-command.ts', 'architecture/foundation/ci-pr-regressions.json',
  '.github/workflows/ci-foundation-route.yml', '.github/workflows/ci-pr-regressions.yml',
  '.github/workflows/ci-foundation.yml', '.github/workflows/ci-foundation-shard.yml',
  'scripts/ci/package-execution.ts', 'scripts/ci/package-execution.test.ts',
  'scripts/ci/product-workflow-contract.ts', 'scripts/ci/package-native-observation.ts',
  'scripts/ci/product-test-observation.ts', 'scripts/ci/er-process-observer.ts',
  'scripts/ci/product-fanout-contract.ts', 'scripts/ci/product-fanout-contract.test.ts',
  '.github/workflows/ci-darwin-packages.yml', '.github/workflows/ci-darwin-reference.yml', 'scripts/ci/platform-contract.predecessor.json',
  '.github/workflows/ci-product.yml', '.github/workflows/ci-product-shard.yml',
  '.github/workflows/ci.yml', '.github/workflows/ci-nightly.yml'] as const;

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

interface NodeTestReporterRoute { reporters: number; destinations: number }

function nodeTestReporterRoute(command: string): NodeTestReporterRoute | undefined {
  const words = command.split(/\s+/u);
  if (words[0] !== 'node' || !words.includes('--test')) { return undefined; }
  let reporters = 0, destinations = 0;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--test-reporter' || word.startsWith('--test-reporter=')) {
      reporters += 1;
      if (word === '--test-reporter') { index += 1; }
    } else if (word === '--test-reporter-destination' || word.startsWith('--test-reporter-destination=')) {
      destinations += 1;
      if (word === '--test-reporter-destination') { index += 1; }
    }
  }
  assert.ok(reporters === destinations || destinations === 0, `unsupported Node reporter graph: ${command}`);
  return { reporters, destinations };
}

export function authoritativeNodeEventEnvironment(commands: readonly Command[],
  environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  clearTrustedNodeReporterOptions(isolated);
  const routes = commands.map(command => nodeTestReporterRoute(command.command)).filter(route => route !== undefined);
  if (routes.length === 0) { return isolated; }
  assert.ok(!/(?:^|\s)--test-reporter(?:=|\s)/u.test(isolated.NODE_OPTIONS ?? ''),
    'inherited Node reporter options are unsupported');
  const unpaired = routes.filter(route => route.destinations === 0 && route.reporters > 0);
  if (unpaired.length > 0) {
    assert.ok(routes.every(route => route.reporters === unpaired[0]!.reporters && route.destinations === 0),
      'mixed explicit Node reporter graphs are unsupported');
  }
  const destinations = unpaired.length > 0 ? unpaired[0]!.reporters + 1 : 1;
  const options = [reporterOption,
    ...Array.from({ length: destinations }, () => '--test-reporter-destination=stdout')].join(' ');
  return { ...isolated, NODE_OPTIONS: `${isolated.NODE_OPTIONS ?? ''} ${options}`.trim(),
    [trustedNodeReporterOptions]: options };
}

export function assertPhaseTestExecution(phase: { script: string; commands: readonly Command[];
  tests: readonly TestResult[]; unqualifiedRunners: readonly string[] }): void {
  // Empty command inventories are opaque diagnostic controls, not reusable
  // production execution receipts; their ordinary text stays bodyless-unknown.
  if (phase.commands.length === 0) {
    assert.ok(phase.tests.length > 0, `${phase.script} emitted empty opaque diagnostic control`);
    assert.ok(phase.tests.every(result => result.status !== 'failed' && result.status !== 'cancelled'
      && result.bodyless !== true), `${phase.script} emitted invalid opaque diagnostic control`);
    const identities = phase.tests.map(result => JSON.stringify([result.suite, result.ancestry, result.name, result.kind]));
    assert.equal(new Set(identities).size, identities.length, `${phase.script} emitted duplicate opaque diagnostic identity`);
    assert.ok(phase.tests.some(result => result.status === 'passed'),
      `${phase.script} emitted no passed opaque diagnostic control`);
    return;
  }
  const nodeTests = phase.commands.filter(command => nodeTestReporterRoute(command.command) !== undefined);
  const authoritative = nodeTests.length > 0 || phase.script === 'quality:native';
  if (nodeTests.length > 0 || phase.commands.some(command => /(?:agent-teams-node-test|\brun test\b)/u.test(command.command))
    || /^(?:test(?::|$)|quality:native$)/u.test(phase.script)) {
    assert.ok(phase.tests.every(result => result.status !== 'failed'
      && result.status !== 'cancelled' && result.bodyless !== true),
      `${phase.script} emitted file-only test evidence`);
    if (authoritative) {
      assert.ok(phase.tests.every(result => result.bodyless === false), `${phase.script} emitted text-only test evidence`);
    }
    const identities = phase.tests.map(result => JSON.stringify([result.suite, result.ancestry, result.name, result.kind]));
    assert.equal(new Set(identities).size, identities.length, `${phase.script} emitted duplicate test identity`);
    assert.ok(phase.tests.some(isExecutedTestLeaf)
      || (phase.tests.length === 0 && phase.unqualifiedRunners.some(summary => mandatoryRunnerSummary(summary))),
      `${phase.script} emitted no test execution`);
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
    const fixtures = await cmsProcess('node --test scripts/architecture/check-consumer-module-standard.test.mjs');
    const cms = fixtures.code === 0 && fixtures.signal === null ? await captureCmsComposite() : undefined;
    const outcome = cms?.mandatory ?? cms?.direct ?? fixtures;
    return { script, commands: commandInventory(scripts, script), started, ended: new Date().toISOString(),
      wallMs: performance.now() - start, code: outcome.code, signal: outcome.signal,
      tests: [...fixtures.tests, ...(cms?.direct.tests ?? [])], unqualifiedRunners: [] as string[], cms };
  }
  const started = new Date().toISOString();
  const start = performance.now();
  const tests: TestResult[] = [];
  const eventTests: TestResult[] = [], textTests: TestResult[] = [];
  const observe = createTestResultCollector();
  const unqualifiedRunners: string[] = [];
  console.log(`::group::pnpm ${script}`);
  const commands = commandInventory(scripts, script);
  const childEnv = authoritativeNodeEventEnvironment(commands);
  const child = spawn('pnpm', ['run', script], { stdio: ['ignore', 'pipe', 'inherit'], env: childEnv });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    console.log(line);
    if (line.startsWith('CI_NODE_EVENT ')) {
      eventTests.push(JSON.parse(line.slice(14)) as TestResult);
    } else {
      const result = observe(line);
      if (result) { textTests.push(result); }
    }
    const summary = mandatoryRunnerSummary(line);
    if (summary) { unqualifiedRunners.push(summary); }
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  tests.push(...(eventTests.length > 0 ? eventTests : textTests));
  console.log('::endgroup::');
  return { script, commands: commandInventory(scripts, script), started, ended: new Date().toISOString(),
    wallMs: performance.now() - start, ...outcome, tests, unqualifiedRunners };
}

interface ProcessOutcome { code: number | null; signal: NodeJS.Signals | null }

async function executePhases(scripts: Scripts, entry: string, sourceComplete: boolean,
  record: (phase: Awaited<ReturnType<typeof runPhase>>) => Promise<void>): Promise<ProcessOutcome | undefined> {
  let observedFailure: ProcessOutcome | undefined;
  for (const script of phases(scripts, entry)) {
    const phase = await runPhase(script, scripts);
    await record(phase);
    const failed = phase.code !== 0 || phase.signal !== null;
    if (failed && observedFailure === undefined) {
      observedFailure = { code: phase.code, signal: phase.signal as NodeJS.Signals | null };
    }
    if (phase.cms && !failed) {
      assertCmsComposite(phase.cms, await cmsBinding(), phase.tests, JSON.parse(await readFile(cmsContract, 'utf8')));
    }
    if (!failed) { assertPhaseTestExecution(phase); }
    if (failed && sourceComplete) { return observedFailure; }
  }
  return observedFailure;
}

export async function measure(entry: string, output: string): Promise<ProcessOutcome> {
  const scripts = await readScripts('package.json');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assertRevision(sha, process.env.EXPECTED_REVISION ?? '');
  const inputAdmission = await admissionInputs();
  const digests = Object.fromEntries(inputAdmission.flatMap(input =>
    input.status === 'available' ? [[input.path, input.digest] as const] : []));
  const sourceComplete = inputAdmission.every(input => input.status === 'available');
  const report = { entry, sha, inputTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    workflow: process.env.GITHUB_WORKFLOW_REF ?? 'local', workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? sha,
    runId: process.env.GITHUB_RUN_ID ?? 'local', attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    job: process.env.GITHUB_JOB ?? entry, arm: process.env.BENCHMARK_ARM ?? 'production',
    platform: process.platform, runnerOS: process.env.RUNNER_OS ?? process.platform,
    node: process.version, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    runnerImage: { os: process.env.ImageOS ?? 'unobserved', version: process.env.ImageVersion ?? 'unobserved',
      arch: process.env.RUNNER_ARCH ?? process.arch },
    toolchain: observedToolchain(entry),
    cachePolicy: 'no Actions dependency or build cache', digests, inputAdmission,
    sourceComplete, sourceDisposition: sourceComplete ? 'source-complete' as const : 'blocking-source-incomplete' as const,
    receiptReuseAllowed: false, inventory: commandInventory(scripts, entry),
    phases: [] as Awaited<ReturnType<typeof runPhase>>[] };
  await mkdir(output, { recursive: true });
  const save = () => writeFile(join(output, `${entry.replaceAll(':', '-')}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await save();
  const observedFailure = await executePhases(scripts, entry, sourceComplete, async phase => {
    report.phases.push(phase);
    await save();
  });
  report.receiptReuseAllowed = sourceComplete && observedFailure === undefined
    && report.phases.some(phase => phase.tests.some(isExecutedTestLeaf));
  await save();
  return observedFailure ?? { code: sourceComplete ? 0 : 1, signal: null };
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2]);
  // The helper records only selected identity fields and TAP identities/statuses,
  // never environment dumps, raw logs, auth roots or failure diagnostic payloads.
  const outcome = await measure(process.argv[2], process.env.CI_EVIDENCE_DIR ?? 'tmp/root-export-evidence/phases');
  if (outcome.signal) { process.kill(process.pid, outcome.signal); }
  else { process.exitCode = outcome.code ?? 1; }
}
