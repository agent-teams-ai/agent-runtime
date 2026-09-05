import { createAgentRuntimeHost } from "./helpers/create-contained-turn-host.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createContainedTurnFeature } from "@agent-teams/agent-execution/composition";
import { recoverContainedTurnDispatchPreparations } from "../../../contexts/agent-execution/dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import { containedTurnIdentity } from "../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createDependencies, proofId } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

import {
  AgentRuntimeHostDisposalIncompleteError,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";
import type { ContainedTurnCapabilityBundle } from "../dist/composition.js";

type ContainedTurnStatus = "accepted" | "cancelled" | "failed" | "reconcile_required" | "running" | "succeeded";
type DisposalCancellationOutcome = ContainedTurnStatus | "mismatch" | "not_found" | "reject";

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

const trustedScope = Object.freeze({ projectId: "project:embedded", tenantId: "tenant:embedded" });

for (const target of ["custody", "provider_access", "runtime_security"] as const) {
  test(`prevented dispatch retains Host tracking while ${target} cleanup is indeterminate`, async () => {
    const cleanupScope = Object.freeze({ projectId: "project:one", tenantId: "tenant:one" });
    const fixture = createDependencies({ dispatchPrevented: target !== "provider_access" });
    const { dependencies, current, providerCalls, custodyStartInputs } = fixture;
    const evidenceId = containedTurnIdentity("evidence", `evidence:cleanup-indeterminate:${target}`);
    let cleanupProved = false;
    let cleanupCalls = 0;
    const indeterminate = async () => {
      cleanupCalls += 1;
      return { evidenceId, kind: "indeterminate" as const };
    };
    const configured = {
      ...dependencies,
      custody: {
        ...dependencies.custody,
        releaseRetiredReservation: input => target === "custody" && !cleanupProved
          ? indeterminate() : dependencies.custody.releaseRetiredReservation(input),
      },
      providerAccess: {
        ...dependencies.providerAccess,
        settleConsumedGrant: input => target === "provider_access" && !cleanupProved
          ? indeterminate() : dependencies.providerAccess.settleConsumedGrant(input),
      },
      security: {
        ...dependencies.security,
        consumeForDispatch: input => target === "provider_access"
          ? Promise.resolve({ kind: "prevented" as const, preventionProofId: proofId("security-prevention") })
          : dependencies.security.consumeForDispatch(input),
        settleConsumedGrant: input => target === "runtime_security" && !cleanupProved
          ? indeterminate() : dependencies.security.settleConsumedGrant(input),
      },
    } satisfies typeof dependencies;
    const feature = createContainedTurnFeature(configured);
    let complete!: () => void;
    const completed = new Promise<void>(resolve => {complete = resolve;});
    const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: {
      ...feature,
      submit: { async execute(input, options) {
        try {return await feature.submit.execute(input, options);} finally {complete();}
      } },
    } });
    const access = host.bindAccess({ containedTurn: cleanupScope });
    const submission = {
      commandId: "command:one", expectedProvider: "codex" as const,
      intent: { mode: "analysis" as const, prompt: "synthetic prevented cleanup" },
    };
    const accepted = await access.containedTurn.submit(submission);
    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") {assert.fail("missing accepted handle");}
    await completed;
    await new Promise<void>(resolve => {setImmediate(resolve);});
    const observed = await access.containedTurn.observe(accepted.operationId);
    assert.equal(observed.status, "observed");
    if (observed.status !== "observed") {assert.fail("missing operation");}
    assert.equal(observed.turn.status, "reconcile_required");
    assert.equal(current()?.terminal.kind, "open");
    assert.equal(current()?.reconciliation.kind, "required");
    assert.equal(current()?.operationCutoff.kind, "closed");
    const pending = await dependencies.operationStore.listDispatchPreparations?.({ scope: cleanupScope });
    assert.equal(pending?.length, 1);
    const preparation = pending?.[0]?.preparation;
    if (preparation?.kind !== "cleanup_pending") {assert.fail("cleanup must remain recoverable");}
    assert.equal(preparation.custodyReleased, target !== "custody");
    assert.equal(preparation.providerAccessNotConsumed, target !== "provider_access");
    assert.equal(preparation.providerAccessSettled, false);
    assert.equal(preparation.runtimeSecurityNotConsumed, target === "provider_access");
    assert.equal(preparation.runtimeSecuritySettled, target === "custody");
    assert.ok(preparation.cleanupEvidenceIds.includes(evidenceId));
    assert.equal(cleanupCalls, 1, "cleanup must not be blindly retried");
    await assert.rejects(host.dispose(), error => {
      assert.ok(error instanceof AgentRuntimeHostDisposalIncompleteError);
      assert.deepEqual(error.containedTurns, [{ operationId: accepted.operationId, status: "reconcile_required" }]);
      return true;
    });
    assert.equal(current()?.terminal.kind, "open", "Host cancellation cannot erase cleanup debt");
    assert.equal((await dependencies.operationStore.listDispatchPreparations?.({ scope: cleanupScope }))?.length, 1);
    cleanupProved = true;
    assert.deepEqual(await recoverContainedTurnDispatchPreparations(configured, cleanupScope), { discovered: 1, retired: 0 });
    assert.equal((await dependencies.operationStore.listDispatchPreparations?.({ scope: cleanupScope }))?.length, 0);
    assert.equal(current()?.terminal.kind, "open", "preparation recovery alone is not terminal authority");
    assert.equal(custodyStartInputs.length, 0);
    assert.equal(providerCalls.value, 0);
  });
}

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

const submitDisposalTurn = async (feature: ContainedTurnCapabilityBundle) => {
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

test("Host disposal bounds deterministic diagnostics without truncating nonterminal custody", async () => {
  const operationIds = Array.from(
    { length: 70 },
    (_, index) => `operation:bounded:${String(index).padStart(3, "0")}`,
  ).toReversed();
  const scopeSecret = "project:diagnostic-secret";
  const promptSecret = "prompt:diagnostic-secret";
  let nextOperation = 0;
  const cancellationCalls: string[] = [];
  const view = (operationId: string) => Object.freeze({
    ...turnView("running"),
    commandId: `command:${operationId}`,
    effectId: `effect:${operationId}`,
    operationId,
  });
  const feature: ContainedTurnCapabilityBundle = Object.freeze({
    cancel: Object.freeze({
      async execute(operation) {
        cancellationCalls.push(operation.operationId);
        return { status: "observed", turn: view(operation.operationId) } as const;
      },
    }),
    observe: Object.freeze({
      async execute(operation) {
        return { status: "observed", turn: view(operation.operationId) } as const;
      },
    }),
    submit: Object.freeze({
      async execute(input, options) {
        const operationId = operationIds[nextOperation++]!;
        options?.onAccepted?.(Object.freeze({ operationId, scope: input.scope }));
        return { status: "observed", turn: view(operationId) } as const;
      },
    }),
  });
  const host = createAgentRuntimeHost({ ...setupDependencies, containedTurn: feature });
  const access = host.bindAccess({
    containedTurn: Object.freeze({ projectId: scopeSecret, tenantId: "tenant:diagnostic-secret" }),
  });
  for (const index of operationIds.keys()) {
    await access.containedTurn.submit({
      commandId: `command:bounded:${index}`,
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: promptSecret },
    });
  }
  await new Promise<void>(resolve => {setImmediate(resolve);});

  const firstDisposal = host.dispose();
  assert.equal(host.dispose(), firstDisposal);
  const error = await firstDisposal.catch(failure => failure);
  assert.equal(error instanceof AgentRuntimeHostDisposalIncompleteError, true);
  if (!(error instanceof AgentRuntimeHostDisposalIncompleteError)) {
    return;
  }
  assert.deepEqual(
    error.containedTurns.map(issue => issue.operationId),
    operationIds.toSorted().slice(0, 64),
  );
  assert.equal(error.containedTurns.length, 64);
  assert.equal(error.omittedContainedTurnCount, 6);
  assert.equal(cancellationCalls.length, operationIds.length);
  assert.deepEqual(cancellationCalls.toSorted(), operationIds.toSorted());
  assert.equal(JSON.stringify(error).includes(scopeSecret), false);
  assert.equal(JSON.stringify(error).includes(promptSecret), false);
  await assert.rejects(host.dispose(), failure => failure === error);
});

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

test("Host retains crossed operation IDs until terminal cancellation evidence closes custody", async () => {
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

  await host.dispose();
  assert.deepEqual(cancellationCalls, ["operation:callback"]);
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
