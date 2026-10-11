import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as securityComposition from '@agent-teams/runtime-security/composition';
import * as paComposition from '@agent-teams/provider-access/composition';
import * as executionComposition from '@agent-teams/agent-execution/composition';

// Real owners and their public disposal/migration behavior, with bounded fault
// injection at the existing owner factory import seam. No provider executes.
let securityOwner: ReturnType<typeof securityComposition.createOrdinarySecurityOwner>;
let securityDisposals = 0; let paDisposals = 0; let securityReady = false; let paReady = false;
let partial = false;
// `constructed` records owner creation order; `events` records releases (journal close included).
const constructed: string[] = []; const events: string[] = [];
let featureReady = true; let featureDisposals = 0; let featureHook: (() => Promise<void>) | undefined;
const reset = () => {constructed.length = 0; events.length = 0; featureReady = true; featureDisposals = 0; featureHook = undefined;};
const migrationEntered = Promise.withResolvers<void>(); const migrationFinish = Promise.withResolvers<void>();
const primary = new Error('TEST partial migration primary');
test.mock.module('@agent-teams/runtime-security/composition', {namedExports: {...securityComposition,
  createOrdinarySecurityOwner: (...args: Parameters<typeof securityComposition.createOrdinarySecurityOwner>) => {
    securityOwner = securityComposition.createOrdinarySecurityOwner(...args); constructed.push('security');
    return {...securityOwner, async migrate() {
      if (partial) {migrationEntered.resolve(); await migrationFinish.promise; throw primary;}
      await securityOwner.migrate();
    }, async dispose() {
      securityDisposals += 1; if (!securityReady) {throw new Error('TEST security cleanup transient');}
      await securityOwner.dispose(); events.push('security');
    }};
  },
}});
test.mock.module('@agent-teams/provider-access/composition', {namedExports: {...paComposition,
  createPostgresOrdinaryProviderAccessOwner: (...args: Parameters<typeof paComposition.createPostgresOrdinaryProviderAccessOwner>) => {
    const owner = paComposition.createPostgresOrdinaryProviderAccessOwner(...args); constructed.push('provider-access');
    return {...owner, async dispose() {
      paDisposals += 1; if (!paReady) {throw new Error('TEST PA cleanup transient');} await owner.dispose(); events.push('provider-access');
    }};
  },
}});
test.mock.module('@agent-teams/agent-execution/composition', {namedExports: {...executionComposition,
  createOrdinaryCodexAdapter: (...args: Parameters<typeof executionComposition.createOrdinaryCodexAdapter>) => {
    const codex = executionComposition.createOrdinaryCodexAdapter(...args); constructed.push('codex');
    return Object.freeze({...codex, dispose() {codex.dispose(); events.push('codex');}});
  },
  // The turn feature is closed by the Host drain; it is the only place that fails or blocks that drain.
  createOrdinaryTurnFeature: (...args: Parameters<typeof executionComposition.createOrdinaryTurnFeature>) => {
    const feature = executionComposition.createOrdinaryTurnFeature(...args);
    return Object.freeze({...feature, async dispose() {
      featureDisposals += 1; events.push('feature'); await featureHook?.();
      if (!featureReady) {throw new Error('TEST feature closure unproven');}
      await feature.dispose();
    }});
  },
}});
const {createOrdinaryAgentRuntimeHost} = await import('../../dist/composition/ordinary-agent-runtime-host.js');
const {createRuntimeSetupAttempt} = await import('../../dist/composition/default-agent-runtime-host.js');
const {createRuntimeSetupFactories} = await import('../../dist/composition/runtime-setup-assembly.js');
const {AgentRuntimeHostCreationError} = await import('../../dist/composition/agent-runtime-host-creation-error.js');

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ordinary-create-TEST-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  let ended = 0; let connected = 0; let released = 0;
  const pool = {async end() {ended += 1;}, async query() {return {rows: [], rowCount: 0};}, async connect() {
    connected += 1;
    return {async query() {return {rows: [], rowCount: 0};}, release() {released += 1;}};
  }};
  let journalFd: number | undefined; let journalCloses = 0;
  const rawOpen = fs.openSync; const rawClose = fs.closeSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = rawOpen(...args); if (String(args[0]).endsWith('.jsonl')) {journalFd = fd;} return fd;
  });
  t.mock.method(fs, 'closeSync', (fd: number) => {if (fd === journalFd) {journalCloses += 1; events.push('journal');} rawClose(fd);});
  syncBuiltinESMExports(); t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const options = {execution: {provider: 'codex' as const, executablePath: join(root, 'absent-TEST'), authSourceDirectory: root, privateRoot: root, evidenceRoot: root, sourceDirectory: root, workspaceRoot: root, artifactRoot: root, sourceRevision: 'TEST'}, storage: {pool}, scope: {tenantId: 'test', projectId: 'TEST'}};
  return {options, assertBorrowed() {assert.equal(ended, 0); assert.equal(connected, released);},
    assertJournalOpen() {assert.equal(journalCloses, 0); assert.ok(journalFd !== undefined); fs.writeSync(journalFd, '{"kind":"TEST retained"}\n'); fs.fsyncSync(journalFd);},
    assertJournalClosed() {assert.equal(journalCloses, 1); const fd = journalFd; assert.ok(fd !== undefined); assert.throws(() => fs.fstatSync(fd), /EBADF/);},
  };
}

// Regression: an owner acquired before migrate awaits was lost on rejection;
// causes alone cannot retry, and a hostile signal accessor must not lose custody.
test('partial ordinary creation registers owner before await and retains failed cleanup', async t => {
  partial = true; securityReady = false; securityDisposals = 0; reset();
  const f = await fixture(t); let failure!: InstanceType<typeof AgentRuntimeHostCreationError>;
  const controller = new AbortController();
  Object.defineProperty(controller.signal, 'aborted', {get() {throw new Error('TEST private cancellation metadata');}});
  const pending = createOrdinaryAgentRuntimeHost({...f.options, signal: controller.signal}, async (_signal, ordinary) => {
    await ordinary.factories.security(ordinary.owners); assert.fail('migration must reject');
  });
  const rejection = assert.rejects(pending, error => {
    assert.ok(AgentRuntimeHostCreationError.is(error)); failure = error; return true;
  });
  await migrationEntered.promise; assert.equal(securityDisposals, 0); f.assertJournalOpen();
  migrationFinish.resolve(); await rejection;
  assert.equal(securityDisposals, 1); assert.equal(failure.cleanupFailed, true); f.assertJournalOpen();
  assert.equal(failure.cancellationObserved, false);
  assert.ok(failure.cleanupRecovery); await assert.rejects(failure.cleanupRecovery.recover());
  assert.equal(securityDisposals, 2); f.assertJournalOpen();
  securityReady = true; await failure.cleanupRecovery.recover(); await failure.cleanupRecovery.recover();
  assert.equal(securityDisposals, 3); f.assertJournalClosed(); f.assertBorrowed();
  assert.doesNotMatch(JSON.stringify(failure), /partial migration primary|cleanup transient|recover/);
});

// Regression: the outer catch released the journal/security/PA even when inner
// decorated Host disposal failed. Retaining just one recovery also skips debt.
test('nested failed creation recovers inner feature before outer owners and skips successes', async t => {
  partial = false; securityReady = true; paReady = true; securityDisposals = 0; paDisposals = 0; reset();
  const f = await fixture(t);
  featureReady = false;
  const recoveryEntered = Promise.withResolvers<void>(); const recoveryFinish = Promise.withResolvers<void>();
  featureHook = async () => {
    f.assertJournalOpen(); await securityOwner.migrate();
    if (featureDisposals === 2) {recoveryEntered.resolve(); await recoveryFinish.promise;}
  };
  const controller = new AbortController(); let failure!: InstanceType<typeof AgentRuntimeHostCreationError>;
  await assert.rejects(createOrdinaryAgentRuntimeHost({...f.options, signal: controller.signal}, (signal, ordinary) =>
    createRuntimeSetupAttempt(signal === undefined ? {} : {signal}, createRuntimeSetupFactories, {completeRoot: async () => {
      controller.abort(); throw new Error('TEST nested primary');
    }}, ordinary)), error => {
      f.assertJournalOpen(); assert.equal(securityDisposals, 0); assert.equal(paDisposals, 0);
      assert.ok(AgentRuntimeHostCreationError.is(error)); failure = error; return true;
    });
  assert.equal(failure.code, 'factory_failed'); assert.equal(failure.cancellationObserved, true);
  assert.equal(failure.moduleId, 'agent-runtime/runtime-host'); assert.equal(failure.cleanupFailed, true);
  assert.equal(featureDisposals, 1);
  assert.equal(securityDisposals, 0); assert.equal(paDisposals, 0); f.assertJournalOpen();
  assert.ok(failure.cleanupRecovery);
  const first = failure.cleanupRecovery.recover(); assert.equal(first, failure.cleanupRecovery.recover());
  const rejected = assert.rejects(first, /ordinary_host_disposal_incomplete/);
  await recoveryEntered.promise;
  assert.equal(securityDisposals, 0); assert.equal(paDisposals, 0); f.assertJournalOpen();
  recoveryFinish.resolve(); await rejected;
  assert.equal(securityDisposals, 0); assert.equal(paDisposals, 0); f.assertJournalOpen();
  featureReady = true; paReady = false;
  await assert.rejects(failure.cleanupRecovery.recover(), /ordinary_host_disposal_incomplete/);
  // Owners continue past the failed Provider Access release (resources semantics).
  assert.equal(featureDisposals, 3); assert.equal(paDisposals, 1); assert.equal(securityDisposals, 1); f.assertJournalOpen();
  paReady = true;
  await failure.cleanupRecovery.recover(); await failure.cleanupRecovery.recover();
  assert.equal(featureDisposals, 3);
  assert.equal(paDisposals, 2); assert.equal(securityDisposals, 1); f.assertJournalClosed(); f.assertBorrowed();
  assert.equal(failure.cleanupFailed, true);
  assert.doesNotMatch(JSON.stringify(failure), /nested primary|feature closure|recover|dispose/);
});

// Real Assembly path with the public constructor: ordinary options over real directories and an in-memory pool.
async function publicHost(t: test.TestContext) {
  const f = await fixture(t);
  const base = f.options.execution.evidenceRoot;
  const dirs = {auth: join(base, 'auth'), private: join(base, 'private'), evidence: join(base, 'evidence'), source: join(base, 'source'), workspace: join(base, 'workspace'), artifact: join(base, 'artifact')};
  for (const path of Object.values(dirs)) {await mkdir(path, {mode: 0o700});}
  const execution = {...f.options.execution, authSourceDirectory: dirs.auth, privateRoot: dirs.private, evidenceRoot: dirs.evidence, sourceDirectory: dirs.source, workspaceRoot: dirs.workspace, artifactRoot: dirs.artifact};
  const {createAgentRuntimeHost} = await import('../../dist/composition.js');
  return {f, host: await createAgentRuntimeHost({...f.options, execution})};
}

test('ordinary Host drains first, releases owners in reverse construction order and closes the journal last', async t => {
  partial = false; securityReady = true; paReady = true; securityDisposals = 0; paDisposals = 0; reset();
  const {f, host} = await publicHost(t);
  assert.deepEqual(constructed.toSorted(), ['codex', 'provider-access', 'security']);
  assert.deepEqual(events, []);
  await host.dispose();
  assert.deepEqual(events, ['feature', ...constructed.toReversed(), 'journal']);
  f.assertJournalClosed(); f.assertBorrowed();
});

test('a failed Provider Access release does not block the other owners and keeps the journal until retry', async t => {
  partial = false; securityReady = true; paReady = false; securityDisposals = 0; paDisposals = 0; reset();
  const {f, host} = await publicHost(t);
  await assert.rejects(host.dispose(), /ordinary_host_disposal_incomplete/);
  assert.equal(paDisposals, 1); assert.equal(securityDisposals, 1);
  assert.ok(events.includes('codex')); assert.equal(featureDisposals, 1); f.assertJournalOpen();
  paReady = true;
  await Promise.all([host.dispose(), host.dispose()]); await host.dispose();
  assert.equal(paDisposals, 2); assert.equal(securityDisposals, 1); assert.equal(featureDisposals, 1);
  f.assertJournalClosed(); f.assertBorrowed();
});
