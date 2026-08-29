import assert from "node:assert/strict";
import test from "node:test";

import type {
  ContainedTurnFeatureApi,
  ContainedTurnScope,
  ContainedTurnView,
} from "@agent-teams/agent-execution";

import {
  createAgentRuntimeHost,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";

const unavailable = (): never => {throw new Error("setup dependency must not be reached");};

const setupDependencies = Object.freeze({
  claudeCodeSetup: Object.freeze({
    authorizeClaudeCodeSetupInspection: Object.freeze({ execute: unavailable }),
    discoverClaudeCodeInstallations: Object.freeze({ execute: unavailable }),
    inspectClaudeCodeConfiguration: Object.freeze({ execute: unavailable }),
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux"),
  }),
  codexSetup: Object.freeze({
    authorizeSetupInspection: Object.freeze({ execute: unavailable }),
    discoverCodexInstallations: Object.freeze({ execute: unavailable }),
    inspectCodexConfiguration: Object.freeze({ execute: unavailable }),
    planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
  }),
});

const turnView = (status: ContainedTurnView["status"]): ContainedTurnView => Object.freeze({
  commandId: "command:embedded",
  effectId: "effect:embedded",
  operationId: "operation:embedded",
  output: Object.freeze([]),
  provider: "codex",
  revision: status === "running" ? 3 : 8,
  status,
});

const createContainedTurnDouble = () => {
  let current = turnView("running");
  let releaseCompletion: (() => void) | undefined;
  const completionGate = new Promise<void>(resolve => {releaseCompletion = resolve;});
  const calls = {
    cancel: [] as ContainedTurnScope[],
    observe: [] as ContainedTurnScope[],
    submit: [] as ContainedTurnScope[],
  };
  const feature: ContainedTurnFeatureApi = Object.freeze({
    cancel: Object.freeze({
      async execute(input) {
        calls.cancel.push(input.scope);
        current = turnView("cancelled");
        releaseCompletion?.();
        return { status: "observed", turn: current };
      },
    }),
    observe: Object.freeze({
      async execute(input) {
        calls.observe.push(input.scope);
        return input.operationId === current.operationId
          ? { status: "observed", turn: current }
          : { status: "not_found" };
      },
    }),
    submit: Object.freeze({
      async execute(input, options) {
        calls.submit.push(input.scope);
        options?.onAccepted?.(Object.freeze({
          operationId: current.operationId,
          scope: Object.freeze({ ...input.scope }),
        }));
        await completionGate;
        return { status: "observed", turn: current };
      },
    }),
  });
  return { calls, feature };
};

const trustedScope = Object.freeze({ projectId: "project:embedded", tenantId: "tenant:embedded" });

test("publishes an early scope-bound operation handle and keeps completion under Host custody", async t => {
  const contained = createContainedTurnDouble();
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: contained.feature });
  t.after(() => host.dispose());
  const access = host.bindAccess({ containedTurn: trustedScope });

  const accepted = await access.containedTurn.submit({
    commandId: "command:embedded",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect only the disposable workspace" },
  });
  assert.deepEqual(accepted, { operationId: "operation:embedded", status: "accepted" });
  assert.deepEqual(contained.calls.submit, [trustedScope]);

  const observed = await access.containedTurn.observe("operation:embedded");
  assert.equal(observed.status, "observed");
  assert.deepEqual(contained.calls.observe, [trustedScope]);
  assert.equal(Object.isFrozen(observed), true);
  if (observed.status === "observed") {
    assert.equal(Object.isFrozen(observed.turn), true);
    assert.equal(Object.isFrozen(observed.turn.output), true);
  }

  const cancelled = await access.containedTurn.cancel("operation:embedded");
  assert.equal(cancelled.status, "observed");
  assert.deepEqual(contained.calls.cancel, [trustedScope]);
});

test("Host disposal requests durable cancellation and never exports lifecycle authority", async () => {
  const contained = createContainedTurnDouble();
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: contained.feature });
  const access = host.bindAccess({ containedTurn: trustedScope });
  assert.deepEqual(await access.containedTurn.submit({
    commandId: "command:embedded",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic" },
  }), { operationId: "operation:embedded", status: "accepted" });

  await host.dispose();
  assert.deepEqual(contained.calls.cancel, [trustedScope]);
  await assert.rejects(access.containedTurn.observe("operation:embedded"), /Host is disposed/u);
  assert.equal("dispose" in access, false);
});

test("caller abort detaches only its waiter and never manufactures durable cancellation", async t => {
  let publishAcceptance: (() => void) | undefined;
  let releaseCompletion: (() => void) | undefined;
  const acceptanceGate = new Promise<void>(resolve => {publishAcceptance = resolve;});
  const completionGate = new Promise<void>(resolve => {releaseCompletion = resolve;});
  const calls = { cancel: 0 };
  const feature: ContainedTurnFeatureApi = Object.freeze({
    cancel: Object.freeze({
      async execute() {
        calls.cancel += 1;
        releaseCompletion?.();
        return { status: "observed", turn: turnView("cancelled") };
      },
    }),
    observe: Object.freeze({
      async execute() {return { status: "observed", turn: turnView("running") };},
    }),
    submit: Object.freeze({
      async execute(input, options) {
        await acceptanceGate;
        options?.onAccepted?.({ operationId: "operation:embedded", scope: input.scope });
        await completionGate;
        return { status: "observed", turn: turnView("succeeded") };
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(async () => {
    releaseCompletion?.();
    await host.dispose();
  });
  const controller = new AbortController();
  const submission = host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:abort-waiter",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic" },
  }, { signal: controller.signal });
  controller.abort(new DOMException("caller detached", "AbortError"));
  await assert.rejects(submission, { name: "AbortError" });
  assert.equal(calls.cancel, 0);
  publishAcceptance?.();
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(calls.cancel, 0);
  releaseCompletion?.();
});

test("fails closed when capability or trusted scope is absent", async t => {
  const contained = createContainedTurnDouble();
  const withoutCapability = createAgentRuntimeHost(setupDependencies);
  const withoutScope = createAgentRuntimeHost({ ...setupDependencies, containedTurn: contained.feature });
  t.after(() => Promise.all([withoutCapability.dispose(), withoutScope.dispose()]));

  assert.deepEqual(
    await withoutCapability.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
      commandId: "command:none",
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "synthetic" },
    }),
    { code: "capability_unavailable", status: "unsupported" },
  );
  assert.deepEqual(
    await withoutScope.bindAccess({}).containedTurn.observe("operation:embedded"),
    { code: "capability_unavailable", status: "unsupported" },
  );
  assert.deepEqual(contained.calls, { cancel: [], observe: [], submit: [] });
});
