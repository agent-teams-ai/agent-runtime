import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRuntimeHostDisposalIncompleteError,
  ContainedTurnOwnerContractError,
  createAgentRuntimeHost,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";
import type { ContainedTurnCapabilityBundle } from "../dist/composition.js";

type ContainedTurnScope = Readonly<{ projectId: string; tenantId: string }>;
type ContainedTurnStatus = "cancelled" | "running" | "succeeded";

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

const trustedScope = Object.freeze({
  projectId: "project:embedded",
  tenantId: "tenant:embedded",
});

const turnView = (status: ContainedTurnStatus) => Object.freeze({
  ...(status === "cancelled" || status === "succeeded"
    ? { artifactManifestRef: "artifact:embedded", resultRef: "result:embedded" }
    : {}),
  commandId: "command:embedded",
  effectId: "effect:embedded",
  operationId: "operation:embedded",
  output: Object.freeze([]),
  provider: "codex",
  revision: 1,
  status,
});

test("Host retains completion identity when malformed terminal fields hide acceptance", async () => {
  let releaseCancellation!: () => void;
  const cancellationGate = new Promise<void>(resolve => {releaseCancellation = resolve;});
  let cancellationStarted!: () => void;
  const started = new Promise<void>(resolve => {cancellationStarted = resolve;});
  const cancellationScopes: ContainedTurnScope[] = [];
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute(input) {
        cancellationScopes.push(input.scope);
        cancellationStarted();
        await cancellationGate;
        return { status: "observed", turn: turnView("cancelled") } as const;
      },
    }),
    observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    submit: Object.freeze({
      async execute() {
        return {
          status: "observed",
          turn: {
            ...turnView("succeeded"),
            get artifactManifestRef(): never {
              throw new Error("owner-only malformed terminal field");
            },
          },
        } as never;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });

  await assert.rejects(host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:malformed-terminal",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic" },
  }), error => error instanceof ContainedTurnOwnerContractError &&
    error.code === "malformed_owner_outcome" &&
    !JSON.stringify(error).includes("owner-only malformed terminal field"));
  const disposal = host.dispose();
  let disposalSettled = false;
  void disposal.finally(() => {disposalSettled = true;});
  await started;
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(disposalSettled, false);
  assert.deepEqual(cancellationScopes, [trustedScope]);
  assert.notEqual(cancellationScopes[0], trustedScope);
  assert.equal(Object.isFrozen(cancellationScopes[0]), true);

  releaseCancellation();
  await disposal;
});

test("Host retains malformed acceptance identity across rejected and non-observed completion", async () => {
  for (const completionKind of ["rejected", "denied"] as const) {
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>(resolve => {releaseCancellation = resolve;});
    let cancellationStarted!: () => void;
    const started = new Promise<void>(resolve => {cancellationStarted = resolve;});
    const cancellationScopes: ContainedTurnScope[] = [];
    const feature: ContainedTurnCapabilityBundle = Object.freeze({
      cancel: Object.freeze({
        async execute(input) {
          cancellationScopes.push(input.scope);
          cancellationStarted();
          await cancellationGate;
          return { status: "observed", turn: turnView("cancelled") } as const;
        },
      }),
      observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
      submit: Object.freeze({
        async execute(_input, options) {
          options?.onAccepted?.({
            operationId: "operation:embedded",
            scope: Object.create(null, {
              projectId: { get() {throw new Error("owner-only hostile acceptance scope");} },
            }) as ContainedTurnScope,
          });
          if (completionKind === "rejected") {
            throw new Error("owner-only rejected submit completion");
          }
          return { status: "denied" } as const;
        },
      }),
    });
    const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });

    await assert.rejects(host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
      commandId: `command:malformed-acceptance-${completionKind}`,
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "synthetic" },
    }), error => error instanceof ContainedTurnOwnerContractError &&
      error.code === "malformed_owner_outcome" &&
      !JSON.stringify(error).includes("owner-only"));
    const disposal = host.dispose();
    let disposalSettled = false;
    void disposal.finally(() => {disposalSettled = true;});
    await started;
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(disposalSettled, false);
    assert.deepEqual(cancellationScopes, [trustedScope]);

    releaseCancellation();
    await disposal;
  }
});

test("caller-aborted cancel waiter does not poison later shutdown cancellation", async () => {
  for (const shutdownOutcome of ["running", "cancelled"] as const) {
    let cancellationCalls = 0;
    const feature: ContainedTurnCapabilityBundle = Object.freeze({
      cancel: Object.freeze({
        execute(input, options) {
          cancellationCalls += 1;
          if (cancellationCalls === 1) {
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                reject(new Error("owner-only caller abort rejection"));
              }, { once: true });
            });
          }
          return Promise.resolve({
            status: "observed",
            turn: { ...turnView(shutdownOutcome), operationId: input.operationId },
          } as const);
        },
      }),
      observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
      submit: Object.freeze({
        async execute(input, options) {
          options?.onAccepted?.({ operationId: "operation:embedded", scope: input.scope });
          return { status: "observed", turn: turnView("running") } as const;
        },
      }),
    });
    const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
    const access = host.bindAccess({ containedTurn: trustedScope }).containedTurn;
    assert.deepEqual(await access.submit({
      commandId: `command:abort-cancel-${shutdownOutcome}`,
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "synthetic" },
    }), { operationId: "operation:embedded", status: "accepted" });
    const controller = new AbortController();
    const cancellation = access.cancel("operation:embedded", { signal: controller.signal });
    controller.abort(new DOMException("caller detached", "AbortError"));
    await assert.rejects(cancellation, { name: "AbortError" });

    const disposal = host.dispose();
    if (shutdownOutcome === "cancelled") {
      await disposal;
    } else {
      const error = await disposal.catch(caught => caught);
      assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
      assert.deepEqual(error.containedTurns, [{
        operationId: "operation:embedded",
        status: "running",
      }]);
    }
    assert.equal(cancellationCalls, 2);
  }
});
