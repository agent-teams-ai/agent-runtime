import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createOrdinaryObservationJournal} from '../../../dist/features/ordinary-session-runtime/adapters/ordinary-observation-journal.js';

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

