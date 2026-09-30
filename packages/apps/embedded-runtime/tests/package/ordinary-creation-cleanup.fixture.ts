import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as securityComposition from '@agent-teams/runtime-security/composition';
import * as paComposition from '@agent-teams/provider-access/composition';

// Real owners and their public disposal/migration behavior, with bounded fault
// injection at the existing owner factory import seam. No provider executes.
let securityOwner: ReturnType<typeof securityComposition.createOrdinarySecurityOwner>;
let securityDisposals = 0; let paDisposals = 0; let securityReady = false; let paReady = false;
let partial = false;
const migrationEntered = Promise.withResolvers<void>(); const migrationFinish = Promise.withResolvers<void>();
const primary = new Error('TEST partial migration primary');
test.mock.module('@agent-teams/runtime-security/composition', {namedExports: {...securityComposition,
  createOrdinarySecurityOwner: (...args: Parameters<typeof securityComposition.createOrdinarySecurityOwner>) => {
    securityOwner = securityComposition.createOrdinarySecurityOwner(...args);
    return {...securityOwner, async migrate() {
      if (partial) {migrationEntered.resolve(); await migrationFinish.promise; throw primary;}
      await securityOwner.migrate();
    }, async dispose() {
      securityDisposals += 1; if (!securityReady) {throw new Error('TEST security cleanup transient');}
      await securityOwner.dispose();
    }};
  },
}});
test.mock.module('@agent-teams/provider-access/composition', {namedExports: {...paComposition,
  createPostgresOrdinaryProviderAccessOwner: (...args: Parameters<typeof paComposition.createPostgresOrdinaryProviderAccessOwner>) => {
    const owner = paComposition.createPostgresOrdinaryProviderAccessOwner(...args);
    return {...owner, async dispose() {
      paDisposals += 1; if (!paReady) {throw new Error('TEST PA cleanup transient');} await owner.dispose();
    }};
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
  t.mock.method(fs, 'closeSync', (fd: number) => {if (fd === journalFd) {journalCloses += 1;} rawClose(fd);});
  syncBuiltinESMExports(); t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  const options = {execution: {provider: 'codex' as const, executablePath: join(root, 'absent-TEST'), authSourceDirectory: root, privateRoot: root, evidenceRoot: root, sourceDirectory: root, workspaceRoot: root, artifactRoot: root, sourceRevision: 'TEST'}, storage: {pool}, scope: {tenantId: 'test', projectId: 'TEST'}};
  return {options, assertBorrowed() {assert.equal(ended, 0); assert.equal(connected, released);},
    assertJournalOpen() {assert.equal(journalCloses, 0); assert.ok(journalFd !== undefined); fs.writeSync(journalFd, '{"kind":"TEST retained"}\n'); fs.fsyncSync(journalFd);},
    assertJournalClosed() {assert.equal(journalCloses, 1); assert.ok(journalFd !== undefined); assert.throws(() => fs.fstatSync(journalFd), /EBADF/);},
  };
}

// Regression: an owner acquired before migrate awaits was lost on rejection;
// causes alone cannot retry, and a hostile signal accessor must not lose custody.
test('partial ordinary creation registers owner before await and retains failed cleanup', async t => {
  partial = true; securityReady = false; securityDisposals = 0;
  const f = await fixture(t); let failure!: InstanceType<typeof AgentRuntimeHostCreationError>;
  const controller = new AbortController();
  Object.defineProperty(controller.signal, 'aborted', {get() {throw new Error('TEST private cancellation metadata');}});
  const pending = createOrdinaryAgentRuntimeHost({...f.options, signal: controller.signal}, async (_signal, ordinary) => {
    await ordinary.factories.security(); assert.fail('migration must reject');
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
  partial = false; securityReady = true; paReady = true; securityDisposals = 0; paDisposals = 0;
  const f = await fixture(t);
  let featureReady = false; let featureDisposals = 0; let hostDisposals = 0;
  const recoveryEntered = Promise.withResolvers<void>(); const recoveryFinish = Promise.withResolvers<void>();
  const controller = new AbortController(); let failure!: InstanceType<typeof AgentRuntimeHostCreationError>;
  await assert.rejects(createOrdinaryAgentRuntimeHost({...f.options, signal: controller.signal}, (signal, ordinary) =>
    createRuntimeSetupAttempt({signal}, createRuntimeSetupFactories, {completeRoot: async () => {
      controller.abort(); throw new Error('TEST nested primary');
    }}, {...ordinary, decorateHost(host, feature) {
      return ordinary.decorateHost({...host, async dispose() {hostDisposals += 1; await host.dispose();}}, {...feature, async dispose() {
        featureDisposals += 1; f.assertJournalOpen(); await securityOwner.migrate();
        if (featureDisposals === 2) {recoveryEntered.resolve(); await recoveryFinish.promise;}
        if (!featureReady) {throw new Error('TEST feature closure unproven');}
        await feature.dispose();
      }});
    }})), error => {
      f.assertJournalOpen(); assert.equal(securityDisposals, 0); assert.equal(paDisposals, 0);
      assert.ok(AgentRuntimeHostCreationError.is(error)); failure = error; return true;
    });
  assert.equal(failure.code, 'factory_failed'); assert.equal(failure.cancellationObserved, true);
  assert.equal(failure.moduleId, 'agent-runtime/runtime-host'); assert.equal(failure.cleanupFailed, true);
  assert.equal(hostDisposals, 1); assert.equal(featureDisposals, 1);
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
  assert.equal(featureDisposals, 3); assert.equal(paDisposals, 1); assert.equal(securityDisposals, 0); f.assertJournalOpen();
  paReady = true;
  await failure.cleanupRecovery.recover(); await failure.cleanupRecovery.recover();
  assert.equal(hostDisposals, 1); assert.equal(featureDisposals, 3);
  assert.equal(paDisposals, 2); assert.equal(securityDisposals, 1); f.assertJournalClosed(); f.assertBorrowed();
  assert.equal(failure.cleanupFailed, true);
  assert.doesNotMatch(JSON.stringify(failure), /nested primary|feature closure|recover|dispose/);
});
