import assert from 'node:assert/strict';
import {test} from 'node:test';
import childProcess from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCE,config} from './linux-codex-driver-test-fixture.mjs';
// Execute the actual CLI with a FIFO whose writer remains open through exit.
// Only setup dependencies are synthetic; command input and process liveness are real.
for (const failure of ['source', 'setup']) {
  test(`CLI ${failure} failure exits only after explicit released cleanup with persistent FIFO`,
    {skip: process.platform !== 'linux', timeout: 15_000}, async t => {
    const fs = await import('node:fs');
    const {fileURLToPath} = await import('node:url');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ar69-cli-exit-')));
    const fifo = join(root, 'commands');
    childProcess.execFileSync('mkfifo', [fifo]);
    const input = fs.openSync(fifo, fs.constants.O_RDWR);
    let child;
    t.after(() => {
      child?.kill('SIGKILL');
      fs.closeSync(input);
      rmSync(root, {recursive: true, force: true});
    });
    mkdirSync(join(root, 'project'), {mode: 0o700});
    fs.writeFileSync(join(root, 'config.json'), JSON.stringify(config(root)));
    const preload = join(root, 'fixture.mjs');
    fs.writeFileSync(preload, `
      import cp from 'node:child_process';
      import {registerHooks, syncBuiltinESMExports} from 'node:module';
      import {appendFileSync} from 'node:fs';
      const root = ${JSON.stringify(root)};
      const event = value => appendFileSync(root + '/events', value + '\\n');
      cp.execFileSync = (_file, args) => args.includes('status') ? '' : '${SOURCE}';
      syncBuiltinESMExports();
      globalThis.fixture = {event, root};
      const sources = {
        pg: 'export class Pool {on() {} async end() {globalThis.fixture.event("pool-closed");}}',
        './linux-codex-live-canary-config.ts': \`
          export async function setupLinuxCodexLiveCanary() {
            const {event, root} = globalThis.fixture;
            event('setup');
            const {mkdirSync, rmSync} = await import('node:fs');
            const directory = root + '/project/owned';
            mkdirSync(directory);
            let calls = 0;
            throw Object.assign(new Error('synthetic setup failure'), {directory,
              async cleanup() {
                event('cleanup');
                if (++calls === 1) {return 'pending';}
                rmSync(directory, {recursive: true});
                return 'released';
              },
              async observe() {throw new Error('no submission');}
            });
          }
        \`,
        './linux-codex-live-evidence.mjs': 'export function collectLinuxCodexLiveEvidence() {return {markerObserved: false, records: []};}'
      };
      registerHooks({resolve(s, c, next) {
        return sources[s] ? {url: 'synthetic:' + s, shortCircuit: true} : next(s, c);
      }, load(u, c, next) {
        return u.startsWith('synthetic:') ? {format: 'module', source: sources[u.slice(10)], shortCircuit: true} : next(u, c);
      }});
    `);
    const args = failure === 'setup' ? ['--import', preload] : [];
    args.push(fileURLToPath(new URL('./run-linux-codex-live-canary.mjs', import.meta.url)),
      join(root, 'config.json'), '3');
    child = childProcess.spawn(process.execPath, args, {stdio: [input, 'pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '', exited = false;
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    child.stdio[3].on('error', () => {}); // Source rejection may close before the synthetic write.
    child.stdio[3].end(JSON.stringify({token: 'synthetic-token', accountId: 'synthetic-account'}));
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {exited = true; resolve({code, signal});});
    });
    const waitFor = async predicate => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert.equal(exited, false, stderr);
        assert.ok(Date.now() < deadline, 'timed out: ' + stderr);
        await new Promise(resolve => {setTimeout(resolve, 20);});
      }
    };
    const records = () => readdirSync(join(root, 'evidence'))
      .filter(name => /^\d.*\.json$/u.test(name))
      .map(name => JSON.parse(readFileSync(join(root, 'evidence', name))));
    await waitFor(() => failure === 'source' ? stderr.includes('Canary incomplete;') : stdout.includes('"cleanup":"pending"'));
    await new Promise(resolve => {setTimeout(resolve, 100);});
    assert.equal(exited, false);
    if (failure === 'setup') {
      fs.writeSync(input, 'cleanup\n');
      await waitFor(() => records().some(r => r.kind === 'cleanup' && r.value.state === 'pending'));
      await new Promise(resolve => {setTimeout(resolve, 150);});
      assert.equal(exited, false, 'pending cleanup must retain CLI');
      assert.ok(fs.existsSync(join(root, 'project/owned')));
      assert.equal(readFileSync(join(root, 'events'), 'utf8'), 'setup\ncleanup\n');
    }
    fs.writeSync(input, 'cleanup\n');
    await waitFor(() => exited);
    assert.deepEqual(await exit, {code: 2, signal: null});
    assert.equal(fs.fstatSync(input).isFIFO(), true); // Writer never sent EOF.
    if (failure === 'setup') {
      assert.deepEqual(readdirSync(join(root, 'project')), []);
      assert.equal(readFileSync(join(root, 'events'), 'utf8'), 'setup\ncleanup\ncleanup\npool-closed\n');
      const saved = records();
      assert.ok(saved.some(r => r.kind === 'cleanup' && r.value.state === 'released'));
      assert.ok(saved.some(r => r.kind === 'pool' && r.value.state === 'closed'));
      assert.equal(saved.some(r => r.kind === 'submit'), false);
    } else {
      assert.equal(fs.existsSync(join(root, 'evidence')), false);
      assert.equal(stdout, '');
    }
  });
}
