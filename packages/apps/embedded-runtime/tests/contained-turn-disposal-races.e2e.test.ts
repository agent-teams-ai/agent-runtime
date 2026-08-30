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
type ContainedTurnStatus = "cancelled" | "running" | "succeeded";
type AcceptanceObserver = (operation: Readonly<{
  operationId: string;
  scope: ContainedTurnScope;
}>) => void;

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

test("Host ignores an acceptance callback after its owner operation has settled", async () => {
  let lateAcceptance: AcceptanceObserver | undefined;
  let cancellationCalls = 0;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {
        cancellationCalls += 1;
        return { status: "observed", turn: turnView("cancelled") } as const;
      },
    }),
    observe: Object.freeze({
      async execute() {return { status: "not_found" } as const;},
    }),
    submit: Object.freeze({
      async execute(_input, options) {
        lateAcceptance = options?.onAccepted;
        return { status: "denied" } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const access = host.bindAccess({ containedTurn: trustedScope });
  assert.deepEqual(await access.containedTurn.submit({
    commandId: "command:settled-callback",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic settled callback" },
  }), { status: "denied" });

  const disposal = host.dispose();
  await disposal;
  lateAcceptance?.({ operationId: "operation:too-late", scope: trustedScope });
  await new Promise<void>(resolve => {setImmediate(resolve);});

  assert.equal(cancellationCalls, 0);
  assert.equal(host.dispose(), disposal);
  await host.dispose();
});

test("Host rejects acceptance custody with an unreadable owner scope", async () => {
  const cancellationScopes: ContainedTurnScope[] = [];
  const hostileScope = Object.create(null, {
    projectId: { get: () => {throw new Error("owner scope must not be read");} },
    tenantId: { get: () => {throw new Error("owner scope must not be read");} },
  }) as ContainedTurnScope;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute(input) {
        cancellationScopes.push(input.scope);
        return { status: "observed", turn: turnView("cancelled") } as const;
      },
    }),
    observe: Object.freeze({
      async execute() {return { status: "observed", turn: turnView("running") } as const;},
    }),
    submit: Object.freeze({
      async execute(_input, options) {
        options?.onAccepted?.({
          operationId: "operation:embedded",
          scope: hostileScope,
        });
        return { status: "observed", turn: turnView("running") } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  await assert.rejects(host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:scope-rebinding",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic scope rebinding" },
  }), error => error instanceof ContainedTurnOwnerContractError &&
    error.code === "malformed_owner_outcome");

  const disposalError = await host.dispose().catch(error => error);

  assert.equal(disposalError instanceof AgentRuntimeHostDisposalIncompleteError, true);
  assert.deepEqual(disposalError.containedTurns, [{
    operationId: "operation:embedded",
    status: "contract_violation",
  }]);
  assert.deepEqual(cancellationScopes, [trustedScope]);
});

test("Host rejects acceptance custody with a mismatched owner scope", async () => {
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    submit: Object.freeze({
      async execute(_input, options) {
        options?.onAccepted?.({
          operationId: "operation:scope-mismatch",
          scope: { projectId: "project:crossed", tenantId: "tenant:embedded" },
        });
        return { status: "observed", turn: {
          ...turnView("running"), operationId: "operation:scope-mismatch",
        } } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });

  await assert.rejects(host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:scope-mismatch",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic" },
  }), error => error instanceof ContainedTurnOwnerContractError &&
    error.code === "malformed_owner_outcome");
  const disposalError = await host.dispose().catch(error => error);
  assert.equal(disposalError instanceof AgentRuntimeHostDisposalIncompleteError, true);
  assert.deepEqual(disposalError.containedTurns, [{
    operationId: "operation:scope-mismatch",
    status: "contract_violation",
  }]);
});

test("Host disposal contains hostile owner cancellation failures without inspecting them", async () => {
  let trapCalls = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    get() {trapCalls += 1; throw new Error("owner-only disposal proxy get secret");},
    getPrototypeOf() {trapCalls += 1; throw new Error("owner-only disposal proxy prototype secret");},
  });
  for (const timing of ["synchronous", "asynchronous"] as const) {
    const fail = timing === "synchronous"
      ? () => {throw hostile;}
      : async () => {throw hostile;};
    const feature = Object.freeze({
      cancel: Object.freeze({ execute: fail }),
      observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
      submit: Object.freeze({
        async execute(input, options) {
          options?.onAccepted?.({ operationId: "operation:embedded", scope: input.scope });
          return { status: "observed", turn: turnView("running") } as const;
        },
      }),
    }) as ContainedTurnCapabilityBundle;
    const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
    assert.deepEqual(await host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
      commandId: "command:embedded",
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "synthetic disposal" },
    }), { operationId: "operation:embedded", status: "accepted" });
    await new Promise<void>(resolve => {setImmediate(resolve);});
    const error = await host.dispose().catch(caught => caught);
    assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
    assert.deepEqual(error.containedTurns, [{
      operationId: "operation:embedded",
      status: "cancellation_failed",
    }]);
    assert.equal(JSON.stringify(error).includes("owner-only disposal"), false);
  }
  assert.equal(trapCalls, 0);
});

test("Host applies terminal completion proof before considering shutdown cancellation", async () => {
  let releaseCompletion: (() => void) | undefined;
  const completionGate = new Promise<void>(resolve => {releaseCompletion = resolve;});
  let cancellationCalls = 0;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {
        cancellationCalls += 1;
        return new Promise<never>(() => {});
      },
    }),
    observe: Object.freeze({
      async execute() {return { status: "not_found" } as const;},
    }),
    submit: Object.freeze({
      async execute() {
        await completionGate;
        return { status: "observed", turn: turnView("succeeded") } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const submission = host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:terminal-completion",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic terminal completion" },
  });

  const disposal = host.dispose();
  await assert.rejects(submission, { name: "AbortError" });
  releaseCompletion?.();
  await disposal;

  assert.equal(cancellationCalls, 0);
});

test("Host disposal is reentrant and deduplicates shutdown cancellation", async () => {
  let releaseCompletion: (() => void) | undefined;
  const completionGate = new Promise<void>(resolve => {releaseCompletion = resolve;});
  let cancellationCalls = 0;
  let repeatAcceptance: AcceptanceObserver | undefined;
  let reentrantDisposal: Promise<void> | undefined;
  let host: ReturnType<typeof createAgentRuntimeHost>;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {
        cancellationCalls += 1;
        repeatAcceptance?.({ operationId: "operation:embedded", scope: trustedScope });
        releaseCompletion?.();
        return { status: "observed", turn: turnView("cancelled") } as const;
      },
    }),
    observe: Object.freeze({
      async execute() {return { status: "observed", turn: turnView("running") } as const;},
    }),
    submit: Object.freeze({
      async execute(input, options) {
        repeatAcceptance = options?.onAccepted;
        options?.onAccepted?.(Object.freeze({
          operationId: "operation:embedded",
          scope: Object.freeze({ ...input.scope }),
        }));
        options?.signal?.addEventListener("abort", () => {
          reentrantDisposal = host.dispose();
        }, { once: true });
        await completionGate;
        return { status: "observed", turn: turnView("cancelled") } as const;
      },
    }),
  });
  host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  assert.deepEqual(await host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:reentrant-disposal",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic reentrant disposal" },
  }), { operationId: "operation:embedded", status: "accepted" });

  const disposal = host.dispose();

  assert.equal(reentrantDisposal, disposal);
  await disposal;
  assert.equal(cancellationCalls, 1);
});

test("Host reports bounded incomplete disposal when cancellation never settles", async () => {
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute() {return new Promise<never>(() => {});},
    }),
    observe: Object.freeze({
      async execute() {return { status: "observed", turn: turnView("running") } as const;},
    }),
    submit: Object.freeze({
      async execute(input, options) {
        options?.onAccepted?.(Object.freeze({
          operationId: "operation:embedded",
          scope: Object.freeze({ ...input.scope }),
        }));
        return { status: "observed", turn: turnView("running") } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  assert.deepEqual(await host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:non-cooperative-cancellation",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic non-cooperative cancellation" },
  }), { operationId: "operation:embedded", status: "accepted" });
  await new Promise<void>(resolve => {setImmediate(resolve);});

  const error = await host.dispose().then(
    () => assert.fail("non-cooperative cancellation must not report clean disposal"),
    failure => failure,
  );

  assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
  if (!(error instanceof AgentRuntimeHostDisposalIncompleteError)) {
    return;
  }
  assert.equal(error.status, "disposal_incomplete");
  assert.equal(error.activeCallCount, 1);
  assert.deepEqual(error.containedTurns, [{
    operationId: "operation:embedded",
    status: "running",
  }]);
  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.isFrozen(error.containedTurns), true);
  assert.equal(Object.isFrozen(error.containedTurns[0]), true);
  assert.equal(JSON.stringify(error).includes("project:embedded"), false);
  assert.equal(JSON.stringify(error).includes("tenant:embedded"), false);
});

test("Host registers an owner call before synchronous reentrant disposal", async () => {
  let releaseOwner!: () => void;
  const ownerGate = new Promise<void>(resolve => {releaseOwner = resolve;});
  let reentrantDisposal: Promise<void> | undefined;
  let host!: ReturnType<typeof createAgentRuntimeHost>;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    submit: Object.freeze({
      execute() {
        reentrantDisposal = host.dispose();
        return ownerGate.then(() => ({ status: "denied" as const }));
      },
    }),
  });
  host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const submission = host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
    commandId: "command:sync-reentrant",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "synthetic pending owner" },
  });
  let disposalSettled = false;
  void reentrantDisposal!.finally(() => {disposalSettled = true;});
  await assert.rejects(submission, { name: "AbortError" });
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(disposalSettled, false);
  releaseOwner();
  await reentrantDisposal;
  assert.equal(disposalSettled, true);
});

test("Host rejects access after disposal with a bounded typed lifecycle error", async () => {
  const host = createAgentRuntimeHost(setupDependencies);
  const access = host.bindAccess({});
  await host.dispose();
  await assert.rejects(access.containedTurn.observe("operation:after-dispose"), error =>
    error instanceof AgentRuntimeHostLifecycleError && error.code === "host_disposed" &&
    !error.message.includes("operation:after-dispose"));
  assert.throws(() => host.bindAccess({}), error =>
    error instanceof AgentRuntimeHostLifecycleError && error.code === "host_disposed");
});

test("Host rejects a duplicate operation identity as an owner contract violation", async () => {
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute(input) {
        return { status: "observed", turn: { ...turnView("cancelled"), operationId: input.operationId } } as const;
      },
    }),
    observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    submit: Object.freeze({
      async execute(input, options) {
        options?.onAccepted?.({ operationId: "operation:duplicate", scope: input.scope });
        return { status: "observed", turn: {
          ...turnView("running"), operationId: "operation:duplicate",
        } } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const access = host.bindAccess({ containedTurn: trustedScope });
  const input = {
    commandId: "command:duplicate",
    expectedProvider: "codex",
    intent: { mode: "analysis" as const, prompt: "synthetic duplicate" },
  };
  assert.equal((await access.containedTurn.submit(input)).status, "accepted");
  await assert.rejects(access.containedTurn.submit(input), error =>
    error instanceof ContainedTurnOwnerContractError && error.code === "duplicate_operation_id");
  await assert.rejects(host.dispose(), error =>
    error instanceof AgentRuntimeHostDisposalIncompleteError &&
    error.containedTurns[0]?.status === "contract_violation");
});

test("Disposal issues use deterministic Unicode code-point ordering", async () => {
  const operationIds = ["operation:😀", "operation:ä", "operation:z", "operation:𐀀"];
  let nextOperation = 0;
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute(input) {
        return { status: "observed", turn: {
          ...turnView("running"), operationId: input.operationId,
        } } as const;
      },
    }),
    observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
    submit: Object.freeze({
      async execute(input, options) {
        const operationId = operationIds[nextOperation++]!;
        options?.onAccepted?.({ operationId, scope: input.scope });
        return { status: "observed", turn: {
          ...turnView("running"), operationId,
        } } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const access = host.bindAccess({ containedTurn: trustedScope });
  for (const index of operationIds.keys()) {
    await access.containedTurn.submit({
      commandId: `command:unicode:${index}`,
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "synthetic Unicode order" },
    });
  }
  const error = await host.dispose().catch(failure => failure);
  assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
  assert.deepEqual(error.containedTurns.map((issue: { operationId: string }) => issue.operationId), [
    "operation:z", "operation:ä", "operation:𐀀", "operation:😀",
  ]);
});

test("Host disposal rejects malformed and snapshot-unstable cancellation proof", async t => {
  const thrownProxy = new Proxy(Object.create(null) as object, {
    get() {throw new Error("owner-only-proxy-get-secret");},
    getPrototypeOf() {throw new Error("owner-only-proxy-prototype-secret");},
  });
  const cases = [
    {
      expectedStatus: "contract_violation",
      name: "the review malformed-discriminant counterexample",
      outcome: {
        status: "malformed-owner-status",
        turn: { operationId: "operation:embedded", status: "succeeded" },
      },
    },
    {
      expectedStatus: "operation_mismatch",
      name: "an operation identity that crosses to the requested identity on reread",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          operationIdReads: 0,
          get operationId(): string {
            this.operationIdReads += 1;
            return this.operationIdReads === 1 ? "operation:crossed" : "operation:embedded";
          },
          status: "succeeded",
        },
      },
    },
    {
      expectedStatus: "running",
      name: "a nonterminal status that crosses to terminal on reread",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("running"),
          statusReads: 0,
          get status(): string {
            this.statusReads += 1;
            return this.statusReads === 1 ? "running" : "succeeded";
          },
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "the review terminal turn with a throwing output counterexample",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          get output(): never {throw new Error("owner-only terminal output");},
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a terminal turn with a throwing artifact closure getter",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          get artifactManifestRef(): never {throw new Error("owner-only terminal artifact");},
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a terminal turn with a throwing result closure getter",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          get resultRef(): never {throw new Error("owner-only terminal result");},
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a terminal turn with a throwing revision getter",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          get revision(): never {throw new Error("owner-only terminal revision");},
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a terminal turn missing result closure evidence",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          resultRef: undefined,
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a terminal turn with a mismatched revision",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          revision: -1,
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a terminal output getter that throws a hostile Proxy value",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          get output(): never {throw thrownProxy;},
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a mutable terminal output that becomes valid only on reread",
      outcome: {
        status: "observed",
        turn: {
          ...turnView("succeeded"),
          outputReads: 0,
          get output(): unknown {
            this.outputReads += 1;
            return this.outputReads === 1 ? [{ cursor: 0, kind: "assistant" }] : [];
          },
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a malformed complete terminal turn missing a required effect identity",
      outcome: {
        status: "observed",
        turn: {
          commandId: "command:embedded",
          operationId: "operation:embedded",
          output: [],
          provider: "codex",
          status: "succeeded",
        },
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a cancellation turn getter that throws owner-only detail",
      outcome: {
        status: "observed",
        get turn(): never {throw new Error("owner-only throwing cancellation getter");},
      },
    },
    {
      expectedStatus: "contract_violation",
      name: "a proxy cancellation result with a malformed terminal discriminant",
      outcome: new Proxy({
        turn: new Proxy({}, {
          get(_target, property) {
            return property === "operationId" ? "operation:embedded" : "complete";
          },
        }),
      }, {
        get(target, property, receiver) {
          return property === "status" ? "observed" : Reflect.get(target, property, receiver);
        },
      }),
    },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const feature: ContainedTurnCapabilityBundle = Object.freeze({
        cancel: Object.freeze({ async execute() {return scenario.outcome as never;} }),
        observe: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
        submit: Object.freeze({
          async execute(input, options) {
            options?.onAccepted?.({ operationId: "operation:embedded", scope: input.scope });
            return { status: "observed", turn: turnView("running") } as const;
          },
        }),
      });
      const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
      assert.deepEqual(await host.bindAccess({ containedTurn: trustedScope }).containedTurn.submit({
        commandId: "command:admitted",
        expectedProvider: "codex",
        intent: { mode: "analysis", prompt: "synthetic cancellation proof" },
      }), { operationId: "operation:embedded", status: "accepted" });

      const error = await host.dispose().catch(failure => failure);

      assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
      assert.deepEqual(error.containedTurns, [{
        operationId: "operation:embedded",
        status: scenario.expectedStatus,
      }]);
      const turn = Object.getOwnPropertyDescriptor(scenario.outcome, "turn")?.value as
        | { operationIdReads?: number; outputReads?: number; statusReads?: number }
        | undefined;
      const operationIdReads = turn === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(turn, "operationIdReads")?.value;
      const statusReads = turn === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(turn, "statusReads")?.value;
      const outputReads = turn === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(turn, "outputReads")?.value;
      if (operationIdReads !== undefined) {
        assert.equal(operationIdReads, 1);
      }
      if (statusReads !== undefined) {
        assert.equal(statusReads, 1);
      }
      if (outputReads !== undefined) {
        assert.equal(outputReads, 1);
      }
      const serialized = JSON.stringify(error);
      for (const secret of [
        "owner-only throwing cancellation getter",
        "owner-only terminal artifact",
        "owner-only terminal output",
        "owner-only terminal result",
        "owner-only terminal revision",
        "owner-only-proxy-get-secret",
        "owner-only-proxy-prototype-secret",
      ]) {
        assert.equal(serialized.includes(secret), false);
      }
    });
  }
});

test("Embedded observation mapping rejects malformed owner DTO fields", async t => {
  const malformedTurns = [
    { ...turnView("running"), status: "complete" },
    { ...turnView("running"), output: [{ cursor: Number.NaN, kind: "assistant", text: "x" }] },
    { ...turnView("running"), operationId: "" },
    { ...turnView("running"), operationId: "operation:other" },
  ];
  for (const malformed of malformedTurns) {
    const feature: ContainedTurnCapabilityBundle = Object.freeze({
      cancel: Object.freeze({ async execute() {return { status: "not_found" } as const;} }),
      observe: Object.freeze({ async execute() {return { status: "observed", turn: malformed } as never;} }),
      submit: Object.freeze({ async execute() {return { status: "denied" } as const;} }),
    });
    const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
    t.after(() => host.dispose());
    const observation = host.bindAccess({ containedTurn: trustedScope }).containedTurn
      .observe("operation:embedded");
    if (malformed.status === "complete" || Number.isNaN(malformed.output?.[0]?.cursor)) {
      assert.deepEqual(await observation, { code: "capability_unavailable", status: "unsupported" });
    } else {
      await assert.rejects(observation, error => error instanceof ContainedTurnOwnerContractError &&
        (error.code === "invalid_operation_id" || error.code === "operation_id_mismatch"));
    }
  }
});
