import assert from 'node:assert/strict';
import {test} from 'node:test';
import childProcess from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCE,config} from './linux-codex-driver-test-fixture.mjs';
// Execute the actual CLI with a FIFO whose writer remains open through exit.
// Only setup dependencies are synthetic; command input and process liveness are real.
for (const failure of ['source', 'configuration', 'setup']) {
  test(`CLI ${failure} failure ${failure === 'setup' ? 'retains owners until explicit released cleanup' : 'exits before ownership'} with persistent FIFO`,
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
      import fs, {appendFileSync} from 'node:fs';
      const root = ${JSON.stringify(root)};
      const event = value => appendFileSync(root + '/events', value + '\\n');
      cp.execFileSync = (_file, args) => args.includes('status') ? '' : '${failure === 'source' ? '0'.repeat(40) : SOURCE}';
      const readSync = fs.readSync;
      fs.readSync = (fd, ...args) => {
        if (fd === 3) {event('credential-read');}
        return readSync(fd, ...args);
      };
      syncBuiltinESMExports();
      globalThis.fixture = {event, root};
      const sources = {
        pg: 'export class Pool {constructor() {globalThis.fixture.event("pool-created");} on() {} async end() {globalThis.fixture.event("pool-closed");}}',
        '../package/live/linux-codex-live-canary-config.ts': \`
          export function createLinuxCodexLiveCanaryConfiguration() {
            globalThis.fixture.event('configuration');
            ${failure === 'configuration' ? "throw new Error('synthetic configuration failure');" : ''}
          }
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
    const args = ['--import', preload];
    args.push(fileURLToPath(new URL('./run-linux-codex-live-canary.mjs', import.meta.url)),
      join(root, 'config.json'), '3');
    child = childProcess.spawn(process.execPath, args, {stdio: [input, 'pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '', exited = false;
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    child.stdio[3].on('error', () => {}); // Source rejection may close before the synthetic write.
    // Early rejection must not wait for credential bytes or EOF.
    if (failure === 'setup') {
      child.stdio[3].end(JSON.stringify({token: 'synthetic-token', accountId: 'synthetic-account'}));
    }
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
    if (failure !== 'setup') {
      await waitFor(() => exited);
      assert.deepEqual(await exit, {code: 1, signal: null});
      assert.equal(fs.fstatSync(input).isFIFO(), true); // No command or EOF sent.
      assert.equal(stdout, '');
      assert.equal(stderr, (failure === 'configuration' ? '{"setupStage":"configuration"}\n' : '') +
        'Canary incomplete; retain attempt evidence. No automatic retry.\n');
      assert.equal(fs.existsSync(join(root, 'evidence')), false); // Includes attempt.json.
      assert.deepEqual(readdirSync(join(root, 'project')), []);
      assert.equal(fs.existsSync(join(root, 'events')) ? readFileSync(join(root, 'events'), 'utf8') : '',
        failure === 'configuration' ? 'configuration\n' : '');
      return;
    }
    await waitFor(() => stdout.includes('"cleanup":"pending"'));
    assert.equal(stderr, '');
    assert.equal(JSON.parse(stdout).cleanup, 'pending');
    assert.ok(fs.existsSync(join(root, 'evidence/attempt.json')));
    assert.ok(fs.existsSync(join(root, 'project/owned')));
    const events = () => readFileSync(join(root, 'events'), 'utf8').trim().split('\n');
    const initialEvents = events();
    assert.equal(initialEvents[0], 'configuration');
    assert.ok(initialEvents.slice(1, -2).length > 0);
    assert.ok(initialEvents.slice(1, -2).every(event => event === 'credential-read'));
    assert.deepEqual(initialEvents.slice(-2), ['pool-created', 'setup']);
    await new Promise(resolve => {setTimeout(resolve, 100);});
    assert.equal(exited, false, 'setup owners must retain CLI before cleanup');
    fs.writeSync(input, 'cleanup\n');
    await waitFor(() => records().some(r => r.kind === 'cleanup' && r.value.state === 'pending'));
    await new Promise(resolve => {setTimeout(resolve, 150);});
    assert.equal(exited, false, 'pending cleanup must retain CLI');
    assert.ok(fs.existsSync(join(root, 'project/owned')));
    assert.deepEqual(events(), [...initialEvents, 'cleanup']);
    fs.writeSync(input, 'cleanup\n');
    await waitFor(() => exited);
    assert.deepEqual(await exit, {code: 2, signal: null});
    assert.equal(fs.fstatSync(input).isFIFO(), true); // Writer never sent EOF.
    assert.deepEqual(readdirSync(join(root, 'project')), []);
    assert.deepEqual(events(), [...initialEvents, 'cleanup', 'cleanup', 'pool-closed']);
    const saved = records();
    assert.ok(saved.some(r => r.kind === 'cleanup' && r.value.state === 'released'));
    assert.ok(saved.some(r => r.kind === 'pool' && r.value.state === 'closed'));
    assert.equal(saved.some(r => r.kind === 'submit'), false);
  });
}
