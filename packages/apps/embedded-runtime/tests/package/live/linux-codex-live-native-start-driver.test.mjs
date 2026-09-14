import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {publicFixture} from '../../live/linux-codex-driver-test-fixture.mjs';
import {createLiveNativeStartCollector} from './linux-codex-live-native-start.ts';

for (const phase of ['install', 'process-input-tmpdir', 'bridge-open']) {
test(`driver persists projected ${phase} before returning unknown with no operation ID`, async t => {
  const f = await publicFixture(t);
  const collector = createLiveNativeStartCollector();
  const diagnostic = {phase, lastCompleted: phase === 'install' ? 'ingress-open' : 'return', failingPhase: phase,
    cutoff: false, errorCode: phase === 'install' ? 'native-start-rejected' : 'unknown'};
  const recipe = collector.wrap({recipe() {return {nativeFiles: {snapshot() {
    return {nativeStart: diagnostic, get credentials() {throw new Error('never read');}};
  }}};}});
  f.live.collectNativeStart = collector.collect;
  f.live.submit = () => collector.settle(async () => {
    recipe({kernel: {custodyId: 'custody:driver'}});
    throw new Error('synthetic private failure');
  });
  const result = await f.driver.run();
  assert.equal(result.observedStatus, 'unknown');
  assert.equal(result.operationId, undefined);
  assert.equal(result.cleanup, 'pending');
  const directory = join(f.root, 'evidence');
  const records = readdirSync(directory).filter(name => name.endsWith('-native-start.json'));
  assert.equal(records.length, 1);
  const evidence = JSON.parse(readFileSync(join(directory, records[0]), 'utf8'));
  assert.deepEqual(evidence.value, {custodyId: 'custody:driver', nativeStart: diagnostic});
});
}
