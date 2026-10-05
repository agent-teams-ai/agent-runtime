import assert from 'node:assert/strict';
import { join, relative, resolve } from 'node:path';
import type { ExpectedEvidence, PackageId } from './product-fanout-contract.ts';

// Private independent aggregate oracle for the fixed Linux v2 Node streams.
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected observation object');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => { assert.ok(Array.isArray(value)); return value; };
const normalizedSummary = (record: Record<string, unknown>) => Object.fromEntries(['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'success'].map(key => [key, record[key]]));
function parseStream(stdout: string, stderr: string, context: { embedded: boolean; pid: unknown }) {
  const { embedded, pid } = context;
  const observedNodes: Record<string, unknown>[] = [], observedEvents: Record<string, unknown>[] = [];
  const observedSummaries: Record<string, unknown>[] = [], observedFiles: string[] = [];
  let begin = 0, end = 0;
  for (const line of [...stdout.split('\n'), ...stderr.split('\n')]) {
    if (line.startsWith('PACKAGE_NODE_PROCESS ')) {
      assert.ok(!embedded, 'ER reporter injection');
      const value = object(JSON.parse(line.slice(21)));
      observedNodes.push({ ...value, summary: normalizedSummary(object(value.summary)) });
    } else if (line.startsWith('PACKAGE_EVENT ')) { observedEvents.push(object(JSON.parse(line.slice(14)))); }
    else if (line.startsWith('PACKAGE_SUMMARY ')) { observedSummaries.push(normalizedSummary(object(JSON.parse(line.slice(16))))); }
    else if (line.startsWith('PACKAGE_FILE ')) {
      const value = object(JSON.parse(line.slice(13))); assert.equal(value.success, true); assert.equal(typeof value.file, 'string'); observedFiles.push(String(value.file));
    } else if (embedded && line.startsWith('{')) {
      const value = object(JSON.parse(line));
      if (value.kind === 'begin') { begin++; } else if (value.kind === 'end') { end++; }
      else if (value.kind === 'test') { observedEvents.push({ ...value, observerPid: pid }); }
      else if (value.kind === 'summary') { observedSummaries.push(normalizedSummary({ ...object(value.counts), success: value.success })); }
      else if (value.kind === 'file') { assert.equal(value.success, true); assert.equal(typeof value.suite, 'string'); observedFiles.push(String(value.suite)); }
      else { assert.ok(value.kind === 'output', 'failed/unknown ER record'); }
    }
  }
  return {observedNodes, observedEvents, observedSummaries, observedFiles, begin, end};
}
function assertCaptureIdentity(stream: Record<string, unknown>, node: Record<string, unknown>, index: number, commandPid: unknown): Record<string, unknown> {
      const rawIdentity = object(JSON.parse(String(stream.identity)));
      assert.equal(rawIdentity.index, index); assert.equal(rawIdentity.summary, undefined);
      assert.equal(rawIdentity.commandPid, commandPid, 'ER OS ancestry must bind the actual runner command');
      const originalCapture = object(stream.original);
      assert.equal(rawIdentity.mechanism, 'spawnSync-return-v1');
      assert.equal(rawIdentity.runnerPid, originalCapture.runnerPid);
      assert.equal(rawIdentity.pid, originalCapture.actualPid);
      assert.equal(rawIdentity.executable, originalCapture.actualExecutable);
      assert.equal(rawIdentity.cwd, originalCapture.actualCwd);
      assert.ok(Number.isSafeInteger(rawIdentity.runnerPid) && Number(rawIdentity.runnerPid) > 0);
      assert.notEqual(rawIdentity.runnerPid, node.pid);
      assert.equal(typeof rawIdentity.osObserved, 'boolean');
      if (!rawIdentity.osObserved) { assert.equal(rawIdentity.ancestors, null); }
      else {
      assert.ok(Number.isSafeInteger(rawIdentity.commandPid) && Number(rawIdentity.commandPid) > 0);
      assert.ok(Array.isArray(rawIdentity.ancestors) && rawIdentity.ancestors.length > 0 && rawIdentity.ancestors.length <= 16);
      assert.ok(rawIdentity.ancestors.every(pid => Number.isSafeInteger(pid) && pid > 0), 'invalid ER ancestor PID');
      assert.equal(new Set(rawIdentity.ancestors).size, rawIdentity.ancestors.length, 'cyclic ER ancestry');
      assert.ok(!rawIdentity.ancestors.includes(node.pid), 'ER process cannot be its own ancestor');
      assert.equal(rawIdentity.ancestors.at(-1), commandPid);
      assert.ok(rawIdentity.ancestors.includes(rawIdentity.runnerPid));
      }
      assert.ok(Number.isSafeInteger(rawIdentity.commandPid) && Number(rawIdentity.commandPid) > 0);
      const { index: _index, commandPid: _commandPid, ancestors: _ancestors, runnerPid: _runnerPid, mechanism: _mechanism, osObserved: _osObserved, ...osIdentity } = rawIdentity; return osIdentity;
}
interface StreamContext { id: PackageId; index: number; selected: string[]; root: string; packageRoot: string }
export function assertObservedStreams(expected: ExpectedEvidence, proof: Record<string, unknown>, context: StreamContext): void {
  const {id, index, selected, root, packageRoot} = context;
  const observation = object(proof.observation), streams = array(observation.streams).map(object);
  const plans = index < 3 ? [{ argv: ['--test', '--test-concurrency=1', `--test-reporter=${join(root, 'scripts/ci/package-execution.ts')}`, ...selected], files: selected }]
    : expected.packageStreams[id];
  assert.equal(streams.length, plans.length, 'all distinct original streams required');
  const pids = new Set<unknown>(), events: Record<string, unknown>[] = [], summaries: Record<string, unknown>[] = [], completed: string[] = [];
  for (const [streamIndex, stream] of streams.entries()) {
    const plan = plans[streamIndex]!;
    assert.equal(stream.index, streamIndex, 'duplicate/reordered stream index');
    const node = object(stream.node), embedded = id === 'embedded-runtime';
    assert.ok(Number.isSafeInteger(node.pid) && Number(node.pid) > 0, 'actual Node PID required');
    assert.ok(!pids.has(node.pid), 'duplicate process envelope'); pids.add(node.pid);
    assert.equal(node.executable, expected.nodeExecutable); assert.equal(node.cwd, join(root, packageRoot));
    assert.deepEqual(node.argv, plan.argv, 'source-expanded original process argv drift');
    if (index < 3) { assert.equal(node.pid, proof.pid, 'direct AE process PID drift'); }
    assert.equal(typeof stream.stdout, 'string'); assert.equal(typeof stream.stderr, 'string');
    const {observedNodes, observedEvents, observedSummaries, observedFiles, begin, end} = parseStream(String(stream.stdout), String(stream.stderr), { embedded, pid: node.pid });
    if (embedded) {
      assert.equal(typeof stream.identity, 'string', 'actual ER OS process sidecar required');
      observedNodes.push(assertCaptureIdentity(stream, node, streamIndex, proof.pid));
    } else { assert.equal(stream.identity, null); }
    const { summary: _summary, ...processIdentity } = node;
    assert.deepEqual(observedNodes, [embedded ? processIdentity : node], 'raw actual process envelope binding');
    assert.deepEqual(observedSummaries, [node.summary], 'summary must belong to its actual stream');
    if (embedded) {
      assert.equal(begin, 1); assert.equal(end, 1);
      const original = object(stream.original);
      assert.equal(original.index, streamIndex); assert.equal(original.cwd, packageRoot); assert.equal(original.executable, 'node');
      assert.deepEqual(original.argv, plan.argv, 'original ER captured argv drift');
      assert.equal(original.stdout, `process-${streamIndex}.stdout`); assert.equal(original.stderr, `process-${streamIndex}.stderr`);
      assert.equal(original.exitCode, 0); assert.equal(original.signal, null);
      const start = Date.parse(String(original.start)), endTime = Date.parse(String(original.end));
      assert.ok(Number.isFinite(start) && endTime >= start && start >= Date.parse(String(proof.start)) && endTime <= Date.parse(String(proof.end)), 'ER process time envelope drift');
    } else { assert.equal(stream.original, null); }
    const absolute = (file: unknown) => embedded ? resolve(root, String(file)) : resolve(String(node.cwd), String(file));
    const files = plan.files.map(file => join(root, packageRoot, file)).toSorted();
    assert.deepEqual(observedFiles.map(absolute).toSorted(), files, 'whole-package source-specific file universe drift');
    assert.equal(new Set(observedFiles).size, observedFiles.length, 'duplicate file stream');
    const identities = new Set<string>(), occurrences = new Map<string, number[]>();
    for (const event of observedEvents) {
      assert.equal(event.observerPid, node.pid, 'event belongs to another process');
      assert.ok(files.includes(absolute(event.suite)), 'foreign suite in stream');
      const file = relative(root, absolute(event.file)); assert.ok(expected.inputs[file], 'registration outside source custody');
      assert.ok(Number.isSafeInteger(event.line) && Number(event.line) > 0 && Number.isSafeInteger(event.column) && Number(event.column) > 0, 'registration location missing');
      assert.ok(Array.isArray(event.ancestry)); assert.ok(Number.isSafeInteger(event.ordinal) && Number(event.ordinal) > 0, 'registration occurrence missing');
      const site = JSON.stringify([event.suite, event.file, event.line, event.column, event.name ?? event.title, event.ancestry, event.type ?? event.kind]);
      const identity = JSON.stringify([site, event.ordinal]);
      assert.ok(!identities.has(identity), 'duplicate registration identity'); identities.add(identity);
      const ordinals = occurrences.get(site) ?? []; ordinals.push(Number(event.ordinal)); occurrences.set(site, ordinals);
    }
    for (const ordinals of occurrences.values()) { assert.deepEqual(ordinals.toSorted((a, b) => a - b), ordinals.map((_, i) => i + 1), 'missing/replaced occurrence'); }
    const counts = object(node.summary), tests = observedEvents.filter(event => (event.type ?? event.kind) === 'test');
    assert.equal(tests.length, counts.tests); assert.equal(tests.filter(event => event.status === 'passed').length, counts.passed);
    assert.equal(tests.filter(event => event.status === 'skipped').length, counts.skipped);
    events.push(...observedEvents); summaries.push(...observedSummaries); completed.push(...observedFiles);
  }
  assert.deepEqual(observation.events, events, 'raw registration observation binding drift');
  assert.deepEqual(observation.summaries, summaries, 'raw summary observation binding drift');
  assert.deepEqual(observation.completedFiles, completed, 'raw completed-file observation binding drift');
}
