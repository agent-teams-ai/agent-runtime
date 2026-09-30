import assert from 'node:assert/strict';
import {AgentRuntimeHostCreationError} from '../../dist/composition/agent-runtime-host-creation-error.js';
import {createRuntimeSetupAttempt} from '../../dist/composition/default-agent-runtime-host.js';
import {createRuntimeSetupFactories} from '../../dist/composition/runtime-setup-assembly.js';

export async function failedCreationRecovery() {
  let attempts = 0; let earlierSuccesses = 0; let released = false;
  let ready = false;
  const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  let failure!: AgentRuntimeHostCreationError;
  await assert.rejects(createRuntimeSetupAttempt(undefined, platform => {
    const factories = createRuntimeSetupFactories(platform);
    return {...factories, host: dependencies => {
      const host = factories.host(dependencies);
      return {...host, dispose: async () => {
        attempts += 1;
        if (!released) {await host.dispose(); released = true; earlierSuccesses += 1;}
        if (attempts === 2) {entered.resolve(); await finish.promise;}
        if (!ready) {throw new Error("TEST cleanup private cause");}
      }};
    }};
  }, {completeRoot: async () => {throw new Error("TEST primary private cause");}}), error => {
    assert.ok(error instanceof AgentRuntimeHostCreationError); failure = error; return true;
  });
  assert.equal(failure.code, "factory_failed"); assert.equal(failure.phase, "run");
  assert.equal(failure.moduleId, "agent-runtime/runtime-host"); assert.equal(failure.cleanupFailed, true);
  const projection = JSON.stringify(failure);
  assert.doesNotMatch(projection, /private cause|recover|dispose|bindAccess/);
  assert.equal(Object.hasOwn(failure, "cause"), false);
  assert.ok(failure.cleanupRecovery);
  assert.deepEqual(Object.keys(failure.cleanupRecovery), ["recover"]);
  const first = failure.cleanupRecovery.recover(); const joined = failure.cleanupRecovery.recover();
  assert.equal(first, joined); await entered.promise; assert.equal(attempts, 2);
  const rejected = assert.rejects(first, /TEST cleanup private cause/);
  finish.resolve(); await rejected;
  assert.equal(earlierSuccesses, 1);
  ready = true;
  await failure.cleanupRecovery.recover(); await failure.cleanupRecovery.recover();
  assert.equal(attempts, 3); assert.equal(earlierSuccesses, 1);
  assert.equal(JSON.stringify(failure), projection, "cleanupFailed remains a historical fact");
}

// A conforming owner can preserve terminal release uncertainty indefinitely.
// Recovery must keep rejecting rather than convert that observation to success.
export async function terminalCreationCleanupUncertainty() {
  const uncertainty = new Error("TEST terminal release uncertainty");
  let releases = 0; let disposal: Promise<void> | undefined;
  let failure!: AgentRuntimeHostCreationError;
  await assert.rejects(createRuntimeSetupAttempt(undefined, platform => {
    const factories = createRuntimeSetupFactories(platform);
    return {...factories, host: dependencies => {
      const host = factories.host(dependencies);
      return {...host, dispose: () => disposal ??= Promise.resolve().then(async () => {
        await host.dispose(); releases += 1; throw uncertainty;
      })};
    }};
  }, {completeRoot: async () => {throw new Error("TEST original construction cause");}}), error => {
    assert.ok(error instanceof AgentRuntimeHostCreationError); failure = error; return true;
  });
  assert.equal(failure.cleanupFailed, true); assert.ok(failure.cleanupRecovery);
  const projection = JSON.stringify(failure);
  const first = failure.cleanupRecovery.recover(); const joined = failure.cleanupRecovery.recover();
  assert.equal(first, joined);
  await assert.rejects(first, error => error === uncertainty);
  await assert.rejects(failure.cleanupRecovery.recover(), error => error === uncertainty);
  assert.equal(releases, 1, "terminal uncertainty cannot repeat physical release");
  assert.equal(JSON.stringify(failure), projection, "failed release cannot falsely settle historical debt");
}
