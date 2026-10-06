import assert from 'node:assert/strict';
import { readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CapturedStream, Observation, Summary, NodeProcessObservation } from './package-execution.ts';
const json = (bytes: string): unknown => JSON.parse(bytes);
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

interface Plan { executable: string; argv: string[]; cwd: string }
// Fixed two-stream CI capture. Linux procfs corroborates live children when
// observed; spawnSync return metadata retains short children on either platform.
// Capture identity is not OS executable attestation or artifact authentication.
export function observeEmbeddedProcesses(plans: readonly Plan[], capture: string, commandPid: number): () => Promise<void> {
  assert.equal(plans.length, 2);
  assert.ok(Number.isSafeInteger(commandPid) && commandPid > 0);
  const identities = new Map<number, string>();
  const state: { stopped: boolean; failure: unknown } = { stopped: false, failure: null };
  const running = (async () => {
    while (process.platform === 'linux' && !state.stopped) {
      for (const pid of (await readdir('/proc')).filter(name => /^\d+$/u.test(name))) {
        try {
          const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          const index = plans.findIndex(plan => JSON.stringify(argv.slice(1)) === JSON.stringify(plan.argv));
          if (index < 0) { continue; }
          const plan = plans[index]!;
          const executable = await readlink(`/proc/${pid}/exe`), cwd = await readlink(`/proc/${pid}/cwd`);
          if (executable !== plan.executable || cwd !== plan.cwd) { continue; }
          const ancestors: number[] = [];
          let parent = Number(pid);
          while (parent !== commandPid && parent > 1 && ancestors.length < 16) {
            const status = await readFile(`/proc/${parent}/status`, 'utf8');
            parent = Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1]); ancestors.push(parent);
          }
          if (parent !== commandPid) { continue; }
          const identity = JSON.stringify({ index, pid: Number(pid), executable, argv: argv.slice(1), cwd, commandPid, ancestors });
          assert.ok(!identities.has(index) || identities.get(index) === identity, 'duplicate original ER process');
          identities.set(index, identity);
        } catch (error) {
          if (!['ENOENT', 'ESRCH', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) { throw error; }
        }
      }
      await new Promise<void>(resolve => { setTimeout(resolve, 2); });
    }
  })().catch(failure => { state.failure = failure; state.stopped = true; });
  return async () => {
    state.stopped = true; await running;
    if (state.failure !== null) { throw state.failure; }
    const records: unknown = JSON.parse(await readFile(join(capture, 'processes.json'), 'utf8'));
    assert.ok(Array.isArray(records) && records.length === 2, 'two original spawn returns required');
    const pids = new Set<number>();
    for (const [index, original] of records.entries()) {
      const record = original as Record<string, unknown>, plan = plans[index]!;
      assert.equal(record.index, index);
      assert.ok(Number.isSafeInteger(record.actualPid) && Number(record.actualPid) > 0);
      assert.ok(Number.isSafeInteger(record.runnerPid) && Number(record.runnerPid) > 0);
      assert.notEqual(record.actualPid, record.runnerPid);
      assert.notEqual(record.actualPid, commandPid, 'original child cannot be its command process');
      assert.equal(record.runnerPid, (records[0] as Record<string, unknown>).runnerPid, 'both original streams require one actual runner');
      assert.ok(!pids.has(Number(record.actualPid)), 'duplicate spawn PID'); pids.add(Number(record.actualPid));
      assert.equal(record.actualExecutable, plan.executable); assert.equal(record.actualCwd, plan.cwd);
      assert.deepEqual(record.argv, plan.argv);
      const observed = identities.has(index) ? JSON.parse(identities.get(index)!) as Record<string, unknown> : null;
      const identity = {index, pid: record.actualPid, executable: record.actualExecutable, argv: record.argv,
        cwd: record.actualCwd, commandPid, runnerPid: record.runnerPid, mechanism: 'spawnSync-return-v1',
        osObserved: observed !== null, ancestors: observed?.ancestors ?? null};
      if (observed) {
        const {runnerPid: _runner, mechanism: _mechanism, osObserved: _os, ...comparable} = identity;
        assert.deepEqual(comparable, observed, 'OS observation and original spawn return disagree');
        assert.ok(Array.isArray(identity.ancestors) && identity.ancestors.includes(record.runnerPid));
      }
      await writeFile(join(capture, `process-${index}.identity.json`), JSON.stringify(identity) + '\n', { flag: 'wx' });
    }
  };
}

export function captureStream(stdout: string, stderr: string, index: number, original: Record<string, unknown> | null, context: {rawIdentity: string | null; observeLine: (line: string, observation: Observation) => void; summary: (record: Record<string, unknown>) => Summary}): Observation {
  const {rawIdentity, observeLine, summary} = context;
  const observation = ({ summaries: [], events: [], completedFiles: [], streams: [] } as Observation), identities: Record<string, unknown>[] = [];
  if (original) {
    assert.ok(rawIdentity, 'actual ER process sidecar required');
    const record = object(json(rawIdentity)); assert.equal(record.index, index); assert.equal(record.summary, undefined);
    identities.push(record);
  } else { assert.equal(rawIdentity, null); }
  let begin = 0, end = 0;
  for (const line of [...stdout.split('\n'), ...stderr.split('\n')]) {
    if (line.startsWith('PACKAGE_NODE_PROCESS ')) {
      assert.equal(original, null, 'ER reporter injection');
      const record = object(json(line.slice(21)));
      assert.ok(Number.isSafeInteger(record.pid) && Number(record.pid) > 0);
      assert.equal(typeof record.executable, 'string'); assert.equal(typeof record.cwd, 'string');
      assert.ok(Array.isArray(record.argv) && record.argv.every(v => typeof v === 'string'));
      identities.push(record);
    } else { observeLine(line, observation); }
    if (line.startsWith('{')) {
      let record: Record<string, unknown>; try { record = object(json(line)); } catch { continue; }
      if (record.kind === 'begin') { begin++; } if (record.kind === 'end') { end++; }
    }
  }
  assert.equal(identities.length, 1, 'one actual Node process envelope per stream');
  const identity = identities[0]!;
  assert.ok(Number.isSafeInteger(identity.pid) && Number(identity.pid) > 0);
  assert.equal(typeof identity.executable, 'string'); assert.equal(typeof identity.cwd, 'string');
  assert.ok(Array.isArray(identity.argv) && identity.argv.every(v => typeof v === 'string'));
  if (original) { assert.equal(observation.summaries.length, 1, 'one original ER summary per stream'); }
  const node: NodeProcessObservation = { pid: Number(identity.pid), executable: String(identity.executable),
    cwd: String(identity.cwd), argv: identity.argv as string[],
    summary: original ? observation.summaries[0]! : summary(object(identity.summary)) };
  if (original) {
    assert.equal(begin, 1, 'missing/duplicate ER begin'); assert.equal(end, 1, 'missing/duplicate ER end');
    for (const event of observation.events) { event.observerPid = node.pid; }
  }
  observation.streams.push({ index, node, stdout, stderr, original, identity: rawIdentity });
  return observation;
}

export function assertCapturedIdentity(stream: CapturedStream, commandPid: number | null | undefined, runnerPid: unknown): void {
  assert.ok(stream.original);
        const identity = object(JSON.parse(stream.identity!));
        assert.equal(identity.mechanism, 'spawnSync-return-v1');
        assert.equal(identity.runnerPid, stream.original.runnerPid);
        assert.equal(identity.runnerPid, runnerPid, 'both original streams require one actual runner');
        assert.equal(identity.pid, stream.original.actualPid);
        assert.equal(identity.executable, stream.original.actualExecutable);
        assert.equal(identity.cwd, stream.original.actualCwd);
        assert.ok(Number.isSafeInteger(identity.runnerPid) && Number(identity.runnerPid) > 0);
        assert.notEqual(identity.runnerPid, stream.node.pid);
        assert.equal(typeof identity.osObserved, 'boolean');
        if (!identity.osObserved) { assert.equal(identity.ancestors, null); }
        else {
        assert.ok(Number.isSafeInteger(identity.commandPid) && Number(identity.commandPid) > 0);
        assert.ok(Array.isArray(identity.ancestors) && identity.ancestors.length > 0 && identity.ancestors.length <= 16);
        assert.ok(identity.ancestors.every(pid => Number.isSafeInteger(pid) && pid > 0), 'invalid ER ancestor PID');
        assert.equal(new Set(identity.ancestors).size, identity.ancestors.length, 'cyclic ER ancestry');
        assert.ok(!identity.ancestors.includes(stream.node.pid), 'ER process cannot be its own ancestor');
        assert.equal(identity.ancestors.at(-1), identity.commandPid);
        assert.ok(identity.ancestors.includes(identity.runnerPid));
        }
        assert.ok(Number.isSafeInteger(identity.commandPid) && Number(identity.commandPid) > 0);
        assert.notEqual(identity.commandPid, stream.node.pid, 'original child cannot be its command process');
        if (commandPid !== undefined) { assert.equal(identity.commandPid, commandPid); }
}
