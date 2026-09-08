#!/usr/bin/env node
// Test-only executable. Importing performs no setup, credential reads or launch.
import {constants, openSync, closeSync, readSync, writeFileSync, fsyncSync,
  fstatSync, readFileSync, lstatSync, realpathSync, readdirSync, mkdirSync} from 'node:fs';
import {join, resolve, dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export const SOURCE = '95f788b73123952ca1362a00c0e8b2c65e372365';
export const usage = `Node 24 with existing built dist and pg dependencies only:
node packages/apps/embedded-runtime/tests/live/run-linux-codex-live-canary.mjs /absolute/approved.json 3
FD 3 must be an inherited pipe/socket carrying JSON {token: string, accountId: string}, then EOF.
Never pass credential paths or credentials in argv/environment/configuration.
Configuration: {ownerApproved: true, disposableDatabase: true, disposableTestParent: true,
 databaseUrl, evidenceDirectory, approval: LinuxCodexCanaryApproval,
 hostPins: LinuxCodexCanaryHostPins}. Use a newly provisioned empty loopback PostgreSQL
 passwordless database named ar69_pa_test_[a-z0-9]+ and a new empty private canonical testParent.
Explicit byte fields use {encoding: 'base64', data: '...'} for native.catalogSource
and each certificateAuthorities entry. hostPins.firewall uses {toolPaths: {docker, ip,
iptables}, hostEngine, daemonId, socketPath}; paths identify installed pinned tools.
Root must supply approved binding/intent, host/boot/daemon identities, image/init lock,
native catalog and ownership, observer/tool/engine pins, TLS roots, and dedicated test credentials.
No installation or environment discovery is performed. Root runs actual E2E after review.
Imported: const driver = createLinuxCodexLiveCanaryDriver(config, credentialFd);
await driver.run(); retain driver while pending; await driver.observe(), driver.cancel(),
driver.cleanup() for explicit reconciliation. run() can never submit twice.
CLI pending keeps owners alive; stdin accepts observe, cancel, cleanup (one per line).
A crash requires operator reconciliation using retained DB, directory, command/candidate IDs
and attempt.json; never rerun or remove the attempt marker to resolve an unknown outcome.
Cleanup released is resource truth only, not successful provider execution.`;
const fail = () => {throw new Error('Explicit disposable canary input or evidence unavailable');};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function decodeBytes(value) {
  if (value?.encoding !== 'base64' || typeof value.data !== 'string' ||
      !value.data.length || value.data.length > 4_000_000) {fail();}
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.toString('base64') !== value.data) {fail();}
  return new Uint8Array(bytes);
}
export function validateConfiguration(value) {
  const c = structuredClone(value);
  const url = new URL(c.databaseUrl);
  if (c.ownerApproved !== true || c.disposableDatabase !== true || c.disposableTestParent !== true ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || !url.username ||
      url.password || url.search || url.hash || !/^\/ar69_pa_test_[a-z0-9]+$/u.test(url.pathname) ||
      c.hostPins?.sourceRevision !== SOURCE ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.txt$/u.test(c.approval?.markerFile) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(c.approval?.marker)) {fail();}
  for (const path of [c.hostPins.testParent, c.evidenceDirectory]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === '/') {fail();}
  }
  if (c.evidenceDirectory === c.hostPins.testParent ||
      c.evidenceDirectory.startsWith(c.hostPins.testParent + '/')) {fail();}
  c.hostPins.native.catalogSource = decodeBytes(c.hostPins.native.catalogSource);
  if (!Array.isArray(c.hostPins.certificateAuthorities) || !c.hostPins.certificateAuthorities.length) {fail();}
  c.hostPins.certificateAuthorities = c.hostPins.certificateAuthorities.map(decodeBytes);
  return c;
}
function readBounded(fd, maximum) {
  const bytes = Buffer.alloc(maximum + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) {break;}
      length += count;
    }
    if (length > maximum) {fail();}
    return bytes.subarray(0, length).toString('utf8');
  } finally {bytes.fill(0);}
}
function privateDirectory(path, empty = false) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) || (empty && readdirSync(path).length)) {fail();}
}
function durableCreate(path, value) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd);} finally {closeSync(fd);}
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {fsyncSync(parent);} finally {closeSync(parent);}
}
export function createLinuxCodexLiveCanaryDriver(configuration, credentialFd) {
  const config = validateConfiguration(configuration);
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 3) {fail();}
  let started = false, live, realPool, operationId, released = false, sequence = 0;
  let cleanupFlight, observedStatus = 'unknown', markerObserved = false;
  let redact = text => text;
  const sanitize = value => typeof value === 'string' ? redact(value) :
    Array.isArray(value) ? value.map(sanitize) : value && typeof value === 'object' ?
      Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), sanitize(item)])) : value;
  let reportReady = false;
  const report = (kind, value) => {
    if (!reportReady) {return;}
    durableCreate(join(config.evidenceDirectory, `${String(sequence++).padStart(4, '0')}-${kind}.json`),
      {kind, at: new Date().toISOString(), value: sanitize(value)});
  };
  const retainOutcome = (kind, value) => {
    observedStatus = value?.turn?.status ?? value?.status ?? observedStatus;
    operationId = value?.turn?.operationId ?? value?.operationId ?? value?.candidateOperationId ?? operationId;
    report(kind, value);
  };
  const observe = async () => {
    if (!live?.observe || !operationId || released) {return {status: 'unavailable'};}
    const value = await live.observe(operationId); retainOutcome('observe', value); return value;
  };
  const cancel = async () => {
    if (!live?.cancel || !operationId || released) {return {status: 'unavailable'};}
    const value = await live.cancel(operationId); retainOutcome('cancel', value); return value;
  };
  // Read only owner artifact/receipt directories, never private homes, auth or logs.
  const collect = () => {
    if (!live?.directory) {return;}
    let count = 0, total = 0;
    const root = live.directory;
    for (const part of ['artifacts/blobs', 'artifacts/manifests', 'artifacts/results', 'workspaces/receipts', 'workspaces/seals']) {
      const directory = join(root, 'disposable', part);
      if (!lstatSync(directory, {throwIfNoEntry: false})) {continue;}
      privateDirectory(directory);
      for (const name of readdirSync(directory)) {
        if (++count > 128) {fail();}
        const path = join(directory, name);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 1_048_576 || (total += stat.size) > 8_388_608) {fail();}
          const text = readBounded(fd, 1_048_576);
          if (part === 'artifacts/blobs') {
            markerObserved ||= text === config.approval.marker + '\n';
            report('artifact-blob', {relativePath: `${part}/${name}`, bytes: stat.size,
              markerMatches: text === config.approval.marker + '\n',
              ...(text === config.approval.marker + '\n' ? {actualMarker: text} : {content: 'omitted'})});
          } else {
            report('artifact-receipt', {relativePath: `${part}/${name}`, record: JSON.parse(text)});
          }
        } finally {closeSync(fd);}
      }
    }
  };
  const cleanup = () => {
    if (cleanupFlight) {return cleanupFlight;}
    cleanupFlight = (async () => {
      if (!released) {
        // Evidence must survive the admin's removal of its tree on release.
        try {collect();} catch {report('evidence-incomplete', {stage: 'artifact-receipt'}); return 'pending';}
        let state = 'pending';
        try {
          if (live?.cleanup) {state = await live.cleanup({deadlineEpochMs: Date.now() + 30_000,
            signal: AbortSignal.timeout(30_000)});}
          else if (!realPool) {state = 'released';}
        } catch { /* Preserve unknown cleanup and retained owners. */ }
        released = state === 'released';
        report('cleanup', {state, directory: live?.directory, operationId,
          reconciliation: released ? 'resource-release-only' : 'retain-this-driver-and-database; explicit cleanup retry'});
      }
      if (released && realPool) {await realPool.end(); realPool = undefined; report('pool', {state: 'closed'});}
      return released ? 'released' : 'pending';
    })().finally(() => {cleanupFlight = undefined;});
    return cleanupFlight;
  };
  return Object.freeze({observe, cancel, cleanup, async run() {
    if (started) {fail();}
    started = true; // Consume in-memory admission before the first await.
    const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
    const actualSourceSHA = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'],
      {encoding: 'utf8', timeout: 5000, maxBuffer: 1024}).trim();
    if (actualSourceSHA !== SOURCE) {fail();}
    privateDirectory(config.hostPins.testParent, true);
    privateDirectory(dirname(config.evidenceDirectory));
    mkdirSync(config.evidenceDirectory, {mode: 0o700}); // Exclusive run, never reuse evidence.
    privateDirectory(config.evidenceDirectory, true);
    durableCreate(join(config.evidenceDirectory, 'attempt.json'), {actualSourceSHA,
      commandId: config.approval.commandId, testId: config.approval.testId,
      databaseName: new URL(config.databaseUrl).pathname.slice(1),
      testParent: config.hostPins.testParent, state: 'consumed-before-setup-no-retry',
      driverSHA256: digest(readFileSync(fileURLToPath(import.meta.url)))});
    reportReady = true;
    report('report', {actualSourceSHA, usage, liveExecution: 'not-yet-observed'});
    let credentials, transferred = false;
    try {
      const stat = fstatSync(credentialFd);
      if (!stat.isFIFO() && !stat.isSocket()) {fail();}
      let fields;
      try {fields = JSON.parse(readBounded(credentialFd, 40_000));} finally {closeSync(credentialFd);}
      if (Object.keys(fields).sort().join(',') !== 'accountId,token' ||
          ![fields.token, fields.accountId].every(v => typeof v === 'string' && v.length &&
            Buffer.byteLength(v) <= 16384 && !/[\r\n\0]/u.test(v))) {fail();}
      const secrets = Object.values(fields).flatMap(v => [v, JSON.stringify(v).slice(1, -1),
        Buffer.from(v).toString('base64'), digest(v), encodeURIComponent(v)]).sort((a,b) => b.length-a.length);
      redact = text => secrets.reduce((s, secret) => s.split(secret).join('[REDACTED]'), text);
      credentials = {token: new Uint8Array(Buffer.from(fields.token)), accountId: new Uint8Array(Buffer.from(fields.accountId))};
      fields = undefined;
      reportReady = true;
      report('report', {actualSourceSHA, usage, liveExecution: 'not-yet-observed'});
      const [{Pool}, {setupLinuxCodexLiveCanary}] = await Promise.all([
        import('pg'), import('./linux-codex-live-canary-config.ts')]);
      if (config.hostPins.firewall) {
        const {createFirewallCommand} = await import('./linux-codex-live-admin-firewall.ts');
        const {toolPaths, ...pins} = config.hostPins.firewall;
        config.hostPins.firewall = {...pins, command: createFirewallCommand(toolPaths)};
      }
      realPool = new Pool({connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 2000,
        query_timeout: 5000, idleTimeoutMillis: 1000, ssl: false,
        password: async () => ''}); // Explicit passwordless disposable DB; never pgpass/environment credentials.
      realPool.on('error', () => report('database-error', {state: 'unknown'}));
      try {transferred = true; live = await setupLinuxCodexLiveCanary(realPool, config.approval, config.hostPins, credentials);}
      catch (error) {if (typeof error?.cleanup === 'function') {live = error;} throw error;}
      report('setup', {directory: live.directory});
      // Durable marker already fsynced; only invocation in this driver, never retried.
      const outcome = await live.submit();
      retainOutcome('submit', outcome);
      if (operationId) {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          const observation = await observe();
          if (observation.status !== 'observed' ||
              !['accepted', 'running'].includes(observation.turn.status)) {break;}
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch {
      report('unknown', {operationId, commandId: config.approval.commandId, retryAllowed: false});
    } finally {
      for (const bytes of Object.values(transferred ? {} : credentials ?? {})) {try {bytes.fill(0);} catch { /* Transferred. */ }}
    }
    return {cleanup: await cleanup(), observedStatus, markerObserved, operationId, evidenceDirectory: config.evidenceDirectory};
  }});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--help') {process.stdout.write(usage + '\n');}
  else {
    try {
      if (process.argv.length !== 4 || !isAbsolute(process.argv[2])) {fail();}
      const fd = openSync(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
      let config;
      try {if (!fstatSync(fd).isFile()) {fail();} config = JSON.parse(readBounded(fd, 8_000_000));}
      finally {closeSync(fd);}
      const driver = createLinuxCodexLiveCanaryDriver(config, Number(process.argv[3]));
      const result = await driver.run();
      process.stdout.write(JSON.stringify(result) + '\n');
      if (result.observedStatus !== 'succeeded' || !result.markerObserved) {process.exitCode = 1;}
      if (result.cleanup === 'pending') {
        process.exitCode = 2;
        const keepAlive = setInterval(() => {}, 30_000);
        const {createInterface} = await import('node:readline');
        for await (const line of createInterface({input: process.stdin, terminal: false})) {
          try {
            if (line === 'observe') {await driver.observe();}
            if (line === 'cancel') {await driver.cancel();}
            if (line === 'cleanup' && await driver.cleanup() === 'released') {
              clearInterval(keepAlive); break;
            }
          } catch {process.stderr.write('Reconciliation remains pending; owners retained.\n');}
        }
      }
    } catch {process.stderr.write('Canary incomplete; retain attempt evidence. No automatic retry.\n'); process.exitCode = 1;}
  }
}
