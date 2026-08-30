// oxlint-disable max-lines -- focused lifecycle counterexamples remain in one Embedded access suite.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRuntimeHostDisposalIncompleteError,
  AgentRuntimeHostLifecycleError,
  ContainedTurnOwnerContractError,
  createAgentRuntimeHost,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";
import type { ContainedTurnCapabilityBundle } from "../dist/composition.js";

type ContainedTurnScope = Readonly<{ projectId: string; tenantId: string }>;
type ContainedTurnStatus = "accepted" | "cancelled" | "failed" | "reconcile_required" | "running" | "succeeded";

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

const turnView = (status: ContainedTurnStatus) => Object.freeze({
  commandId: "command:embedded",
  effectId: "effect:embedded",
  operationId: "operation:embedded",
  output: Object.freeze([]),
  provider: "codex",
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
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
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

type DisposalCancellationOutcome = ContainedTurnStatus | "mismatch" | "not_found" | "reject";

const createDisposalDouble = (
  completionStatus: ContainedTurnStatus,
  cancellationOutcome: DisposalCancellationOutcome,
) => {
  let cancellationCalls = 0;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {
        cancellationCalls += 1;
        if (cancellationOutcome === "reject") {
          throw new Error("owner-only cancellation failure detail");
        }
        if (cancellationOutcome === "mismatch") {
          return {
            status: "observed" as const,
            turn: Object.freeze({
              ...turnView("succeeded"),
              operationId: "operation:crossed",
            }),
          };
        }
        return cancellationOutcome === "not_found"
          ? { status: "not_found" as const }
          : { status: "observed" as const, turn: turnView(cancellationOutcome) };
      },
    }),
    observe: Object.freeze({
      async execute() {
        return { status: "observed", turn: turnView(completionStatus) } as const;
      },
    }),
    submit: Object.freeze({
      async execute(input, options) {
        options?.onAccepted?.(Object.freeze({
          operationId: "operation:embedded",
          scope: Object.freeze({ ...input.scope }),
        }));
        return { status: "observed", turn: turnView(completionStatus) } as const;
      },
    }),
  });
  return {
    cancellationCalls: () => cancellationCalls,
    feature,
  };
};

const submitDisposalTurn = async (
  feature: ContainedTurnCapabilityBundle,
) => {
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const accepted = await host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:embedded",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic disposal" },
  });
  assert.deepEqual(accepted, { operationId: "operation:embedded", status: "accepted" });
  await new Promise<void>(resolve => {setImmediate(resolve);});
  return host;
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
  assert.notEqual(contained.calls.submit[0], trustedScope);
  assert.equal(Object.isFrozen(contained.calls.submit[0]), true);

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

test("maps complete observations to an Embedded Runtime-owned deeply detached DTO", async t => {
  const ownerOnlyNestedSentinel = { secret: "owner-only-nested-sentinel" };
  const ownerOutput = [{
    cursor: 7,
    kind: "assistant" as const,
    ownerOnly: ownerOnlyNestedSentinel,
    text: "owner output",
  }];
  const ownerTurn = {
    artifactManifestRef: "artifact:manifest",
    commandId: "command:detached",
    effectId: "effect:detached",
    operationId: "operation:detached",
    output: ownerOutput,
    provider: "Vendor / Model β",
    resultRef: "result:detached",
    status: "succeeded" as const,
  };
  let receivedScope: ContainedTurnScope | undefined;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute(input) {
        receivedScope = input.scope;
        return { status: "observed", turn: ownerTurn };
      },
    }),
    observe: Object.freeze({
      async execute(input) {
        receivedScope = input.scope;
        return { status: "observed", turn: ownerTurn };
      },
    }),
    submit: Object.freeze({
      async execute() {return { status: "observed", turn: ownerTurn };},
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(() => host.dispose());
  const callerScope = { projectId: "project:detached", tenantId: "tenant:detached" };
  const access = host.bindAccess({ containedTurn: callerScope });
  callerScope.projectId = "project:mutated-after-bind";

  const observed = await access.containedTurn.observe(ownerTurn.operationId);
  assert.deepEqual(observed, {
    status: "observed",
    turn: {
      artifactManifestRef: "artifact:manifest",
      commandId: "command:detached",
      effectId: "effect:detached",
      operationId: "operation:detached",
      output: [{ cursor: 7, kind: "assistant", text: "owner output" }],
      provider: "Vendor / Model β",
      resultRef: "result:detached",
      status: "succeeded",
    },
  });
  assert.deepEqual(receivedScope, {
    projectId: "project:detached",
    tenantId: "tenant:detached",
  });
  assert.notEqual(receivedScope, callerScope);
  assert.equal(Object.isFrozen(receivedScope), true);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(observed.status, "observed");
  if (observed.status !== "observed") {
    return;
  }
  assert.deepEqual(Object.keys(observed.turn).toSorted(), [
    "artifactManifestRef",
    "commandId",
    "effectId",
    "operationId",
    "output",
    "provider",
    "resultRef",
    "status",
  ]);
  assert.notEqual(observed.turn, ownerTurn);
  assert.notEqual(observed.turn.output, ownerOutput);
  assert.notEqual(observed.turn.output[0], ownerOutput[0]);
  assert.deepEqual(Object.keys(observed.turn.output[0]!).toSorted(), ["cursor", "kind", "text"]);
  assert.equal("ownerOnly" in observed.turn.output[0]!, false);
  assert.equal(JSON.stringify(observed).includes(ownerOnlyNestedSentinel.secret), false);
  assert.equal(Object.isFrozen(observed.turn), true);
  assert.equal(Object.isFrozen(observed.turn.output), true);
  assert.equal(Object.isFrozen(observed.turn.output[0]), true);
  assert.throws(() => {
    (observed.turn.output as { text: string }[])[0]!.text = "caller mutation";
  }, TypeError);

  ownerOutput[0]!.text = "owner mutation";
  ownerOutput.push({ cursor: 8, kind: "progress", text: "later owner output" });
  assert.deepEqual(observed.turn.output, [{
    cursor: 7,
    kind: "assistant",
    text: "owner output",
  }]);

  const cancelled = await access.containedTurn.cancel(ownerTurn.operationId);
  assert.deepEqual(cancelled, {
    status: "observed",
    turn: {
      artifactManifestRef: "artifact:manifest",
      commandId: "command:detached",
      effectId: "effect:detached",
      operationId: "operation:detached",
      output: [
        { cursor: 7, kind: "assistant", text: "owner mutation" },
        { cursor: 8, kind: "progress", text: "later owner output" },
      ],
      provider: "Vendor / Model β",
      resultRef: "result:detached",
      status: "succeeded",
    },
  });
  assert.notEqual(cancelled.status === "observed" && cancelled.turn, ownerTurn);
});

test("snapshots accessor-backed owner observations exactly once before validation", async t => {
  const reads = {
    artifactManifestRef: 0, commandId: 0, cursor: 0, effectId: 0, kind: 0,
    operationId: 0, outcomeStatus: 0, output: 0, outputIndex: 0, outputLength: 0,
    provider: 0, resultRef: 0, text: 0, turn: 0, turnStatus: 0,
  };
  const ownerOnlySentinel = { secret: "mutable-owner-sentinel" };
  const chunk = {
    get cursor(): unknown {reads.cursor += 1; return reads.cursor === 1 ? 4 : ownerOnlySentinel;},
    get kind(): unknown {reads.kind += 1; return reads.kind === 1 ? "assistant" : ownerOnlySentinel;},
    get text(): unknown {reads.text += 1; return reads.text === 1 ? "first output" : ownerOnlySentinel;},
  };
  const ownerOutput = new Proxy([chunk], {
    get(target, property, receiver) {
      if (property === "length") {
        reads.outputLength += 1;
      } else if (property === "0") {
        reads.outputIndex += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const ownerTurn = {
    get artifactManifestRef(): unknown {reads.artifactManifestRef += 1;
      return reads.artifactManifestRef === 1 ? "artifact:first" : ownerOnlySentinel;},
    get commandId(): unknown {
      reads.commandId += 1;
      return reads.commandId === 1 ? "command:first" : ownerOnlySentinel;
    },
    get effectId(): unknown {reads.effectId += 1;
      return reads.effectId === 1 ? "effect:first" : ownerOnlySentinel;},
    get operationId(): unknown {
      reads.operationId += 1;
      return reads.operationId === 1 ? "operation:first" : "operation:crossed";
    },
    get output(): unknown {
      reads.output += 1;
      return reads.output === 1 ? ownerOutput : [ownerOnlySentinel];
    },
    get provider(): unknown {reads.provider += 1;
      return reads.provider === 1 ? "codex" : ownerOnlySentinel;},
    get resultRef(): unknown {reads.resultRef += 1;
      return reads.resultRef === 1 ? "result:first" : ownerOnlySentinel;},
    get status(): unknown {
      reads.turnStatus += 1;
      return reads.turnStatus === 1 ? "succeeded" : "running";
    },
  };
  const ownerOutcome = {
    get status(): unknown {
      reads.outcomeStatus += 1;
      return reads.outcomeStatus === 1 ? "observed" : "malformed-owner-status";
    },
    get turn(): unknown {
      reads.turn += 1;
      return reads.turn === 1 ? ownerTurn : ownerOnlySentinel;
    },
  };
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    observe: Object.freeze({ async execute() {return ownerOutcome as never;} }),
    submit: Object.freeze({ async execute() {return { status: "denied" } as const;} }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(() => host.dispose());

  const observation = await host.bindAccess({ containedTurn: trustedScope }).containedTurn
    .observe("operation:first");

  assert.deepEqual(observation, {
    status: "observed",
    turn: {
      artifactManifestRef: "artifact:first",
      commandId: "command:first",
      effectId: "effect:first",
      operationId: "operation:first",
      output: [{ cursor: 4, kind: "assistant", text: "first output" }],
      provider: "codex",
      resultRef: "result:first",
      status: "succeeded",
    },
  });
  assert.deepEqual(reads, {
    artifactManifestRef: 1, commandId: 1, cursor: 1, effectId: 1, kind: 1,
    operationId: 1, outcomeStatus: 1, output: 1, outputIndex: 1, outputLength: 1,
    provider: 1, resultRef: 1, text: 1, turn: 1, turnStatus: 1,
  });
  assert.equal(JSON.stringify(observation).includes(ownerOnlySentinel.secret), false);
  assert.equal(observation.status === "observed" && Object.isFrozen(observation.turn.output[0]), true);
});

test("passes opaque provider identities unchanged and preserves exact owner rejections", async t => {
  const receivedProviders: string[] = [];
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {return { status: "not_found" };},
    }),
    observe: Object.freeze({
      async execute() {return { status: "not_found" };},
    }),
    submit: Object.freeze({
      async execute(input) {
        receivedProviders.push(input.expectedProvider);
        switch (input.expectedProvider) {
          case "OpenCode": return { code: "provider_unsupported", status: "unsupported" };
          case "open code": return { code: "provider_mismatch", status: "unsupported" };
          case "vendor/model β": return { code: "mode_unsupported", status: "unsupported" };
          case "Conflict Provider": return { code: "command_fingerprint_conflict", status: "conflict" };
          default: return { status: "denied" };
        }
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(() => host.dispose());
  const access = host.bindAccess({ containedTurn: trustedScope });
  const submit = (expectedProvider: string) => access.containedTurn.submit({
    commandId: "command:provider-validation",
    expectedProvider,
    intent: { mode: "analysis", prompt: "synthetic" },
  });

  const opaqueProviders = ["OpenCode", "open code", "vendor/model β", "Conflict Provider", "Denied Provider"];
  assert.deepEqual(await submit(opaqueProviders[0]!), { code: "provider_unsupported", status: "unsupported" });
  assert.deepEqual(await submit(opaqueProviders[1]!), { code: "provider_mismatch", status: "unsupported" });
  assert.deepEqual(await submit(opaqueProviders[2]!), { code: "mode_unsupported", status: "unsupported" });
  assert.deepEqual(await submit(opaqueProviders[3]!), {
    code: "command_fingerprint_conflict",
    status: "conflict",
  });
  assert.deepEqual(await submit(opaqueProviders[4]!), { status: "denied" });
  assert.deepEqual(receivedProviders, opaqueProviders);
});

test("rejects malformed, non-string, and oversized provider input before composition", async t => {
  let submitCalls = 0;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {return { status: "not_found" };},
    }),
    observe: Object.freeze({
      async execute() {return { status: "not_found" };},
    }),
    submit: Object.freeze({
      async execute() {
        submitCalls += 1;
        return { status: "denied" };
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(() => host.dispose());
  const access = host.bindAccess({ containedTurn: trustedScope });
  const submit = (expectedProvider: unknown) => access.containedTurn.submit({
    commandId: "command:invalid-provider",
    expectedProvider: expectedProvider as string,
    intent: { mode: "analysis", prompt: "synthetic" },
  });
  const rejected = { code: "provider_unsupported", status: "unsupported" };

  assert.deepEqual(await submit(""), rejected);
  assert.deepEqual(await submit(42), rejected);
  assert.deepEqual(await submit("p".repeat(129)), rejected);
  assert.deepEqual(await access.containedTurn.submit({
    commandId: "command:malformed-provider",
    get expectedProvider(): never {throw new Error("malformed provider getter");},
    intent: { mode: "analysis", prompt: "synthetic" },
  }), rejected);
  assert.equal(submitCalls, 0);
});

test("fails closed on malformed, non-string, and oversized provider observations", async t => {
  const thrownProxy = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (property === "toString" || property === Symbol.toPrimitive) {
        throw new Error("owner-only-proxy-to-string-secret");
      }
      throw new Error("owner-only-proxy-getter-secret");
    },
    getPrototypeOf() {throw new Error("owner-only-proxy-prototype-secret");},
  });
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {return { status: "not_found" };},
    }),
    observe: Object.freeze({
      async execute(input) {
        if (input.operationId === "operation:malformed-provider") {
          return {
            status: "observed",
            turn: {
              ...turnView("running"),
              operationId: input.operationId,
              get provider(): never {throw new Error("malformed provider getter");},
            },
          };
        }
        if (input.operationId === "operation:proxy-thrown-provider") {
          return {
            status: "observed",
            turn: {
              ...turnView("succeeded"),
              operationId: input.operationId,
              get provider(): never {throw thrownProxy;},
            },
          };
        }
        const provider = input.operationId === "operation:non-string-provider"
          ? 42 as unknown as string
          : "p".repeat(129);
        return {
          status: "observed",
          turn: { ...turnView("running"), operationId: input.operationId, provider },
        };
      },
    }),
    submit: Object.freeze({
      async execute() {return { status: "denied" };},
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(() => host.dispose());
  const access = host.bindAccess({ containedTurn: trustedScope });
  const unavailableObservation = { code: "capability_unavailable", status: "unsupported" };

  await assert.rejects(access.containedTurn.observe("operation:malformed-provider"), error =>
    error instanceof ContainedTurnOwnerContractError && error.code === "malformed_owner_outcome" &&
    !error.message.includes("malformed provider getter"));
  await assert.rejects(access.containedTurn.observe("operation:proxy-thrown-provider"), error =>
    error instanceof ContainedTurnOwnerContractError && error.code === "malformed_owner_outcome" &&
    !error.message.includes("owner-only-proxy"));
  assert.deepEqual(await access.containedTurn.observe("operation:non-string-provider"), unavailableObservation);
  assert.deepEqual(await access.containedTurn.observe("operation:oversized-provider"), unavailableObservation);
});

test("accepts an explicit owner operation id without projecting optional observation fields", async t => {
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {return { status: "not_found" };},
    }),
    observe: Object.freeze({
      async execute() {return { status: "not_found" };},
    }),
    submit: Object.freeze({
      async execute() {
        return {
          status: "observed",
          turn: {
            operationId: "operation:accepted-without-projection",
            status: "succeeded",
            get artifactManifestRef(): never {throw new Error("optional observation field must not be read");},
            get output(): never {throw new Error("observation output must not be projected during submit");},
          },
        };
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(() => host.dispose());
  const access = host.bindAccess({ containedTurn: trustedScope });

  assert.deepEqual(await access.containedTurn.submit({
    commandId: "command:accepted-without-projection",
    expectedProvider: "Vendor / Model β",
    intent: { mode: "analysis", prompt: "synthetic" },
  }), {
    operationId: "operation:accepted-without-projection",
    status: "accepted",
  });
});

for (const completionStatus of ["running", "reconcile_required"] as const) {
  test(`Host retains a ${completionStatus} completion without an acceptance callback`, async () => {
    const contained = createDisposalDouble(completionStatus, completionStatus);
    const feature: ContainedTurnCapabilityBundle = Object.freeze({
      cancel: contained.feature.cancel,
      observe: contained.feature.observe,
      submit: Object.freeze({
        async execute() {
          return { status: "observed", turn: turnView(completionStatus) } as const;
        },
      }),
    });
    const host = await submitDisposalTurn(feature);

    const error = await host.dispose().then(
      () => assert.fail("nonterminal completion must remain under Host custody"),
      failure => failure,
    );

    assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
    if (error instanceof AgentRuntimeHostDisposalIncompleteError) {
      assert.equal(error.status, "termination_unproven");
      assert.deepEqual(error.containedTurns, [{
        operationId: "operation:embedded",
        status: completionStatus,
      }]);
    }
    assert.equal(contained.cancellationCalls(), 1);
  });
}

for (const nonterminalStatus of ["accepted", "running", "reconcile_required"] as const) {
  test(`Host disposal retains ${nonterminalStatus} operations and returns detached termination proof failure`, async () => {
    const contained = createDisposalDouble(nonterminalStatus, nonterminalStatus);
    const host = await submitDisposalTurn(contained.feature);

    const firstDisposal = host.dispose();
    const secondDisposal = host.dispose();
    assert.equal(firstDisposal, secondDisposal);
    const error = await firstDisposal.then(
      () => assert.fail("nonterminal disposal must not report clean shutdown"),
      failure => failure,
    );

    assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
    if (!(error instanceof AgentRuntimeHostDisposalIncompleteError)) {
      return;
    }
    assert.equal(error.status, "termination_unproven");
    assert.equal(error.activeCallCount, 0);
    assert.deepEqual(error.containedTurns, [{
      operationId: "operation:embedded",
      status: nonterminalStatus,
    }]);
    assert.equal(contained.cancellationCalls(), 1);
    assert.equal(Object.isFrozen(error), true);
    assert.equal(Object.isFrozen(error.containedTurns), true);
    assert.equal(Object.isFrozen(error.containedTurns[0]), true);
    assert.deepEqual(Object.keys(error.containedTurns[0]!).toSorted(), ["operationId", "status"]);
    assert.equal(JSON.stringify(error).includes("project:embedded"), false);
    assert.equal(JSON.stringify(error).includes("tenant:embedded"), false);
    assert.throws(() => {
      (error.containedTurns as { operationId: string }[])[0]!.operationId = "operation:mutated";
    }, TypeError);
    await assert.rejects(secondDisposal, failure => failure === error);
  });
}

test("Host disposal retains an operation accepted after shutdown starts", async () => {
  let publishAcceptance: (() => void) | undefined;
  const acceptanceGate = new Promise<void>(resolve => {publishAcceptance = resolve;});
  let cancellationCalls = 0;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {
        cancellationCalls += 1;
        return { status: "observed", turn: turnView("running") } as const;
      },
    }),
    observe: Object.freeze({
      async execute() {return { status: "observed", turn: turnView("running") } as const;},
    }),
    submit: Object.freeze({
      async execute(input, options) {
        await acceptanceGate;
        options?.onAccepted?.(Object.freeze({
          operationId: "operation:embedded",
          scope: Object.freeze({ ...input.scope }),
        }));
        return { status: "observed", turn: turnView("running") } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const submission = host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:late-acceptance",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic late acceptance" },
  });

  const disposal = host.dispose();
  await assert.rejects(submission, { name: "AbortError" });
  publishAcceptance?.();
  const error = await disposal.then(
    () => assert.fail("late nonterminal acceptance must remain under Host custody"),
    failure => failure,
  );

  assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
  if (!(error instanceof AgentRuntimeHostDisposalIncompleteError)) {
    return;
  }
  assert.equal(cancellationCalls, 1);
  assert.equal(error.status, "termination_unproven");
  assert.deepEqual(error.containedTurns, [{
    operationId: "operation:embedded",
    status: "running",
  }]);
});

test("Host rejects crossed acceptance callback and completion operation IDs", async () => {
  const cancellationCalls: string[] = [];
  const crossedTurn = (operationId: string, status: ContainedTurnStatus) => Object.freeze({
    ...turnView(status),
    commandId: `command:${operationId}`,
    effectId: `effect:${operationId}`,
    operationId,
  });
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute(input) {
        cancellationCalls.push(input.operationId);
        const status = input.operationId === "operation:callback" ? "cancelled" : "running";
        return { status: "observed", turn: crossedTurn(input.operationId, status) } as const;
      },
    }),
    observe: Object.freeze({
      async execute(input) {
        return { status: "observed", turn: crossedTurn(input.operationId, "running") } as const;
      },
    }),
    submit: Object.freeze({
      async execute(input, options) {
        options?.onAccepted?.(Object.freeze({
          operationId: "operation:callback",
          scope: Object.freeze({ ...input.scope }),
        }));
        return {
          status: "observed",
          turn: crossedTurn("operation:completion", "running"),
        } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const accepted = await host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:crossed",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic crossed identifiers" },
  });
  assert.deepEqual(accepted, { operationId: "operation:callback", status: "accepted" });
  await new Promise<void>(resolve => {setImmediate(resolve);});

  const error = await host.dispose().then(
    () => assert.fail("crossed nonterminal completion must remain under Host custody"),
    failure => failure,
  );
  assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
  if (!(error instanceof AgentRuntimeHostDisposalIncompleteError)) {
    return;
  }
  assert.deepEqual(cancellationCalls, ["operation:callback"]);
  assert.deepEqual(error.containedTurns, [{
    operationId: "operation:callback",
    status: "contract_violation",
  }]);
  assert.equal(error instanceof ContainedTurnOwnerContractError, false);
});

for (const cancellationOutcome of ["mismatch", "not_found", "reject"] as const) {
  test(`Host disposal fails closed when cancellation returns ${cancellationOutcome}`, async () => {
    const contained = createDisposalDouble("running", cancellationOutcome);
    const host = await submitDisposalTurn(contained.feature);

    const error = await host.dispose().then(
      () => assert.fail("unproved cancellation must not report clean shutdown"),
      failure => failure,
    );
    assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
    if (!(error instanceof AgentRuntimeHostDisposalIncompleteError)) {
      return;
    }
    assert.equal(error.status, "termination_unproven");
    assert.deepEqual(error.containedTurns, [{
      operationId: "operation:embedded",
      status: cancellationOutcome === "mismatch"
        ? "operation_mismatch"
        : cancellationOutcome === "not_found"
          ? "not_found"
          : "cancellation_failed",
    }]);
    assert.equal(contained.cancellationCalls(), 1);
    assert.equal(JSON.stringify(error).includes("owner-only cancellation failure detail"), false);
  });
}

for (const terminalStatus of ["cancelled", "failed", "succeeded"] as const) {
  test(`Host disposal accepts owner proof of terminal ${terminalStatus}`, async () => {
    const contained = createDisposalDouble("running", terminalStatus);
    const host = await submitDisposalTurn(contained.feature);

    await host.dispose();
    assert.equal(contained.cancellationCalls(), 1);
    await host.dispose();
  });
}

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
  await assert.rejects(access.containedTurn.observe("operation:embedded"), error =>
    error instanceof AgentRuntimeHostLifecycleError && error.code === "host_disposed");
  assert.equal("dispose" in access, false);
});

test("caller abort detaches only its waiter and never manufactures durable cancellation", async t => {
  let publishAcceptance: (() => void) | undefined;
  let releaseCompletion: (() => void) | undefined;
  const acceptanceGate = new Promise<void>(resolve => {publishAcceptance = resolve;});
  const completionGate = new Promise<void>(resolve => {releaseCompletion = resolve;});
  const calls = { cancel: 0 };
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
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
