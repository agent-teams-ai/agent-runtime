import assert from 'node:assert/strict';
import { readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Plan { executable: string; argv: string[]; cwd: string }
// Linux CI only. Observe original processes through the OS, without changing
// any Node CLI, reporter, loader, worker, or tested child environment.
export function observeEmbeddedProcesses(plans: readonly Plan[], capture: string, commandPid: number): () => Promise<void> {
  assert.equal(process.platform, 'linux'); assert.equal(plans.length, 2);
  const identities = new Map<number, string>();
  const state: { stopped: boolean; failure: unknown } = { stopped: false, failure: null };
  const running = (async () => {
    while (!state.stopped) {
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
    for (const [index, identity] of identities) {
      await writeFile(join(capture, `process-${index}.identity.json`), identity + '\n', { flag: 'wx' });
    }
  };
}
