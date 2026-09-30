import {ordinaryHostOwnershipRetry} from "./ordinary-host-ownership.fixture.ts";
import {ordinaryHostProviderOwnerRetry} from "./ordinary-host-pa-owner-disposal.fixture.ts";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {syncBuiltinESMExports} from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createOrdinaryAgentRuntimeHost} from "../../dist/composition/ordinary-agent-runtime-host.js";
import {createClaudeCodeSetupInspectionPlanner} from "../../dist/composition/claude-code-setup-inspection-planner.js";
import {createAgentRuntimeHost} from "../../dist/composition/agent-runtime-host.js";
function forbidden(): never {throw new Error("TEST port must remain passive", {cause: "synthetic port"});}

test("ordinary Host retains owners and writable journal until retry proves feature closure", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ordinary-retained-TEST-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const open = fs.openSync; const close = fs.closeSync;
  let journalFd: number | undefined; let journalCloses = 0; let hostCloses = 0; let featureCloses = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args); if (String(args[0]).endsWith(".jsonl")) {journalFd = fd;} return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => {if (fd === journalFd) {journalCloses += 1;} return close(fd);});
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const failure = new Error("TEST process termination unproven", {cause: "synthetic feature"}); let stopped = false;
  const pool = {connect: forbidden, query: forbidden};
  const hostFailure = new Error("TEST independent Host owner failure", {cause: "synthetic owner"});
  const dispose = async () => {hostCloses += 1; if (!stopped) {throw hostFailure;}};
  const entered = Promise.withResolvers<AbortSignal>();

  const host = await createOrdinaryAgentRuntimeHost({execution: {provider: "codex", executablePath: join(root, "absent-TEST"), authSourceDirectory: root, privateRoot: root, evidenceRoot: root, sourceDirectory: root, workspaceRoot: root, artifactRoot: root, sourceRevision: "TEST"}, storage: {pool}, scope: {tenantId: "test", projectId: "TEST"}}, async (_signal, ordinary) => {
    await ordinary.factories.provider();
    const realHost = createAgentRuntimeHost({
      codexSetup: {authorizeSetupInspection: {execute: forbidden}, discoverCodexInstallations: {execute: forbidden}, inspectCodexConfiguration: {execute: forbidden}, planCodexSetupInspection: {plan: forbidden}},
      claudeCodeSetup: {authorizeClaudeCodeSetupInspection: {async execute(_input, options): Promise<never> {
        assert.ok(options?.signal); const signal = options.signal; entered.resolve(signal);
        return new Promise((_resolve, reject) => {signal.addEventListener("abort", () => reject(signal.reason), {once: true});});
      }}, discoverClaudeCodeInstallations: {execute: forbidden}, inspectClaudeCodeConfiguration: {execute: forbidden}, planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin")},
    }, {dispose});
    return ordinary.decorateHost(realHost, {
      submit: {execute: async () => ({status: "denied"})},
      observe: {execute: async () => ({status: "not_found"})},
      cancel: {execute: async () => ({status: "not_found"})},
      dispose: async () => {featureCloses += 1; if (!stopped) {throw failure;}},
    });
  });
  const access = host.bindAccess({claudeCodeSetup: {dialect: "claude-code-settings@2026-08-28", explicitExecutablePaths: [], homeRoot: root, workspaceRoot: root, workspaceTrusted: false, observationEpoch: "TEST", pathEntries: [], scopeId: "TEST"}});
  const inspecting = assert.rejects(access.claudeCodeSetup.inspect(), /disposed/, "pending inspection");
  const signal = await entered.promise;
  const first = host.dispose();
  assert.equal(signal.aborted, true); await inspecting;
  assert.throws(() => host.bindAccess({}), /disposed/);
  await assert.rejects(access.codexSetup.inspect({}), /disposed/, "closed codex handle");
  await assert.rejects(access.claudeCodeSetup.inspect(), /disposed/, "closed claude handle"); assert.equal(first, host.dispose());
  await assert.rejects(first, error => error instanceof AggregateError && error.errors.includes(failure) && error.errors.includes(hostFailure) && error.errors.length === 2);
  assert.equal(hostCloses, 1); assert.equal(journalCloses, 0); assert.equal(featureCloses, 1);
  assert.ok(journalFd !== undefined); fs.writeSync(journalFd, '{"kind":"TEST late evidence"}\n'); fs.fsyncSync(journalFd);
  stopped = true;
  await Promise.all([host.dispose(), host.dispose()]); await host[Symbol.asyncDispose]();
  assert.equal(hostCloses, 2); assert.equal(journalCloses, 1); assert.equal(featureCloses, 2);
  const closedFd = journalFd;
  assert.throws(() => fs.fstatSync(closedFd), /EBADF/);
});

test('real auth helper indeterminate cleanup remains owned through Host disposal', async () => {
  const {execFileSync} = await import('node:child_process');
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', fileURLToPath(new URL('./ordinary-auth-host-disposal.fixture.ts', import.meta.url))], {timeout: 10000, stdio: 'pipe'});
});

test("real Host releases proven ordinary ownership after retry while durable status remains reconciliation", ordinaryHostOwnershipRetry);
for (const boundary of ["retirement", "capture"] as const) {
  test(`real Host pending capture failure does not starve PA owner ${boundary} retries or independent capture disposal`, () => ordinaryHostProviderOwnerRetry(boundary));
}

import {createOrdinaryObservationJournal} from '../../dist/features/ordinary-session-runtime/adapters/ordinary-observation-journal.js';
import {AgentRuntimeHostCreationError} from '../../dist/composition/agent-runtime-host-creation-error.js';

// Regression: closed=true before closeSync made a second close falsely succeed
// and allowed the Host to forget debt; retrying the raw fd can close another file.
test('journal failed close never succeeds, writes or closes a reused descriptor', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'journal-close-TEST-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const journal = createOrdinaryObservationJournal(root);
  const rawClose = fs.closeSync; let calls = 0; let replacement: number | undefined;
  const failure = new Error('TEST uncertain close');
  t.mock.method(fs, 'closeSync', (fd: number) => {
    calls += 1; rawClose(fd);
    replacement = fs.openSync(join(root, 'replacement-TEST'), 'w');
    assert.equal(replacement, fd, 'disposable descriptor was reused');
    throw failure;
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports(); if (replacement !== undefined) {rawClose(replacement);}});
  assert.throws(() => journal.close(), error => error === failure);
  assert.throws(() => journal.close(), error => error === failure);
  assert.throws(() => journal.record({kind: 'TEST late observation'}), error => error === failure);
  assert.equal(calls, 1); assert.ok(replacement !== undefined);
  assert.equal(fs.writeSync(replacement, 'TEST still owned'), 16);
});

// Regression: a fix that rejects all repeats also breaks successful idempotency.
test('journal observed successful close is idempotent and refuses later records', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'journal-success-TEST-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const journal = createOrdinaryObservationJournal(root);
  journal.record({kind: 'TEST observation'});
  const rawClose = fs.closeSync; let calls = 0;
  t.mock.method(fs, 'closeSync', (fd: number) => {calls += 1; rawClose(fd);});
  syncBuiltinESMExports(); t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  journal.close(); journal.close(); assert.equal(calls, 1);
  assert.throws(() => journal.record({kind: 'TEST late observation'}), /ordinary_journal_closed/);
});

for (const boundary of ['file', 'directory', 'directory-close'] as const) {
  // Regression: finally/catch close throws replaced the primary fsync error,
  // lost cleanup uncertainty and could retry a directory descriptor unsafely.
  test(`journal initialization preserves primary failure and retained uncertainty: ${boundary}`, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'journal-init-TEST-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const rawOpen = fs.openSync; const rawClose = fs.closeSync; const rawSync = fs.fsyncSync;
    let file: number | undefined; let directory: number | undefined;
    const primary = new Error('TEST primary fsync'); const uncertain = new Error('TEST uncertain close');
    let fileCloses = 0; let directoryCloses = 0;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const fd = rawOpen(...args); if (String(args[0]).endsWith('.jsonl')) {file = fd;} else {directory = fd;} return fd;
    });
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if ((boundary === 'file' && fd === file) || (boundary === 'directory' && fd === directory)) {throw primary;}
      rawSync(fd);
    });
    t.mock.method(fs, 'closeSync', (fd: number) => {
      if (fd === file) {fileCloses += 1;} else if (fd === directory) {directoryCloses += 1;}
      rawClose(fd);
      if ((boundary === 'file' && fd === file) || (boundary !== 'file' && fd === directory)) {throw uncertain;}
    });
    syncBuiltinESMExports(); t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
    let failure!: AggregateError & {cleanupRecovery: {recover(): Promise<void>}};
    assert.throws(() => createOrdinaryObservationJournal(root), error => {
      assert.ok(error instanceof AggregateError); failure = error as typeof failure;
      assert.equal(error.cause, boundary === 'directory-close' ? uncertain : primary); return true;
    });
    assert.ok(failure.cleanupRecovery); assert.equal(JSON.stringify(failure), '{}');
    const first = failure.cleanupRecovery.recover(); assert.equal(first, failure.cleanupRecovery.recover());
    await assert.rejects(first, /ordinary_journal_cleanup_uncertain/);
    await assert.rejects(failure.cleanupRecovery.recover(), /ordinary_journal_cleanup_uncertain/);
    assert.equal(fileCloses, 1); assert.equal(directoryCloses, boundary === 'file' ? 0 : 1);
  });
}

// Regression: partial creation with journal debt had no surviving cleanup
// holder; an unsafe repeated close could then be reported as recovered.
test('ordinary creation failure retains terminal journal uncertainty', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ordinary-journal-debt-TEST-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const rawClose = fs.closeSync; let calls = 0;
  const primary = new AgentRuntimeHostCreationError('factory_failed', 'run', {moduleId: 'ordinary/security', diagnostics: ['TEST'], cancellationObserved: true, cause: new Error('TEST private primary')});
  let failure!: AgentRuntimeHostCreationError;
  await assert.rejects(createOrdinaryAgentRuntimeHost({execution: {provider: 'codex', executablePath: join(root, 'absent-TEST'), authSourceDirectory: root, privateRoot: root, evidenceRoot: root, sourceDirectory: root, workspaceRoot: root, artifactRoot: root, sourceRevision: 'TEST'}, storage: {pool: {connect: forbidden}}, scope: {tenantId: 'test', projectId: 'TEST'}}, async () => {
    t.mock.method(fs, 'closeSync', (fd: number) => {calls += 1; rawClose(fd); throw new Error('TEST uncertain journal close');});
    syncBuiltinESMExports(); throw primary;
  }), error => {assert.ok(AgentRuntimeHostCreationError.is(error)); failure = error; return true;});
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  assert.ok(failure.cleanupRecovery);
  for (let i = 0; i < 2; i += 1) {await assert.rejects(failure.cleanupRecovery.recover(), /ordinary_host_cleanup_incomplete/);}
  assert.equal(calls, 1); assert.equal(failure.code, primary.code); assert.equal(failure.moduleId, primary.moduleId);
  assert.deepEqual(failure.diagnostics, primary.diagnostics); assert.equal(failure.cancellationObserved, true); assert.equal(failure.cleanupFailed, true);
  assert.doesNotMatch(JSON.stringify(failure), /private primary|uncertain journal|recover|dispose/);
});

// Regression: ordinary and default recovery may each work alone while nested
// cleanup violates dependency ordering or loses a partially acquired owner.
test('ordinary creation cleanup retains partial and nested owners', () => {
  const {status, stdout, stderr, error} = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', fileURLToPath(new URL('./ordinary-creation-cleanup.fixture.ts', import.meta.url))], {encoding: 'utf8', timeout: 10000});
  assert.equal(error, undefined); assert.equal(status, 0, stdout + stderr);
});
