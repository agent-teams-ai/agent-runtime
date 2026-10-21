/** Prepare-only successor diagnostic: fixed Listener shutdown codes and numeric memory counters only. */
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {constants} from 'node:fs';
import {open, readdir, readlink, realpath, stat, type FileHandle} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {identity, workerAncestor, type Identity} from './runner-worker-signal-observer.mts';

const execute = promisify(execFile);
const targetRevision = '8b1735d716491445d8d9b97efec4adb40557ea5b';
type Emit = (kind: string, value?: Record<string, unknown>) => void;
const emit: Emit = (kind, value = {}) => {process.stdout.write('LISTENER_SHUTDOWN_DIAGNOSTIC ' + JSON.stringify({kind, wallMs: Date.now(), ...value}) + '\n');};
const codes = ['TARGET_REFUSED','LISTENER_IDENTITY_REFUSED','LISTENER_LOG_REFUSED','LISTENER_LOG_ROTATED','LISTENER_LOG_BOUND','MEMORY_REFUSED','OBSERVATION_BOUND','OBSERVATION_FAILED'] as const;
type Code = typeof codes[number];
class Refusal extends Error {readonly code: Code; constructor(code: Code) {super(code); this.code = code;}}

export function shutdownCode(line: string): string | undefined {
  const record = /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ INFO (HostContext|Runner)\] (.*)$/u.exec(line);
  if (!record) {return undefined;}
  const message = record[2];
  if (record[1] === 'HostContext') {
    if (message === 'Runner will be shutdown for UserCancelled') {return 'HOST_CONTEXT_USER_CANCELLED';}
    if (message === 'Runner will be shutdown for OperatingSystemShutdown') {return 'HOST_CONTEXT_OS_SHUTDOWN';}
  } else {
    if (message === 'Received Ctrl-C signal, stop Runner.Listener and Runner.Worker.') {return 'LISTENER_CTRL_C';}
    if (message === 'Received Ctrl-Break signal from runner service host, this indicate the operating system is shutting down.') {return 'LISTENER_CTRL_BREAK';}
    if (/^Service requests the hosted runner to shutdown\. Reason: '[^\r\n]*'\.$/u.test(message!)) {return 'HOSTED_SERVICE_SHUTDOWN_REASON_WITHHELD';}
  }
  return undefined;
}
export function memoryFields(text: string, kind: 'meminfo' | 'events'): Record<string, string> {
  const allowed = kind === 'meminfo' ? ['MemTotal','MemAvailable','SwapTotal','SwapFree'] : ['low','high','max','oom','oom_kill','oom_group_kill'];
  const values: Record<string,string> = {};
  for (const line of text.trim().split('\n')) {
    const match = kind === 'meminfo' ? /^([A-Za-z_]+):\s+(\d+) kB$/u.exec(line) : /^([a-z_]+) (\d+)$/u.exec(line);
    if (match && allowed.includes(match[1]!)) {
      if (values[match[1]!] !== undefined) {throw new Refusal('MEMORY_REFUSED');}
      values[match[1]!] = match[2]!;
    }
  }
  const required = kind === 'meminfo' ? allowed : ['oom','oom_kill'];
  if (required.some(key => values[key] === undefined)) {throw new Refusal('MEMORY_REFUSED');}
  return values;
}
export function memoryAmount(text: string, unlimited: boolean): string {
  const value = text.trim();
  if (!/^\d+$/u.test(value) && !(unlimited && value === 'max')) {throw new Refusal('MEMORY_REFUSED');}
  return value;
}
export function completeLogLine(line: string): string | undefined {
  if (Buffer.byteLength(line) > 8192) {throw new Refusal('LISTENER_LOG_BOUND');}
  return shutdownCode(line);
}
export function logDecoder(): (chunk: Buffer) => readonly string[] {
  let pending = Buffer.alloc(0); let bytes = 0;
  return chunk => {
    bytes += chunk.length;
    if (bytes > 4*1024*1024) {throw new Refusal('LISTENER_LOG_BOUND');}
    pending = Buffer.concat([pending,chunk]); const found: string[] = []; let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      const code = completeLogLine(pending.subarray(0,end).toString('utf8')); pending = pending.subarray(end+1);
      if (code) {found.push(code);}
    }
    if (pending.length > 8192) {throw new Refusal('LISTENER_LOG_BOUND');}
    return found;
  };
}
export async function joinObservation(workload: Promise<number | null>, finish: () => Promise<void>, refused: () => boolean): Promise<number> {
  let exitCode: number | null = 1;
  try {exitCode = await workload;} finally {await finish();}
  return refused() ? 1 : exitCode ?? 1;
}
async function bounded(path: string, max = 8192): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {const buffer = Buffer.alloc(max + 1); const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max) {throw new Refusal('MEMORY_REFUSED');} return buffer.subarray(0,bytesRead).toString('utf8');
  } finally {await handle.close();}
}
async function memoryRoot(listener: Identity): Promise<string> {
  const row = (await bounded(`/proc/${listener.pid}/cgroup`)).trim().split('\n').find(line => line.startsWith('0::'));
  const group = row?.slice(3);
  if (!group?.startsWith('/') || group.includes('\0') || group.split('/').includes('..')) {throw new Refusal('MEMORY_REFUSED');}
  const base = await realpath('/sys/fs/cgroup'); const root = await realpath(base + group);
  if (root !== base && !root.startsWith(base + '/')) {throw new Refusal('MEMORY_REFUSED');}
  return root;
}
async function memory(root: string): Promise<Record<string,unknown>> {
  const [info,events,current,max] = await Promise.all([bounded('/proc/meminfo'),bounded(root+'/memory.events'),bounded(root+'/memory.current'),bounded(root+'/memory.max')]);
  return {meminfoKb: memoryFields(info,'meminfo'),cgroupEvents: memoryFields(events,'events'),cgroupCurrentBytes: memoryAmount(current,false),cgroupMaxBytes: memoryAmount(max,true)};
}
async function sameListener(listener: Identity): Promise<void> {
  const current = await identity(listener.pid);
  if (JSON.stringify(current) !== JSON.stringify(listener)) {throw new Refusal('LISTENER_IDENTITY_REFUSED');}
}
async function listenerLog(listener: Identity): Promise<{handle: FileHandle; procFd: string; target: string; offset: number; device: number; inode: number}> {
  // Official 2.338.0 HostContext139 + HostTraceListener12/188: bin-parent/_diag/Runner_<UTC>.log.
  const diag = await realpath(resolve(dirname(listener.executable),'..','_diag'));
  const found: {procFd:string;target:string}[] = [];
  for (const fd of await readdir(`/proc/${listener.pid}/fd`)) {
    if (!/^\d+$/u.test(fd)) {continue;}
    const procFd = `/proc/${listener.pid}/fd/${fd}`;
    let target: string; try {target = await readlink(procFd);} catch {continue;}
    if (/^Runner_\d{8}-\d{6}-utc\.log$/u.test(basename(target)) && dirname(target) === diag) {found.push({procFd,target});}
  }
  if (found.length !== 1) {throw new Refusal('LISTENER_LOG_REFUSED');}
  const selected = found[0]!; const handle = await open(selected.procFd,constants.O_RDONLY);
  try {
    const metadata = await handle.stat(); await sameListener(listener);
    if (!metadata.isFile() || metadata.uid !== listener.uid || await readlink(selected.procFd) !== selected.target) {throw new Refusal('LISTENER_LOG_REFUSED');}
    emit('listener-log-bound',{listener,device:metadata.dev,inode:metadata.ino,startOffset:metadata.size});
    return {...selected,handle,offset:metadata.size,device:metadata.dev,inode:metadata.ino};
  } catch (error) {await handle.close(); throw error;}
}
function exited(child: ChildProcess): Promise<number | null> {return new Promise((accept,reject) => {child.once('error',reject);child.once('exit',accept);});}
async function controller(target: string): Promise<number> {
  if (process.platform !== 'linux' || process.geteuid?.() === 0 || process.version !== 'v26.11.1') {throw new Refusal('TARGET_REFUSED');}
  const root = await realpath(target);
  if ((await execute('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim() !== targetRevision || (await execute('git',['status','--porcelain'],{cwd:root})).stdout !== '') {throw new Refusal('TARGET_REFUSED');}
  const worker = await workerAncestor(); const listener = await identity(worker.parentPid);
  if (basename(listener.executable) !== 'Runner.Listener' || dirname(listener.executable) !== dirname(worker.executable) || listener.uid !== worker.uid) {throw new Refusal('LISTENER_IDENTITY_REFUSED');}
  const log = await listenerLog(listener); let stop = false; let failed = false;
  try {
    const cgroup = await memoryRoot(listener); emit('memory-before',await memory(cgroup));
    emit('observation-start',{targetRevision,worker,listener,qualification:false,context:'manual unchanged quick measure; no OS signal attachment'});
    const decode = logDecoder();
    const drainBoundLog = async () => {
      // This retained FD stays bound to the original generation even if the Listener has exited.
      const metadata = await log.handle.stat();
      if (metadata.dev !== log.device || metadata.ino !== log.inode || metadata.size < log.offset) {throw new Refusal('LISTENER_LOG_ROTATED');}
      while (true) {
        const buffer = Buffer.alloc(65536); const read = await log.handle.read(buffer,0,buffer.length,log.offset);
        if (read.bytesRead === 0) {return;}
        log.offset += read.bytesRead;
        for (const code of decode(buffer.subarray(0,read.bytesRead))) {emit('listener-shutdown-code',{code,listenerStartTicks:listener.startTicks});}
      }
    };
    const monitor = (async () => {
      let ticks = 0;
      while (!stop) {
        if (ticks >= 900) {throw new Refusal('OBSERVATION_BOUND');}
        await sameListener(listener);
        if (await readlink(log.procFd) !== log.target) {throw new Refusal('LISTENER_LOG_ROTATED');}
        const live = await stat(log.procFd);
        if (live.dev !== log.device || live.ino !== log.inode || live.size < log.offset) {throw new Refusal('LISTENER_LOG_ROTATED');}
        await drainBoundLog();
        if (++ticks % 5 === 0) {emit('memory-sample',await memory(cgroup));}
        await new Promise(accept => setTimeout(accept,1000));
      }
    })().catch(error => {failed = true; emit('observation-refused',{code:error instanceof Refusal ? error.code : 'OBSERVATION_FAILED',qualification:false});});
    return await joinObservation((async () => {
      const phase = spawn(process.execPath,['scripts/ci/measure.ts','check:ci:quick'],{cwd:root,env:{...process.env,EXPECTED_REVISION:targetRevision,BENCHMARK_ARM:'production'},stdio:'inherit'});
      const exitCode = await exited(phase); emit('workload-completed',{exitCode,qualification:false}); return exitCode;
    })(),async () => {
      stop = true; await monitor; await drainBoundLog();
      emit('listener-final-drain',{listenerStartTicks:listener.startTicks,liveAuthorityGranted:false});
      emit('memory-after',await memory(cgroup));
    },() => failed);
  } finally {await log.handle.close(); emit('listener-file-closed',{qualification:false});}
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {if (process.argv.length !== 4 || process.argv[2] !== '--target') {throw new Refusal('TARGET_REFUSED');} process.exitCode = await controller(process.argv[3]!);}
  catch (error) {emit('diagnostic-refused',{code:error instanceof Refusal ? error.code : 'OBSERVATION_FAILED',qualification:false}); process.exitCode = 1;}
}
