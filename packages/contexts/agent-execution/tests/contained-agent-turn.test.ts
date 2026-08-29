import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createContainedTurnFeature,
  type AcceptContainedTurnCommandInput,
  type ContainedTurnArtifactPort,
  type ContainedTurnOperationStore,
  type ContainedTurnProviderExecutionOutcome,
  type ContainedTurnProviderPort,
  type ContainedTurnSecurityPort,
  type ContainedTurnWorkspacePort,
  type ProviderProcessCustodyPort,
} from "../dist/composition.js";
import {
  applyContainedTurnMutation,
  createAcceptedContainedTurnOperation,
  type ContainedTurnOperation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-operation.js";

const noop = (): void => {
  // Test gates replace this before it can be called.
};

const binding = Object.freeze({
  adapterRevision: "codex-app-server-adapter:test",
  binaryRevision: "codex:test",
  capabilityManifestRevision: "manifest:test",
  credentialBindingDigest: "credential:test",
  provider: "codex" as const,
  providerRouteRef: "route:test",
});

class MemoryOperationStore implements ContainedTurnOperationStore {
  readonly #byCommand = new Map<string, string>();
  readonly #operations = new Map<string, ContainedTurnOperation>();
  #sequence = 0;

  async accept(input: AcceptContainedTurnCommandInput) {
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existingId = this.#byCommand.get(input.commandId);
    if (existingId !== undefined) {
      const operation = this.#operations.get(existingId);
      assert.ok(operation);
      return operation.commandFingerprint === fingerprint
        ? { kind: "replayed" as const, operation }
        : { kind: "conflict" as const };
    }
    const sequence = ++this.#sequence;
    const operation = createAcceptedContainedTurnOperation({
      acceptanceReceiptRef: `accept:${sequence}`,
      commandFingerprint: fingerprint,
      commandId: input.commandId,
      effectId: `effect:${sequence}`,
      intent: input.intent,
      operationId: `operation:${sequence}`,
      providerBinding: input.providerBinding,
      scope: input.scope,
      securityDecision: input.securityDecision,
    });
    this.#byCommand.set(input.commandId, operation.operationId);
    this.#operations.set(operation.operationId, operation);
    return { kind: "accepted" as const, operation };
  }

  async claimDispatch(input: { readonly cutoffReceiptRef: string; readonly expectedRevision: number; readonly operationId: string }) {
    const current = this.#operations.get(input.operationId);
    if (current === undefined) {return { kind: "not_found" as const };}
    if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
    const operation = applyContainedTurnMutation(current, {
      attemptId: `attempt:${current.operationId}`,
      claimRef: `claim:${current.operationId}`,
      cutoffReceiptRef: input.cutoffReceiptRef,
      kind: "dispatch_claimed",
    });
    this.#operations.set(operation.operationId, operation);
    return { kind: "claimed" as const, operation };
  }

  async compareAndSet(input: {
    readonly expectedRevision: number;
    readonly mutation: Parameters<typeof applyContainedTurnMutation>[1];
    readonly operationId: string;
  }) {
    const current = this.#operations.get(input.operationId);
    if (current === undefined) {return { kind: "not_found" as const };}
    if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
    const operation = applyContainedTurnMutation(current, input.mutation);
    this.#operations.set(operation.operationId, operation);
    return { kind: "applied" as const, operation };
  }

  async preventDispatch(input: { readonly expectedRevision: number; readonly operationId: string; readonly proofRef: string }) {
    return this.compareAndSet({
      expectedRevision: input.expectedRevision,
      mutation: { kind: "dispatch_prevented", receiptRef: input.proofRef },
      operationId: input.operationId,
    });
  }

  async read(operationId: string) {
    return this.#operations.get(operationId);
  }

  async requestCancellation(input: { readonly expectedRevision: number; readonly operationId: string }) {
    return this.compareAndSet({
      expectedRevision: input.expectedRevision,
      mutation: { kind: "cancellation_requested", requestRef: `cancel:${input.operationId}` },
      operationId: input.operationId,
    });
  }

  async terminalize(input: { readonly expectedRevision: number; readonly operationId: string }) {
    return this.compareAndSet({
      expectedRevision: input.expectedRevision,
      mutation: { kind: "terminalize", receiptRef: `terminal:${input.operationId}` },
      operationId: input.operationId,
    });
  }
}

interface HarnessOptions {
  readonly custodyOpen?: ProviderProcessCustodyPort["open"];
  readonly execution?: (
    input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  ) => Promise<ContainedTurnProviderExecutionOutcome>;
  readonly revalidate?: ContainedTurnSecurityPort["revalidate"];
  readonly seal?: ContainedTurnArtifactPort["seal"];
  readonly workspaceCreate?: ContainedTurnWorkspacePort["create"];
}

const createHarness = (options: HarnessOptions = {}) => {
  const store = new MemoryOperationStore();
  const counters = { contain: 0, execute: 0, open: 0, quarantine: 0 };
  const security: ContainedTurnSecurityPort = {
    async authorize() {
      return { authorityRevision: "authority:1", decisionDigest: "decision:1", kind: "allowed" };
    },
    revalidate: options.revalidate ?? (async () => ({ kind: "allowed", proofRef: "cutoff-clear:1" })),
  };
  const workspace: ContainedTurnWorkspacePort = {
    async close(workspaceRef) {
      return { receiptRef: `workspace-closed:${workspaceRef}` };
    },
    create: options.workspaceCreate ?? (async input => {
      return { workspaceRef: `workspace:${input.operationId}` };
    }),
    async quarantine() {
      counters.quarantine += 1;
    },
  };
  const artifacts: ContainedTurnArtifactPort = {
    seal: options.seal ?? (async input => {
      return {
        manifestReceiptRef: `manifest-receipt:${input.operationId}`,
        manifestRef: `manifest:${input.operationId}`,
        resultReceiptRef: `result-receipt:${input.operationId}`,
        resultRef: `result:${input.operationId}`,
      };
    }),
  };
  const custody: ProviderProcessCustodyPort = {
    open: options.custodyOpen ?? (async input => {
      counters.open += 1;
      return { custodyRef: `custody:${input.attemptId}` };
    }),
    async requestContainment(input) {
      counters.contain += 1;
      return { kind: "contained", receiptRef: `contained:${input.attemptId}` };
    },
  };
  const provider: ContainedTurnProviderPort = {
    manifest: Object.freeze({
      effectClass: "contained_unmediated_effect",
      providerBinding: binding,
      supportedModes: Object.freeze(["analysis", "workspace-write"]),
    }),
    async execute(input) {
      counters.execute += 1;
      if (options.execution !== undefined) {return options.execution(input);}
      await input.emit({ cursor: 0, kind: "assistant", text: "synthetic result" });
      return {
        acceptanceReceiptRef: `accepted:${input.attemptId}`,
        effectDisposition: "committed",
        effectReceiptRef: `effect:${input.attemptId}`,
        executionReceiptRef: `execution:${input.attemptId}`,
        kind: "completed",
        outcome: "succeeded",
        outputDrainReceiptRef: `drain:${input.attemptId}`,
      };
    },
  };
  const dependencies = { artifacts, custody, operationStore: store, provider, security, workspace };
  return { counters, dependencies, feature: createContainedTurnFeature(dependencies), store };
};

const input = (commandId = "command:1", prompt = "inspect the disposable workspace") => ({
  commandId,
  expectedProvider: "codex" as const,
  intent: { mode: "analysis" as const, prompt },
  scope: { projectId: "project:test", tenantId: "tenant:test" },
});

test("completes one contained turn with complete immutable receipt closure", async () => {
  const harness = createHarness();
  const outcome = await harness.feature.submit.execute(input());
  assert.equal(outcome.status, "observed");
  if (outcome.status !== "observed") {return;}
  assert.equal(outcome.turn.status, "succeeded");
  assert.equal(outcome.turn.output[0]?.text, "synthetic result");
  const operation = await harness.store.read(outcome.turn.operationId);
  assert.equal(operation?.receipts.length, 12);
  assert.equal(operation?.terminal.kind, "terminal");
  assert.deepEqual(harness.counters, { contain: 1, execute: 1, open: 1, quarantine: 0 });
});

test("replays an identical command without a second provider attempt and rejects changed intent", async () => {
  const harness = createHarness();
  const first = await harness.feature.submit.execute(input());
  const replay = await harness.feature.submit.execute(input());
  const conflict = await harness.feature.submit.execute(input("command:1", "different prompt"));
  assert.equal(first.status, "observed");
  assert.equal(replay.status, "observed");
  assert.deepEqual(conflict, { code: "command_fingerprint_conflict", status: "conflict" });
  assert.equal(harness.counters.execute, 1);
});

test("pre-dispatch guard produces a proved no-start terminal result", async () => {
  const harness = createHarness({
    revalidate: async () => ({ kind: "prevented", proofRef: "cutoff:1" }),
  });
  const outcome = await harness.feature.submit.execute(input());
  assert.equal(outcome.status, "observed");
  if (outcome.status !== "observed") {return;}
  assert.equal(outcome.turn.status, "failed");
  assert.equal(harness.counters.execute, 0);
  assert.equal(harness.counters.open, 0);
});

test("durable cancellation wins a race before dispatch claim", async () => {
  let releaseGuard = noop;
  const guard = new Promise<void>(resolve => {
    releaseGuard = resolve;
  });
  const harness = createHarness({
    revalidate: async () => {
      await guard;
      return { kind: "allowed", proofRef: "cutoff-clear:race" };
    },
  });
  const submission = harness.feature.submit.execute(input());
  let operation: ContainedTurnOperation | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const accepted = await harness.store.read("operation:1");
    if (accepted?.workspace.kind === "bound") {
      operation = accepted;
      break;
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 1);
    });
  }
  assert.ok(operation);
  const cancelled = await harness.feature.cancel.execute(operation.operationId);
  assert.equal(cancelled.status, "observed");
  releaseGuard();
  const outcome = await submission;
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "cancelled");}
  assert.equal(harness.counters.execute, 0);
});

test("only one concurrent dispatch claim can win", async () => {
  const store = new MemoryOperationStore();
  const accepted = await store.accept({
    commandId: "command:claim-race",
    intent: { mode: "analysis", prompt: "synthetic" },
    providerBinding: binding,
    scope: { projectId: "project:test", tenantId: "tenant:test" },
    securityDecision: { authorityRevision: "authority:1", decisionDigest: "decision:1" },
  });
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") {return;}
  const bound = await store.compareAndSet({
    expectedRevision: accepted.operation.revision,
    mutation: { kind: "workspace_bound", workspaceRef: "workspace:claim-race" },
    operationId: accepted.operation.operationId,
  });
  assert.equal(bound.kind, "applied");
  if (bound.kind !== "applied") {return;}
  const outcomes = await Promise.all([
    store.claimDispatch({ cutoffReceiptRef: "cutoff-clear:race", expectedRevision: bound.operation.revision, operationId: bound.operation.operationId }),
    store.claimDispatch({ cutoffReceiptRef: "cutoff-clear:race", expectedRevision: bound.operation.revision, operationId: bound.operation.operationId }),
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.kind).toSorted(), ["claimed", "stale"]);
  assert.equal((await store.read(bound.operation.operationId))?.dispatch.kind, "claimed");
});

test("terminal compare-and-set rejects incomplete receipt closure", async () => {
  const store = new MemoryOperationStore();
  const accepted = await store.accept({
    commandId: "command:incomplete",
    intent: { mode: "analysis", prompt: "synthetic" },
    providerBinding: binding,
    scope: { projectId: "project:test", tenantId: "tenant:test" },
    securityDecision: { authorityRevision: "authority:1", decisionDigest: "decision:1" },
  });
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") {return;}
  await assert.rejects(
    store.terminalize({
      expectedRevision: accepted.operation.revision,
      operationId: accepted.operation.operationId,
    }),
    /terminalization requires exact dispatch closure/,
  );
});

test("durable cancellation after claim requests containment without a second attempt", async () => {
  let releaseProvider = noop;
  const providerGate = new Promise<void>(resolve => {
    releaseProvider = resolve;
  });
  const harness = createHarness({
    execution: async providerInput => {
      await providerGate;
      assert.equal(await providerInput.isCancellationRequested(), true);
      await providerInput.emit({ cursor: 0, kind: "assistant", text: "cancelled safely" });
      return {
        acceptanceReceiptRef: "accepted:cancelled",
        effectDisposition: "committed",
        effectReceiptRef: "effect:cancelled",
        executionReceiptRef: "execution:cancelled",
        kind: "completed",
        outcome: "cancelled",
        outputDrainReceiptRef: "drain:cancelled",
      };
    },
  });
  const submission = harness.feature.submit.execute(input());
  let running: ContainedTurnOperation | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await harness.store.read("operation:1");
    if (operation?.execution.kind === "running") {
      running = operation;
      break;
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 1);
    });
  }
  assert.ok(running);
  const cancellation = await harness.feature.cancel.execute(running.operationId);
  assert.equal(cancellation.status, "observed");
  assert.equal(harness.counters.contain, 0);
  releaseProvider();
  const outcome = await submission;
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "cancelled");}
  assert.equal(harness.counters.execute, 1);
});

test("cancellation while custody opens closes without invoking the provider", async () => {
  let releaseCustody = noop;
  const custodyGate = new Promise<void>(resolve => {
    releaseCustody = resolve;
  });
  const harness = createHarness({
    custodyOpen: async custodyInput => {
      await custodyGate;
      return { custodyRef: `custody:${custodyInput.attemptId}` };
    },
  });
  const submission = harness.feature.submit.execute(input());
  let claimed: ContainedTurnOperation | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await harness.store.read("operation:1");
    if (operation?.dispatch.kind === "claimed") {
      claimed = operation;
      break;
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 1);
    });
  }
  assert.ok(claimed);
  await harness.feature.cancel.execute(claimed.operationId);
  releaseCustody();
  const outcome = await submission;
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "cancelled");}
  assert.equal(harness.counters.execute, 0);
});

test("an ambiguous provider result is quarantined and never retried or terminalized", async () => {
  const harness = createHarness({
    execution: async () => ({ evidenceRef: "provider:ambiguous", kind: "ambiguous" }),
  });
  const outcome = await harness.feature.submit.execute(input());
  assert.equal(outcome.status, "observed");
  if (outcome.status !== "observed") {return;}
  assert.equal(outcome.turn.status, "reconcile_required");
  const operation = await harness.store.read(outcome.turn.operationId);
  assert.equal(operation?.terminal.kind, "nonterminal");
  assert.equal(operation?.workspace.kind, "quarantined");
  assert.equal(harness.counters.execute, 1);
  assert.equal(harness.counters.quarantine, 1);
});

test("a post-provider closure failure records reconciliation debt before quarantine", async () => {
  const harness = createHarness({
    seal: async () => {
      throw new Error("synthetic artifact failure");
    },
  });
  const outcome = await harness.feature.submit.execute(input());
  assert.equal(outcome.status, "observed");
  if (outcome.status !== "observed") {return;}
  assert.equal(outcome.turn.status, "reconcile_required");
  const operation = await harness.store.read(outcome.turn.operationId);
  assert.equal(operation?.effect.kind, "resolved");
  assert.equal(operation?.reconciliation.kind, "required");
  assert.equal(operation?.terminal.kind, "nonterminal");
  assert.equal(harness.counters.execute, 1);
  assert.equal(harness.counters.quarantine, 1);
});

test("a workspace creation failure remains a durable reconciliation obligation", async () => {
  const harness = createHarness({
    workspaceCreate: async () => {
      throw new Error("synthetic workspace failure");
    },
  });
  const outcome = await harness.feature.submit.execute(input());
  assert.equal(outcome.status, "observed");
  if (outcome.status !== "observed") {return;}
  assert.equal(outcome.turn.status, "reconcile_required");
  const operation = await harness.store.read(outcome.turn.operationId);
  assert.equal(operation?.workspace.kind, "unbound");
  assert.equal(operation?.reconciliation.kind, "required");
  assert.equal(harness.counters.execute, 0);
});

test("rejects stale or reordered provider output as ambiguity", async () => {
  const harness = createHarness({
    execution: async providerInput => {
      await providerInput.emit({ cursor: 1, kind: "assistant", text: "out of order" });
      throw new Error("unreachable");
    },
  });
  const outcome = await harness.feature.submit.execute(input());
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(harness.counters.execute, 1);
});

test("caller AbortSignal is local and cannot manufacture durable cancellation", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(harness.feature.submit.execute(input(), { signal: controller.signal }), { name: "AbortError" });
  assert.equal(await harness.store.read("operation:1"), undefined);
});

test("factory snapshots exactly six dependencies and imports no module runtime", async () => {
  const harness = createHarness();
  const reads = new Map<string, number>();
  const proxied = new Proxy(harness.dependencies, {
    get(target, property, receiver) {
      const key = String(property);
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return Reflect.get(target, property, receiver);
    },
  });
  createContainedTurnFeature(proxied);
  assert.deepEqual([...reads.keys()].toSorted(), ["artifacts", "custody", "operationStore", "provider", "security", "workspace"]);
  assert.ok([...reads.values()].every(count => count === 1));
  const source = await readFile(new URL("../src/features/contained-agent-turn/composition/feature-module-factory.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /module-kit|container|registry|service.locator/i);
});
