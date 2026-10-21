/** Temporary manual diagnostic. Builtins only; no required-lane or qualification authority. */
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {access, readFile, readlink, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import type {Writable} from 'node:stream';

const execute = promisify(execFile);
const targetRevision = '8b1735d716491445d8d9b97efec4adb40557ea5b';
export interface Identity {
  readonly pid: number; readonly parentPid: number; readonly startTicks: string;
  readonly executable: string; readonly comm: string; readonly uid: number; readonly threadGroupPid: number;
}
type Emit = (kind: string, data?: Record<string, unknown>) => void;
type ReadIdentity = (pid: number) => Promise<Identity>;
const refusalPhases = {
  TARGET_UNSUPPORTED: 'target', TARGET_NOT_EXACT: 'target', NODE_VERSION_REFUSED: 'toolchain',
  WORKER_ANCESTOR_UNPROVED: 'ancestor', WORKER_CHANGED: 'attach', SUDO_REQUIRED: 'sudo',
  SUDO_OR_HELPER_REFUSED: 'sudo', STRACE_UNAVAILABLE: 'strace', PTRACE_REFUSED: 'attach',
  ATTACHMENT_UNPROVED: 'attach', TRACER_STREAM_CLOSED: 'observe', OBSERVER_CONTROL_CLOSED: 'observe',
  OBSERVER_CONTROL_INVALID: 'observe', OBSERVER_DEADLINE: 'observe', TRACER_DETACH_UNPROVED: 'cleanup',
  TRACER_TERMINATION_UNPROVED: 'cleanup', TRACER_BYTES_UNDRAINED: 'cleanup',
  OBSERVER_CLEANUP_UNPROVED: 'cleanup', RELAY_UNDRAINED: 'cleanup', INTERNAL_FAILURE: 'internal',
} as const;
class Refusal extends Error {
  readonly code: keyof typeof refusalPhases;
  constructor(code: keyof typeof refusalPhases) {super(code); this.code = code;}
}

const emit: Emit = (kind, data = {}) => {
  process.stdout.write('WORKER_SIGNAL_DIAGNOSTIC ' + JSON.stringify({kind, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...data}) + '\n');
};
function positivePid(value: string): number {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) {throw new Error('positive PID required');}
  return pid;
}
export async function identity(pid: number): Promise<Identity> {
  const root = `/proc/${pid}`;
  const [raw, status, executable, comm, metadata] = await Promise.all([
    readFile(root + '/stat', 'utf8'), readFile(root + '/status', 'utf8'), readlink(root + '/exe'), readFile(root + '/comm', 'utf8'), stat(root),
  ]);
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const group = /^Tgid:\s+(\d+)$/mu.exec(status)?.[1];
  if (!/^\d+$/u.test(fields[19] ?? '') || group === undefined) {throw new Error('process identity unavailable');}
  return {pid, parentPid: positivePid(fields[1]!), startTicks: fields[19]!, executable, comm: comm.trim(), uid: metadata.uid, threadGroupPid: positivePid(group)};
}
export async function workerAncestor(): Promise<Identity> {
  let pid = process.pid; const seen = new Set<number>(); const matches: Identity[] = [];
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid); const current = await identity(pid);
    if (basename(current.executable) === 'Runner.Worker') {matches.push(current);}
    pid = current.parentPid;
  }
  if (matches.length !== 1) {throw new Refusal('WORKER_ANCESTOR_UNPROVED');}
  return matches[0]!;
}
/** Drain every complete raw line per chunk; selectors/text prefetch cannot strand final signal metadata. */
export async function* lines(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    if (!Buffer.isBuffer(chunk)) {throw new Error('raw byte stream required');}
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 1024 * 1024) {throw new Error('diagnostic line bound exceeded');}
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      yield pending.subarray(0, end).toString('utf8'); pending = pending.subarray(end + 1);
    }
  }
  if (pending.length !== 0) {throw new Error('incomplete final diagnostic line');}
}
export async function inspectSignal(line: string, worker: Identity, read: ReadIdentity, report: Emit): Promise<void> {
  const delivered = /--- (SIGTERM|SIGINT|SIGHUP|SIGQUIT) \{([^}]*)\}/u.exec(line);
  if (!delivered) {return;}
  const traced = /^(?:\[pid\s+(\d+)\]|(\d+))\s+/u.exec(line);
  const threadPid = traced?.[1] ?? traced?.[2];
  let thread: Identity | undefined; let currentWorker: Identity | undefined;
  try {currentWorker = await read(worker.pid); if (threadPid !== undefined) {thread = await read(positivePid(threadPid));}} catch { /* Unknown target never gains attribution. */ }
  if (!currentWorker || currentWorker.startTicks !== worker.startTicks || currentWorker.executable !== worker.executable || !thread || thread.threadGroupPid !== worker.pid) {report('signal-target-unattributed', {signal: delivered[1], observedThreadPid: threadPid}); return;}
  const siginfo = Object.fromEntries([...delivered[2]!.matchAll(/(si_[a-z]+)=([A-Za-z0-9_-]+)/gu)].map(match => [match[1], match[2]]));
  let sender: Identity | undefined;
  try {if (siginfo.si_pid !== undefined) {sender = await read(positivePid(siginfo.si_pid));}} catch { /* Exited/reused/nonlocal sender remains unproved. */ }
  report('signal-delivery', {signal: delivered[1], siginfo, targetWorker: worker, targetThread: thread, senderPostDeliveryObservation: sender});
}
async function deadline<T>(work: Promise<T>, milliseconds: number, reason: Refusal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {return await Promise.race([work, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(reason), milliseconds);})]);}
  finally {if (timer) {clearTimeout(timer);}}
}
function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((accept, reject) => {child.once('error', reject); child.once('exit', accept);});
}
export function observerControl(stream: Writable | null): {stop(): void; refused(): boolean} {
  let refused = stream === null;
  // Install synchronously and retain through stream disposal: a raced helper exit may emit EPIPE after end().
  stream?.on('error', () => {refused = true;});
  return {
    stop() {try {stream?.end('stop\n');} catch {refused = true;}},
    refused: () => refused,
  };
}
async function traceWorker(pid: number, startTicks: string): Promise<void> {
  if (process.geteuid?.() !== 0) {throw new Refusal('SUDO_REQUIRED');}
  const worker = await identity(pid);
  if (worker.startTicks !== startTicks || basename(worker.executable) !== 'Runner.Worker') {throw new Refusal('WORKER_CHANGED');}
  const tracerPath = '/usr/bin/strace';
  try {await access(tracerPath, constants.X_OK);} catch {throw new Refusal('STRACE_UNAVAILABLE');}
  emit('worker-bound', {worker, tracerPath});
  const tracer = spawn(tracerPath, ['-f', '-ttt', '-e', 'trace=none', '-e', 'signal=SIGTERM,SIGINT,SIGHUP,SIGQUIT', '-p', String(pid)], {stdio: ['ignore', 'ignore', 'pipe']});
  const exit = exited(tracer); let finished = false; void exit.then(() => {finished = true;}, () => {finished = true;});
  const stderr = tracer.stderr; if (!stderr) {throw new Error('tracer byte stream unavailable');}
  let attached = false;
  const trace = (async () => {
    for await (const line of lines(stderr)) {
      if (line.includes('attached')) {
        if (!attached) {
          if (JSON.stringify(await identity(pid)) !== JSON.stringify(worker)) {throw new Refusal('WORKER_CHANGED');}
          attached = true; emit('attached', {worker, tracerPid: tracer.pid});
        }
      } else if (line.includes('Operation not permitted') || line.includes('Permission denied')) {throw new Refusal('PTRACE_REFUSED');}
      else {await inspectSignal(line, worker, identity, emit);}
    }
    throw new Refusal('TRACER_STREAM_CLOSED');
  })();
  void trace.catch(() => {});
  const control = (async () => {
    for await (const line of lines(process.stdin)) {
      if (line !== 'stop') {throw new Refusal('OBSERVER_CONTROL_INVALID');}
      emit('stop-requested', {attached}); return;
    }
    throw new Refusal('OBSERVER_CONTROL_CLOSED');
  })();
  void control.catch(() => {});
  try {await deadline(Promise.race([trace, control]), 900_000, new Refusal('OBSERVER_DEADLINE'));}
  finally {
    // Only the retained owned tracer handle receives cleanup signals. No kill-on-exit or injection options.
    if (!finished) {
      tracer.kill('SIGINT');
      try {await deadline(exit, 5_000, new Refusal('TRACER_DETACH_UNPROVED'));}
      catch {if (!finished) {tracer.kill('SIGKILL');} await deadline(exit, 5_000, new Refusal('TRACER_TERMINATION_UNPROVED'));}
    }
    await deadline(trace.catch(() => {}), 5_000, new Refusal('TRACER_BYTES_UNDRAINED'));
    emit('tracer-detached', {tracerPid: tracer.pid, exitCode: tracer.exitCode});
  }
}
async function controller(target: string): Promise<number> {
  if (process.platform !== 'linux' || process.geteuid?.() === 0) {throw new Refusal('TARGET_UNSUPPORTED');}
  const root = await realpath(target);
  const revision = (await execute('git', ['rev-parse', 'HEAD'], {cwd: root})).stdout.trim();
  const dirty = (await execute('git', ['status', '--porcelain'], {cwd: root})).stdout;
  if (revision !== targetRevision || dirty !== '') {throw new Refusal('TARGET_NOT_EXACT');}
  if (process.version !== 'v26.11.1') {throw new Refusal('NODE_VERSION_REFUSED');}
  const worker = await workerAncestor();
  emit('diagnostic-start', {targetRevision, worker, qualification: false, context: 'manual unchanged measure phase; not PR wrapper/full CI'});
  const observer = spawn('/usr/bin/sudo', ['-n', process.execPath, fileURLToPath(import.meta.url), '--trace-worker', String(worker.pid), worker.startTicks], {stdio: ['pipe', 'pipe', 'pipe']});
  const control = observerControl(observer.stdin);
  const exit = exited(observer); void exit.catch(() => {});
  const attached = Promise.withResolvers<void>();
  const relay = (async () => {
    if (!observer.stdout) {throw new Error('observer stdout unavailable');}
    for await (const line of lines(observer.stdout)) {
      process.stdout.write(line + '\n');
      if (line.startsWith('WORKER_SIGNAL_DIAGNOSTIC ')) {
        const value: unknown = JSON.parse(line.slice('WORKER_SIGNAL_DIAGNOSTIC '.length));
        if (value && typeof value === 'object' && 'kind' in value && value.kind === 'attached') {attached.resolve();}
      }
    }
  })();
  void relay.catch(attached.reject);
  // Deliberately discard sudo/helper stderr bytes; no arbitrary process diagnostics enter the evidence log.
  observer.stderr?.resume();
  try {
    await deadline(Promise.race([attached.promise, exit.then(() => {throw new Refusal('SUDO_OR_HELPER_REFUSED');})]), 15_000, new Refusal('ATTACHMENT_UNPROVED'));
    const phase = spawn(process.execPath, ['scripts/ci/measure.ts', 'check:ci:quick'], {cwd: root, env: {...process.env, EXPECTED_REVISION: targetRevision, BENCHMARK_ARM: 'production'}, stdio: 'inherit'});
    const code = await exited(phase); emit('phase-completed', {exitCode: code, qualification: false}); return code ?? 1;
  } finally {
    if (observer.exitCode === null && observer.signalCode === null) {control.stop();}
    // Never kill the sudo monitor or a process group. The root helper bounds and owns tracer teardown.
    const code = await deadline(exit, 920_000, new Refusal('OBSERVER_CLEANUP_UNPROVED'));
    await deadline(relay, 5_000, new Refusal('RELAY_UNDRAINED'));
    if (code !== 0) {throw new Refusal('OBSERVER_CLEANUP_UNPROVED');}
    if (control.refused()) {throw new Refusal('OBSERVER_CONTROL_CLOSED');}
  }
}
export async function main(args: readonly string[]): Promise<number> {
  if (args.length === 2 && args[0] === '--target') {return controller(args[1]!);}
  if (args.length === 3 && args[0] === '--trace-worker' && /^\d+$/u.test(args[2]!)) {await traceWorker(positivePid(args[1]!), args[2]!); return 0;}
  throw new Error('one explicit observer mode required');
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {process.exitCode = await main(process.argv.slice(2));}
  catch (error) {const code = error instanceof Refusal ? error.code : 'INTERNAL_FAILURE';
    emit('diagnostic-failed', {phase: refusalPhases[code], code, errorType: error instanceof Error ? error.name : 'unknown', qualification: false}); process.exitCode = 1;}
}
