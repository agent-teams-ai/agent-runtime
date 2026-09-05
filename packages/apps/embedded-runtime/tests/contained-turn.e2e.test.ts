import { createAgentRuntimeHost } from "./helpers/create-contained-turn-host.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { createContainedTurnFeature } from "@agent-teams/agent-execution/composition";
import {
  createDependencies,
  operationId as fixtureOperationId,
} from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

import {
  AgentRuntimeHostDisposalIncompleteError,
  AgentRuntimeHostLifecycleError,
  ContainedTurnOwnerContractError,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";
import type { ContainedTurnCapabilityBundle } from "../dist/composition.js";
import { copySubmitOutcome } from "../dist/composition/contained-turn-runtime-validation.js";

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
  ...(status === "cancelled" || status === "failed" || status === "succeeded"
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
    revision: 7,
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
    provider: 0, resultRef: 0, revision: 0, text: 0, turn: 0, turnStatus: 0,
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
    get revision(): unknown {reads.revision += 1;
      return reads.revision === 1 ? 7 : ownerOnlySentinel;},
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
    provider: 1, resultRef: 1, revision: 1, text: 1, turn: 1, turnStatus: 1,
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

test("rejects unbounded command and prompt input before composition", async t => {
  let submitCalls = 0;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({ async execute() {return { status: "not_found" };} }),
    observe: Object.freeze({ async execute() {return { status: "not_found" };} }),
    submit: Object.freeze({ async execute() {submitCalls += 1; return { status: "denied" };} }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(() => host.dispose());
  const access = host.bindAccess({ containedTurn: trustedScope });
  const rejected = { code: "provider_unsupported", status: "unsupported" };
  const base = {
    commandId: "command:bounded-input",
    expectedProvider: "codex",
    intent: { mode: "analysis" as const, prompt: "synthetic" },
  };

  assert.deepEqual(await access.containedTurn.submit({
    ...base, commandId: "c".repeat(257),
  }), rejected);
  assert.deepEqual(await access.containedTurn.submit({
    ...base, intent: { mode: "analysis", prompt: "p".repeat(65_537) },
  }), rejected);
  assert.deepEqual(await access.containedTurn.submit({
    ...base, intent: { mode: "invalid" as never, prompt: "synthetic" },
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

test("retains a terminal submit completion missing required owner closure fields", async () => {
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
  const access = host.bindAccess({ containedTurn: trustedScope });

  await assert.rejects(access.containedTurn.submit({
    commandId: "command:accepted-without-projection",
    expectedProvider: "Vendor / Model β",
    intent: { mode: "analysis", prompt: "synthetic" },
  }), error => error instanceof ContainedTurnOwnerContractError &&
    error.code === "malformed_owner_outcome" &&
    !error.message.includes("optional observation field"));

  await assert.rejects(host.dispose(), error =>
    error instanceof AgentRuntimeHostDisposalIncompleteError &&
    error.status === "termination_unproven" &&
    error.containedTurns.length === 1 &&
    error.containedTurns[0]?.operationId === "operation:accepted-without-projection" &&
    error.containedTurns[0].status === "contract_violation");
});

test("contains synchronous and asynchronous owner invocation failures behind one secret-safe error", async t => {
  const secret = "owner-only invocation secret";
  let proxyTrapCalls = 0;
  const hostileProxy = new Proxy(Object.create(null) as object, {
    get() {proxyTrapCalls += 1; throw new Error("owner-only proxy get secret");},
    getPrototypeOf() {proxyTrapCalls += 1; throw new Error("owner-only proxy prototype secret");},
  });
  const failures = [secret, hostileProxy] as const;
  let canonicalFailure: unknown;

  for (const invocation of ["submit", "observe", "cancel"] as const) {
    for (const timing of ["synchronous", "asynchronous"] as const) {
      for (const failure of failures) {
        const fail = timing === "synchronous"
          ? () => {throw failure;}
          : async () => {throw failure;};
        const feature: ContainedTurnCapabilityBundle = Object.freeze({
          cancel: Object.freeze({
            execute: invocation === "cancel"
              ? fail
              : async () => ({ status: "not_found" as const }),
          }),
          observe: Object.freeze({
            execute: invocation === "observe"
              ? fail
              : async () => ({ status: "not_found" as const }),
          }),
          submit: Object.freeze({
            execute: invocation === "submit"
              ? fail
              : async () => ({ status: "denied" as const }),
          }),
        }) as ContainedTurnCapabilityBundle;
        const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
        t.after(() => host.dispose());
        const access = host.bindAccess({ containedTurn: trustedScope }).containedTurn;
        const call = invocation === "submit"
          ? access.submit({
              commandId: "command:owner-failure",
              expectedProvider: "codex",
              intent: { mode: "analysis", prompt: "synthetic" },
            })
          : invocation === "observe"
            ? access.observe("operation:owner-failure")
            : access.cancel("operation:owner-failure");
        const error = await call.catch(caught => caught);
        assert.equal(error instanceof ContainedTurnOwnerContractError, true);
        assert.equal((error as ContainedTurnOwnerContractError).code, "owner_invocation_failed");
        assert.equal(JSON.stringify(error).includes(secret), false);
        if (canonicalFailure === undefined) {
          canonicalFailure = error;
        } else {
          assert.equal(error, canonicalFailure);
        }
      }
    }
  }
  assert.equal(proxyTrapCalls, 0);
});

test("validates every terminal submit field once before releasing Host custody", async () => {
  const reads = {
    artifactManifestRef: 0,
    commandId: 0,
    effectId: 0,
    operationId: 0,
    output: 0,
    provider: 0,
    resultRef: 0,
    revision: 0,
    status: 0,
  };
  const once = <Key extends keyof typeof reads>(key: Key, value: unknown): unknown => {
    reads[key] += 1;
    return reads[key] === 1 ? value : undefined;
  };
  const ownerTurn = {
    get artifactManifestRef(): unknown {return once("artifactManifestRef", "artifact:terminal");},
    get commandId(): unknown {return once("commandId", "command:terminal");},
    get effectId(): unknown {return once("effectId", "effect:terminal");},
    get operationId(): unknown {return once("operationId", "operation:terminal");},
    get output(): unknown {return once("output", []);},
    get provider(): unknown {return once("provider", "codex");},
    get resultRef(): unknown {return once("resultRef", "result:terminal");},
    get revision(): unknown {return once("revision", 17);},
    get status(): unknown {return once("status", "succeeded");},
  };
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    submit: Object.freeze({ async execute() {
      return { status: "observed", turn: ownerTurn } as never;
    } }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });

  assert.deepEqual(await host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:terminal",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic" },
  }), { operationId: "operation:terminal", status: "accepted" });
  await host.dispose();
  assert.deepEqual(reads, {
    artifactManifestRef: 1,
    commandId: 1,
    effectId: 1,
    operationId: 1,
    output: 1,
    provider: 1,
    resultRef: 1,
    revision: 1,
    status: 1,
  });
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
  await assert.rejects(access.containedTurn.observe("operation:embedded"), error =>
    error instanceof AgentRuntimeHostLifecycleError && error.code === "host_disposed");
  assert.equal("dispose" in access, false);
});

test("caller abort before durable acceptance detaches only its waiter without an unhandled rejection", async t => {
  let publishAcceptance: (() => void) | undefined;
  let releaseCompletion: (() => void) | undefined;
  const acceptanceGate = new Promise<void>(resolve => {publishAcceptance = resolve;});
  const completionGate = new Promise<void>(resolve => {releaseCompletion = resolve;});
  const calls = { cancel: 0, submit: 0 };
  const ownerFailure = new Error("owner completion after caller detachment");
  let ownerSignal: AbortSignal | undefined;
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
        calls.submit += 1;
        ownerSignal = options?.signal;
        await acceptanceGate;
        options?.onAccepted?.({ operationId: "operation:embedded", scope: input.scope });
        await completionGate;
        throw ownerFailure;
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
  const survivingSubmission = host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:abort-waiter",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic" },
  });
  assert.equal(calls.submit, 1);
  controller.abort(new DOMException("caller detached", "AbortError"));
  await assert.rejects(submission, { name: "AbortError" });
  assert.equal(ownerSignal?.aborted, false);
  assert.equal(calls.cancel, 0);
  publishAcceptance?.();
  assert.deepEqual(await survivingSubmission, {
    operationId: "operation:embedded",
    status: "accepted",
  });
  assert.equal(calls.submit, 1);
  assert.equal(calls.cancel, 0);
  releaseCompletion?.();
});

test("caller abort after accepted response preserves the operation and explicit cancel identity", async t => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => {releaseProvider = resolve;});
  const controller = new AbortController();
  let fixture: ReturnType<typeof createDependencies>;
  let reportProviderStarted!: () => void;
  const providerStarted = new Promise<void>(resolve => {reportProviderStarted = resolve;});
  fixture = createDependencies({
    providerGate,
    providerStarted: () => {
      controller.abort(new DOMException("caller detached", "AbortError"));
      reportProviderStarted();
    },
  });
  const feature = createContainedTurnFeature(fixture.dependencies);
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  t.after(async () => {
    releaseProvider();
    await assert.rejects(host.dispose(), error =>
      error instanceof AgentRuntimeHostDisposalIncompleteError &&
      error.status === "termination_unproven");
  });
  const scope = Object.freeze({ projectId: "project:one", tenantId: "tenant:one" });
  const access = host.bindAccess({ containedTurn: scope });

  const submission = access.containedTurn.submit({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
  }, { signal: controller.signal });
  assert.deepEqual(await submission, { operationId: fixtureOperationId, status: "accepted" });
  await providerStarted;
  while (fixture.current()?.providerExecution.kind !== "active") {
    await new Promise<void>(resolve => {setImmediate(resolve);});
  }

  const afterAbortBeforeCancellation = fixture.current();
  assert.ok(afterAbortBeforeCancellation !== undefined);
  assert.equal(afterAbortBeforeCancellation.cancellation.kind, "open");
  assert.equal(afterAbortBeforeCancellation.operationCutoff.kind, "open");
  assert.equal(afterAbortBeforeCancellation.output.fence.kind, "open");
  assert.equal(afterAbortBeforeCancellation.providerExecution.kind, "active");

  assert.equal(fixture.current(), afterAbortBeforeCancellation);
  assert.equal(fixture.containmentCalls.value, 0);
  assert.equal(fixture.providerCalls.value, 1);

  const cancellation = await access.containedTurn.cancel(fixtureOperationId);
  assert.equal(cancellation.status, "observed");
  const afterCancellation = fixture.current();
  assert.ok(afterCancellation !== undefined);
  assert.equal(afterCancellation.cancellation.kind, "requested");
  if (afterCancellation.cancellation.kind === "requested") {
    assert.equal(
      afterCancellation.cancellation.command.cancellationCommandId,
      "cancellation-command:one",
    );
  }
  assert.equal(afterCancellation.operationCutoff.kind, "closed");
  assert.ok(afterCancellation.revision > afterAbortBeforeCancellation.revision);
  assert.equal(fixture.containmentCalls.value, 1);
  assert.equal(fixture.providerCalls.value, 1);
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


test("potential durable acceptance is not accepted or tracked by RuntimeAccessHandle", async () => {
  const fixture = createDependencies({ potentialAcceptance: true });
  let acceptanceCalls = 0;
  let cancellationCalls = 0;
  const feature = createContainedTurnFeature({
    ...fixture.dependencies,
    operationStore: {
      ...fixture.dependencies.operationStore,
      accept: async (...args) => {
        acceptanceCalls += 1;
        return fixture.dependencies.operationStore.accept(...args);
      },
    },
  });
  const host = createAgentRuntimeHost({
    ...setupDependencies,
    containedTurn: {
      ...feature,
      cancel: { execute: async (...args) => {
        cancellationCalls += 1;
        return feature.cancel.execute(...args);
      } },
    },
  });
  const access = host.bindAccess({ containedTurn: trustedScope });
  const outcome = await access.containedTurn.submit({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect potential durable acceptance" },
  });
  assert.deepEqual(outcome, {
    candidateOperationId: fixtureOperationId,
    commandId: "command:one",
    evidenceId: "evidence:potential-acceptance",
    status: "potential_acceptance",
  });
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(fixture.current(), undefined);
  assert.deepEqual(await access.containedTurn.observe(fixtureOperationId), { status: "not_found" });
  assert.deepEqual(await access.containedTurn.cancel(fixtureOperationId), { status: "not_found" });
  assert.equal(cancellationCalls, 1);
  // An ephemeral owner registration would make disposal attempt cancellation again
  // and fail with termination_unproven after observing not_found.
  await host.dispose();
  assert.equal(cancellationCalls, 1);
  assert.equal(acceptanceCalls, 1);
  assert.equal(fixture.current(), undefined);
  assert.equal(fixture.createdWorkspaces.length, 0);
  assert.equal(fixture.providerCalls.value, 0);
  await assert.rejects(access.containedTurn.submit({
    commandId: "command:one", expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect potential durable acceptance" },
  }), error => error instanceof AgentRuntimeHostLifecycleError && error.code === "host_disposed");
  assert.equal(acceptanceCalls, 1);
});


test("potential acceptance projection retains only bounded detached reconciliation references", () => {
  const owner = {
    candidateOperationId: "operation:potential", commandId: "command:potential",
    evidenceId: "evidence:potential", status: "potential_acceptance",
    revision: 77, scope: trustedScope, candidateOperation: { private: "owner state" },
    credential: "private credential", path: "/private/owner/workspace",
  };
  let confirmedReferences = 0;
  const copied = copySubmitOutcome(owner, () => {confirmedReferences += 1;});
  const expected = {
    candidateOperationId: "operation:potential", commandId: "command:potential",
    evidenceId: "evidence:potential", status: "potential_acceptance",
  };
  assert.deepEqual(copied, { outcome: expected });
  owner.candidateOperationId = "operation:mutated";
  owner.commandId = "command:mutated";
  owner.evidenceId = "evidence:mutated";
  assert.deepEqual(copied.outcome, expected);
  assert.equal(Object.isFrozen(copied.outcome), true);
  assert.equal(confirmedReferences, 0);
  for (const field of ["candidateOperationId", "commandId", "evidenceId"] as const) {
    for (const value of [undefined, "", "x".repeat(513), "bad\nidentity", trustedScope]) {
      assert.throws(() => copySubmitOutcome({ ...expected, [field]: value }),
        error => error instanceof ContainedTurnOwnerContractError && error.code === "malformed_owner_outcome");
    }
  }
});
