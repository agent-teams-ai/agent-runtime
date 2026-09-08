#!/usr/bin/env node
// Test-only executable. Importing performs no setup, credential reads or launch.
import {constants, openSync, closeSync, readSync, writeFileSync, fsyncSync,
  fstatSync, readFileSync, lstatSync, realpathSync, readdirSync, mkdirSync} from 'node:fs';
import {join, resolve as resolvePath, dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export const usage = `Node 24 source-loads the test-only .ts administration modules; their runtime imports
require existing built dist and pg dependencies:
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
function validateDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || !url.username ||
      url.password || url.search || url.hash || !/^\/ar69_pa_test_[a-z0-9]+$/u.test(url.pathname)) {fail();}
}
export function validateConfiguration(value) {
  const c = structuredClone(value);
  validateDatabase(c.databaseUrl);
  if (c.ownerApproved !== true || c.disposableDatabase !== true || c.disposableTestParent !== true ||
      !/^[a-f0-9]{40}$/u.test(c.hostPins?.sourceRevision ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.txt$/u.test(c.approval?.markerFile) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(c.approval?.marker)) {fail();}
  for (const path of [c.hostPins.testParent, c.evidenceDirectory]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolvePath(path) !== path || path === '/') {fail();}
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
function readCredentialFields(credentialFd, closeCredential) {
  const stat = fstatSync(credentialFd);
  if (!stat.isFIFO() && !stat.isSocket()) {fail();}
  let fields;
  try {fields = JSON.parse(readBounded(credentialFd, 40_000));} finally {closeCredential();}
  if (Object.keys(fields).toSorted().join(',') !== 'accountId,token' ||
      ![fields.token, fields.accountId].every(v => typeof v === 'string' && v.length &&
        Buffer.byteLength(v) <= 16384 && !/[\r\n\0]/u.test(v))) {fail();}
  return fields;
}

function privateDirectory(path, empty = false) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) || (empty && readdirSync(path).length)) {fail();}
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {fsyncSync(fd);} finally {closeSync(fd);}
}
function durableCreate(path, value) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd);} finally {closeSync(fd);}
  syncDirectory(dirname(path));
}
function preflightHost(config) {
  const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
  const actualSourceSHA = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'],
    {encoding: 'utf8', timeout: 5000, maxBuffer: 1024}).trim();
  if (actualSourceSHA !== config.hostPins.sourceRevision ||
      execFileSync("git", ["-C", repository, "status", "--porcelain", "--untracked-files=no"],
        {encoding: "utf8", timeout: 5000, maxBuffer: 4096}).trim()) {fail();}
  privateDirectory(config.hostPins.testParent, true);
  privateDirectory(dirname(config.evidenceDirectory));
  return actualSourceSHA;
}
function prepareAttempt(config, actualSourceSHA) {
  mkdirSync(config.evidenceDirectory, {mode: 0o700}); // Exclusive run, never reuse evidence.
  syncDirectory(dirname(config.evidenceDirectory));
  privateDirectory(config.evidenceDirectory, true);
  durableCreate(join(config.evidenceDirectory, 'attempt.json'), {actualSourceSHA,
    commandId: config.approval.commandId, testId: config.approval.testId,
    databaseName: new URL(config.databaseUrl).pathname.slice(1),
    testParent: config.hostPins.testParent, state: 'consumed-before-setup-no-retry',
    driverSHA256: digest(readFileSync(fileURLToPath(import.meta.url)))});
  return actualSourceSHA;
}

// Only fixed stage codes cross the diagnostic boundary; never inspect causes or stacks.
export function safeSetupStage(error) {
  try {
    const stage = error?.setupStage;
    return ['admin-setup', 'configuration', 'schema', 'pa', 'rs', 'operation-store', 'workspace',
      'artifacts', 'node-recipe', 'host-composition'].includes(stage) ? stage : undefined;
  } catch {return;}
}
const identity = text => text;
export function createRedactor(fields) {
  const secrets = Object.values(fields).flatMap(v => [v, JSON.stringify(v).slice(1, -1),
    Buffer.from(v).toString('base64'), digest(v), encodeURIComponent(v)]).toSorted((a,b) => b.length-a.length);
  return text => secrets.reduce((s, secret) => s.split(secret).join('[REDACTED]'), text);
}
async function pollObservation(observe) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const observation = await observe();
    if (observation.status !== 'observed' ||
        !['accepted', 'running'].includes(observation.turn.status)) {break;}
    await new Promise(resolve => {setTimeout(resolve, 500);});
  }
}
// Narrow lifecycle controller, also exercised with synthetic resource owners in unit tests.
export function createCleanupController({collect, getLive, hasPool, closePool, report, getOperationId}) {
  let released = false, cleanupFlight;
  const cleanup = () => {
    if (cleanupFlight) {return cleanupFlight;}
    cleanupFlight = (async () => {
      if (!released) {
        // Evidence must survive the admin's removal of its tree on release.
        try {collect();} catch {report('evidence-incomplete', {stage: 'artifact-receipt'}); return 'pending';}
        let state = 'pending';
        try {
          if (getLive()?.cleanup) {state = await getLive().cleanup({deadlineEpochMs: Date.now() + 30_000,
            signal: AbortSignal.timeout(30_000)});}
          else if (!hasPool()) {state = 'released';}
        } catch { /* Preserve unknown cleanup and retained owners. */ }
        released = state === 'released';
        report('cleanup', {state, directory: getLive()?.directory, operationId: getOperationId(),
          reconciliation: released ? 'resource-release-only' : 'retain-this-driver-and-database; explicit cleanup retry'});
      }
      if (released && hasPool()) {await closePool(); report('pool', {state: 'closed'});}
      return released ? 'released' : 'pending';
    })().finally(() => {cleanupFlight = undefined;});
    return cleanupFlight;
  };
  return Object.freeze({cleanup, isReleased: () => released});
}
export function createLinuxCodexLiveCanaryDriver(configuration, credentialFd) {
  const config = validateConfiguration(configuration);
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 3) {fail();}
  let started = false, reconciliationReady = false, live, realPool, operationId, sequence = 0;
  let observedStatus = 'unknown', markerObserved = false, evidenceWriteFailed = false;
  const observations = [];
  let collectLinuxCodexLiveEvidence;
  let redact = identity;
  const sanitize = value => typeof value === 'string' ? redact(value) :
    Array.isArray(value) ? value.map(sanitize) : value && typeof value === 'object' ?
      Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), sanitize(item)])) : value;
  let reportReady = false;
  const pendingReports = [];
  const report = (kind, value) => {
    if (!reportReady) {return;}
    const record = {kind, at: new Date().toISOString(), value: sanitize(value)};
    try {persistReport(record);} catch {
      evidenceWriteFailed = true; pendingReports.push(record);
    } // Retain failed records as well as the historical diagnostic.
  };
  const persistReport = record => {
    durableCreate(join(config.evidenceDirectory, `${String(sequence++).padStart(4, '0')}-${record.kind}.json`), record);
  };
  const retainOutcome = (kind, value) => {
    observations.push(value);
    if (observations.length > 512) {observations.shift();}
    observedStatus = value?.turn?.status ?? value?.status ?? 'unknown';
    operationId = value?.turn?.operationId ?? value?.operationId ?? value?.candidateOperationId ?? operationId;
    report(kind, value);
  };
  const observe = async () => {
    if (!live?.observe || !operationId || isReleased()) {return {status: 'unavailable'};}
    const value = await live.observe(operationId); retainOutcome('observe', value); return value;
  };
  const cancel = async () => {
    if (!live?.cancel || !operationId || isReleased()) {return {status: 'unavailable'};}
    const value = await live.cancel(operationId); retainOutcome('cancel', value); return value;
  };
  const collect = () => {
    // Retry persistence only, never submission. Failed writes may have left a
    // partial file, so every retry gets a fresh exclusive sequence path.
    while (pendingReports.length) {
      persistReport(pendingReports[0]); pendingReports.shift();
    }
    if (!live?.directory) {return;}
    // Admin exposes tree.root; the collector reads artifacts/ and workspaces/
    // relative to the disposable root allocated by linux-codex-live-admin-directories.ts.
    const evidence = collectLinuxCodexLiveEvidence({root: join(live.directory, 'disposable'), approval: config.approval,
      operationId, observations});
    markerObserved = evidence.markerObserved;
    for (const record of evidence.records) {report(record.kind, record.value);}
    if (pendingReports.length) {fail();}
  };
  const {cleanup: cleanupResources, isReleased} = createCleanupController({collect, getLive: () => live,
    hasPool: () => realPool !== undefined,
    closePool: async () => {await realPool.end(); realPool = undefined;}, report,
    getOperationId: () => operationId});
  // Do not declare release while setup/submission may still acquire owners.
  const cleanup = () => reconciliationReady ? cleanupResources() : Promise.resolve('pending');
  return Object.freeze({observe, cancel, cleanup, async run() {
    if (started) {fail();}
    started = true; // Consume in-memory admission before the first await.
    let credentialOpen = true;
    const closeCredential = () => {
      if (credentialOpen) {credentialOpen = false; try {closeSync(credentialFd);} catch { /* Invalid FD. */ }}
    };
    try {
      const actualSourceSHA = preflightHost(config);
      const {createLinuxCodexLiveCanaryConfiguration, setupLinuxCodexLiveCanary} =
        await import('./linux-codex-live-canary-config.ts');
      try {
        if (config.hostPins.firewall) {
          const {createFirewallCommand} = await import('./linux-codex-live-admin-firewall.ts');
          const {toolPaths, ...pins} = config.hostPins.firewall;
          config.hostPins.firewall = {...pins, command: createFirewallCommand(toolPaths)};
        }
        // Constructor-only admission: no command invocation or credential ownership.
        // Discard time-bound policy; setup rebuilds it at the existing transfer boundary.
        createLinuxCodexLiveCanaryConfiguration(config.approval, config.hostPins);
      } catch {
        throw Object.assign(new Error('Canary configuration preflight refused'), {setupStage: 'configuration'});
      }
      // Recheck host facts after module loading, before durable admission.
      prepareAttempt(config, preflightHost(config));
      reportReady = true;
      report('report', {actualSourceSHA, usage, liveExecution: 'not-yet-observed'});
      let credentials, transferred = false;
      try {
        let fields = readCredentialFields(credentialFd, closeCredential);
        redact = createRedactor(fields);
        credentials = {token: new Uint8Array(Buffer.from(fields.token)), accountId: new Uint8Array(Buffer.from(fields.accountId))};
        fields = undefined;
        reportReady = true;
        report('report', {actualSourceSHA, usage, liveExecution: 'not-yet-observed'});
        const [{Pool}, evidenceModule] = await Promise.all([
          import('pg'), import('./linux-codex-live-evidence.mjs')]);
        collectLinuxCodexLiveEvidence = evidenceModule.collectLinuxCodexLiveEvidence;
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
        if (operationId) {await pollObservation(observe);}
      } catch (error) {
        observedStatus = 'unknown';
        report('unknown', {operationId, commandId: config.approval.commandId, retryAllowed: false,
          setupStage: safeSetupStage(error)});
      } finally {
        for (const bytes of Object.values(transferred ? {} : credentials ?? {})) {try {bytes.fill(0);} catch { /* Transferred. */ }}
        closeCredential();
        reconciliationReady = true;
      }
      let evidenceComplete = false;
      try {collect(); evidenceComplete = true;} catch {report('evidence-incomplete', {stage: 'artifact-receipt'});}
      const automaticRelease = !live && !realPool ||
        observedStatus === 'succeeded' && markerObserved && evidenceComplete && !evidenceWriteFailed;
      return sanitize({cleanup: automaticRelease ? await cleanup() : 'pending', observedStatus, markerObserved,
        operationId, evidenceWriteFailed, evidenceDirectory: config.evidenceDirectory});
    } finally {closeCredential(); reconciliationReady = true;}
  }});
}

async function reconcile(driver) {
  process.exitCode = 2;
  const keepAlive = setInterval(() => {}, 30_000);
  const {createInterface} = await import('node:readline');
  const commands = createInterface({input: process.stdin, terminal: false});
  for await (const line of commands) {
    try {
      if (line === 'observe') {await driver.observe();}
      if (line === 'cancel') {await driver.cancel();}
      if (line === 'cleanup' && await driver.cleanup() === 'released') {
        // readline.close() alone can leave inherited FIFO stdin referenced.
        // This CLI owns command input; dispose it only after owners and pool release.
        commands.close();
        process.stdin.destroy();
        clearInterval(keepAlive); break;
      }
    } catch {process.stderr.write('Reconciliation remains pending; owners retained.\n');}
  }
}
async function main() {
  if (process.argv[2] === '--help') {process.stdout.write(usage + '\n'); return;}
  let credentialFd, driver;
  try {
    if (process.argv.length !== 4 || !isAbsolute(process.argv[2])) {fail();}
    credentialFd = Number(process.argv[3]);
    if (!Number.isSafeInteger(credentialFd) || credentialFd < 3) {fail();}
    fstatSync(credentialFd); // Ensure the config open cannot reuse an invalid credential number.
    const fd = openSync(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
    let config;
    try {if (!fstatSync(fd).isFile()) {fail();} config = JSON.parse(readBounded(fd, 8_000_000));}
    finally {closeSync(fd);}
    driver = createLinuxCodexLiveCanaryDriver(config, credentialFd);
    credentialFd = undefined; // Ownership transferred to the first run.
    const result = await driver.run();
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.observedStatus !== 'succeeded' || !result.markerObserved) {process.exitCode = 1;}
    if (result.cleanup === 'pending') {await reconcile(driver);}
  } catch (error) {
    const setupStage = safeSetupStage(error);
    if (setupStage) {process.stderr.write(JSON.stringify({setupStage}) + '\n');}
    process.stderr.write('Canary incomplete; retain attempt evidence. No automatic retry.\n');
    process.exitCode = 1;
    if (driver && await driver.cleanup() !== 'released') {await reconcile(driver);}
  } finally {
    if (Number.isSafeInteger(credentialFd) && credentialFd >= 3) {
      try {closeSync(credentialFd);} catch { /* Invalid or already absent inherited FD. */ }
    }
  }
}
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {await main();}
