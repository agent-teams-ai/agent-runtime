import assert from "node:assert/strict";
import test from "node:test";

import { composeHostCustodiedAgentRuntimeHost } from "../../dist/composition/host-custodied-agent-runtime-host.js";

const capability = Object.freeze({
  cancel: Object.freeze({ execute: async () => Object.freeze({ status: "not_found" as const }) }),
  observe: Object.freeze({ execute: async () => Object.freeze({ status: "not_found" as const }) }),
  submit: Object.freeze({ execute: async () => Object.freeze({ status: "denied" as const }) }),
});

const dependencies = Object.freeze({
  authorityRevision: "runtime-access-authority:fixture",
  capabilities: Object.freeze({ claudeCodeSetup: Object.freeze({}), codexSetup: Object.freeze({}) }),
  containedTurn: Object.freeze({}),
});

test("deadline-reject during Host disposal preserves contained-turn quarantine and stays idempotent", async () => {
  // Stands in for HostDisposalOrchestrator#rejectAtDeadline winning the race in
  // agent-runtime-host-disposal.ts: host.dispose() is memoized and rejects every time.
  const deadlineError = new Error("Agent Runtime Host disposal deadline elapsed with active calls");
  const hostDisposalRejection = Promise.reject(deadlineError);
  hostDisposalRejection.catch(() => {});
  let hostDisposeCalls = 0;
  let containedTurnDisposeCalls = 0;

  const composed = composeHostCustodiedAgentRuntimeHost(
    dependencies as never,
    (() => Object.freeze({
      feature: capability,
      sealAdmission() {},
      dispose: () => { containedTurnDisposeCalls += 1; },
    })) as never,
    (() => Object.freeze({
      bindAccess: () => { throw new Error("bindAccess is unused in this test"); },
      dispose: () => { hostDisposeCalls += 1; return hostDisposalRejection; },
      [Symbol.asyncDispose]: () => hostDisposalRejection,
    })) as never,
  );

  await assert.rejects(() => composed.dispose(), (error: unknown) => error === deadlineError);
  assert.equal(hostDisposeCalls, 1);
  assert.equal(
    containedTurnDisposeCalls, 0,
    "quarantine: host-custodied-agent-runtime-host.ts's dispose() awaits host.dispose() first, " +
    "so containedTurn.dispose() must never run once that rejects",
  );

  // Repeated dispose after a failed shutdown must not fabricate a different outcome, nor
  // let the contained-turn owner slip past the still-unproven Host disposal on a retry.
  await assert.rejects(() => composed.dispose(), (error: unknown) => error === deadlineError);
  assert.equal(
    hostDisposeCalls, 2,
    "the Host layer's own dispose() is asked again on retry (it is memoized in production; " +
    "this fake proves the composition seam retries it rather than caching a stale outcome)",
  );
  assert.equal(
    containedTurnDisposeCalls, 0,
    "still quarantined: repeated dispose never releases the owner while Host disposal keeps rejecting",
  );
});
