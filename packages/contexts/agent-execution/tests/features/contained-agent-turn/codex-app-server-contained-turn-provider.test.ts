import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexAppServerContainedTurnProvider,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import { agentMessage, commandExecution, emitAgentCompleted, emitAgentStarted, emitTurnStarted, generatedTurn } from "../../codex-app-server-test-messages.mjs";
import {
  FakeCodexProcess,
  boundary,
  completedProcess,
  completedReceiptRefs,
  createProvider,
  exactConfigResult,
  executeInput,
  expectedCompletedReceipt,
  manifest,
  rejectInitialize,
  standardHandshake,
  syntheticTmp,
  syntheticWorkspace,
  type Message,
} from "../../codex-app-server-contained-turn-provider-fixture.ts";

const executeWithRegistryFailure = async (privateText: string) => {
  const process = completedProcess();
  const provider = new CodexAppServerContainedTurnProvider({
    boundary, manifest, processes: { get() {throw new Error(privateText);} }, tmpDir: syntheticTmp,
  });
  return provider.execute(executeInput(process));
};

const executeWithStdout = async (
  privateText: string,
  install: (process: FakeCodexProcess, privateText: string) => void,
) => {
  const process = completedProcess();
  install(process, privateText);
  return createProvider(process).execute(executeInput(process));
};

test("maps one exact Codex App Server turn to provider-neutral receipts", async () => {
  const output: string[] = [];
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:test", "inProgress") } });
      emitTurnStarted(target, "turn:test");
      emitAgentStarted(target, "turn:test", "item:test");
      target.emit({ method: "item/agentMessage/delta", params: { delta: "contained", itemId: "item:test", threadId: "thread:test", turnId: "turn:test" } });
      emitAgentCompleted(target, "turn:test", "item:test", "contained");
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:test", "completed", null, [agentMessage("item:test", "contained")]) } });
    }
  });
  const provider = createProvider(process);
  const outcome = await provider.execute({
    ...executeInput(process),
    emit: async chunk => {output.push(chunk.text);},
  });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "succeeded");}
  assert.deepEqual(output, ["contained"]);
  assert.equal(process.closeCount, 1);
  const threadStart = process.requests.find(message => message.method === "thread/start");
  assert.ok(threadStart);
  assert.deepEqual((threadStart.params as Message).config, {
    features: {
      apps: false,
      browser_use: false,
      computer_use: false,
      image_generation: false,
      multi_agent: false,
      multi_agent_v2: false,
      plugins: false,
      remote_plugin: false,
    },
  });
  assert.equal((threadStart.params as Message).sandbox, "read-only");
  const turnStart = process.requests.find(message => message.method === "turn/start");
  assert.ok(turnStart);
  assert.deepEqual((turnStart.params as Message).sandboxPolicy, { networkAccess: false, type: "readOnly" });
});
test("binds completed receipts to operation, effect, attempt, and the exact Codex implementation tuple", async () => {
  const identity = { attemptId: "attempt:receipt", effectId: "effect:receipt", operationId: "operation:receipt" };
  const firstProcess = completedProcess();
  const first = completedReceiptRefs(await createProvider(firstProcess).execute({ ...executeInput(firstProcess), ...identity }));
  assert.deepEqual(first, [expectedCompletedReceipt("codex-provider-accepted", identity),
    expectedCompletedReceipt("codex-effect-resolved", identity), expectedCompletedReceipt("codex-execution-closed", identity),
    expectedCompletedReceipt("codex-output-drained", identity)]);
  const identicalProcess = completedProcess();
  const identical = completedReceiptRefs(await createProvider(identicalProcess).execute({
    ...executeInput(identicalProcess), ...identity,
  }));
  assert.deepEqual(identical, first);
  for (const changed of [{ ...identity, operationId: "operation:other" },
    { ...identity, effectId: "effect:other" }, { ...identity, attemptId: "attempt:other" }]) {
    const process = completedProcess();
    const refs = completedReceiptRefs(await createProvider(process).execute({ ...executeInput(process), ...changed }));
    for (let index = 0; index < first.length; index += 1) {assert.notEqual(refs[index], first[index]);}
  }
});
test("deep-detaches receipt identity and rejects accessor or Proxy authority", async () => {
  const process = completedProcess();
  const mutable = { ...executeInput(process),
    attemptId: "attempt:detached", effectId: "effect:detached", operationId: "operation:detached" };
  const pending = createProvider(process).execute(mutable); mutable.attemptId = "attempt:mutated";
  mutable.effectId = "effect:mutated"; mutable.operationId = "operation:mutated";
  assert.equal(completedReceiptRefs(await pending)[0], expectedCompletedReceipt("codex-provider-accepted",
    { attemptId: "attempt:detached", effectId: "effect:detached", operationId: "operation:detached" }));
  let getterReads = 0; const accessorInput = { ...executeInput(completedProcess()) };
  Object.defineProperty(accessorInput, "operationId", { enumerable: true, get() {getterReads += 1; return "operation:accessor";} });
  await assert.rejects(createProvider(completedProcess()).execute(accessorInput), /own data property/u); assert.equal(getterReads, 0);
  const proxyProcess = completedProcess(); await assert.rejects(createProvider(proxyProcess)
    .execute(new Proxy(executeInput(proxyProcess), {})), /must not be a Proxy/u);
  assert.throws(() => new CodexAppServerContainedTurnProvider({ boundary, manifest: new Proxy(manifest, {}), processes: { get() {} }, tmpDir: syntheticTmp }), /must not be a Proxy/u);
});
test("snapshots exact constructor authority once from plain own data descriptors", async () => {
  const process = completedProcess();
  let originalGet: (custodyRef: string) => FakeCodexProcess | undefined;
  const registry = { get(custodyRef: string) {
    if (this.get !== originalGet) {throw new Error("private mutated registry receiver");}
    if (custodyRef === process.custodyRef) {return process;}
  } };
  originalGet = registry.get;
  const options = { boundary, manifest, processes: registry, tmpDir: syntheticTmp };
  const provider = new CodexAppServerContainedTurnProvider(options);
  registry.get = () => {throw new Error("caller mutated registry");};
  options.tmpDir = "/caller/mutated/tmp";
  assert.equal((await provider.execute(executeInput(process))).kind, "completed");

  let reads = 0;
  const accessorOptions = { boundary, manifest, processes: registry } as Record<string, unknown>;
  Object.defineProperty(accessorOptions, "tmpDir", { enumerable: true, get() {reads += 1; return syntheticTmp;} });
  assert.throws(() => new CodexAppServerContainedTurnProvider(accessorOptions as never), /own data property/u);
  assert.equal(reads, 0);
  assert.throws(() => new CodexAppServerContainedTurnProvider(new Proxy(options, {})), /non-Proxy plain record/u);
  assert.throws(() => new CodexAppServerContainedTurnProvider({ ...options, unknownAuthority: true } as never), /unknown keys/u);

  const accessorBoundary = { ...boundary } as Record<string, unknown>;
  Object.defineProperty(accessorBoundary, "workspaceRef", { enumerable: true, get() {reads += 1; return boundary.workspaceRef;} });
  assert.throws(() => new CodexAppServerContainedTurnProvider({ ...options, boundary: accessorBoundary } as never), /own data property/u);
  assert.equal(reads, 0);

  const modes = ["analysis", "workspace-write"] as unknown[];
  Object.defineProperty(modes, "0", { enumerable: true, get() {reads += 1; return "analysis";} });
  assert.throws(() => new CodexAppServerContainedTurnProvider({ ...options, manifest: { ...manifest, supportedModes: modes } } as never), /own data property/u);
  assert.equal(reads, 0);
  const aggregateModes = ["analysis", "workspace-write"] as unknown[] & { authority?: string };
  aggregateModes.authority = "hidden";
  assert.throws(() => new CodexAppServerContainedTurnProvider({ ...options,
    manifest: { ...manifest, supportedModes: aggregateModes } } as never), /aggregate properties/u);

  const accessorBinding = { ...manifest.providerBinding } as Record<string, unknown>;
  Object.defineProperty(accessorBinding, "binaryRevision", { enumerable: true, get() {reads += 1; return "substituted";} });
  assert.throws(() => new CodexAppServerContainedTurnProvider({ ...options,
    manifest: { ...manifest, providerBinding: accessorBinding } } as never), /own data property/u);
  assert.equal(reads, 0);
  const accessorRegistry = {} as Record<string, unknown>;
  Object.defineProperty(accessorRegistry, "get", { enumerable: true, get() {reads += 1; return () => process;} });
  assert.throws(() => new CodexAppServerContainedTurnProvider({ ...options, processes: accessorRegistry } as never), /own data property/u);
  assert.equal(reads, 0);
});
test("redacts registry and stdout acquisition failures before protocol setup", async () => {
  const registryOutcomes = await Promise.all([
    executeWithRegistryFailure("PRIVATE_REGISTRY_ALPHA"),
    executeWithRegistryFailure("PRIVATE_REGISTRY_BRAVO"),
  ]);
  assert.equal(JSON.stringify(registryOutcomes[0]), JSON.stringify(registryOutcomes[1]));
  assertContainmentRequired(registryOutcomes[0]);

  const cases = [
    (process: FakeCodexProcess, privateText: string) => {
      Object.defineProperty(process, "stdout", { configurable: true, get() {throw new Error(privateText);} });
    },
    (process: FakeCodexProcess, privateText: string) => {
      Object.defineProperty(process, "stdout", { configurable: true, value: {
        [Symbol.asyncIterator]() {throw new Error(privateText);},
      } });
    },
    (process: FakeCodexProcess, privateText: string) => {
      Object.defineProperty(process, "stdout", { configurable: true, value: {
        [Symbol.asyncIterator]() {return { next() {throw new Error(privateText);} };},
      } });
    },
  ];
  for (const [index, install] of cases.entries()) {
    const privateText = `PRIVATE_STDOUT_${index}`;
    const outcome = await executeWithStdout(privateText, install);
    assertContainmentRequired(outcome);
    assert.equal(JSON.stringify(outcome).includes(privateText), false);
  }
});
test("observes durable cancellation and interrupts the exact Codex turn", async () => {
  let cancellationChecks = 0;
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:cancel", "inProgress") } });
      emitTurnStarted(target, "turn:cancel");
    }
    if (message.method === "turn/interrupt") {
      target.emit({ id: message.id, result: {} });
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:cancel", "interrupted") } });
    }
  });
  const outcome = await createProvider(process).execute(executeInput(process, async () => {
    cancellationChecks += 1;
    return true;
  }));
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "cancelled");
    assert.equal(outcome.acceptanceReceiptRef, expectedCompletedReceipt("codex-provider-accepted", {
      attemptId: "attempt:test", effectId: "effect:test", operationId: "operation:test",
    }, "interrupted"));
  }
  assert.ok(cancellationChecks >= 1);
  const interrupt = process.requests.find(message => message.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "thread:test", turnId: "turn:cancel" });
});
test("requires containment reconciliation after an explicit post-dispatch turn rejection", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ error: { code: -32_000, message: "synthetic rejection" }, id: message.id });
    }
  });
  const outcome = await createProvider(process).execute(executeInput(process));
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
});
test("emits a fixed typed Codex terminal diagnostic", async () => {
  const adversarialValues = [
    "access-token-secret",
    "Authorization: Bearer access-token-secret",
    boundary.codexHome,
    syntheticWorkspace,
    '{"command":"tool --secret raw-tool-argument"}',
    "raw provider stdout and stderr",
  ];
  const sensitiveDiagnostic = adversarialValues.join("\n");
  const output: { readonly kind: string; readonly text: string }[] = [];
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:failed", "inProgress") } });
      emitTurnStarted(target, "turn:failed");
      target.emit({
        method: "turn/completed",
        params: {
          threadId: "thread:test",
          turn: generatedTurn("turn:failed", "failed", {
            additionalDetails: null,
            codexErrorInfo: null,
            message: sensitiveDiagnostic,
          }),
        },
      });
    }
  });
  const outcome = await createProvider(process).execute({
    ...executeInput(process),
    emit: async chunk => {output.push(chunk);},
  });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.acceptanceReceiptRef, expectedCompletedReceipt("codex-provider-accepted", {
      attemptId: "attempt:test", effectId: "effect:test", operationId: "operation:test",
    }, "failed"));
  }
  assert.equal(output.length, 1);
  assert.equal(output[0]?.kind, "diagnostic");
  assert.equal(output[0]?.text, "codex-provider-terminal-failure-redacted/v1");
  const evidence = JSON.stringify({ outcome, output });
  for (const value of adversarialValues) {assert.equal(evidence.includes(value), false);}
});
test("fails ambiguous after dispatch for approval requests, malformed output, and missing custody", async () => {
  const approvalProcess = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:approval", "inProgress") } });
      emitTurnStarted(target, "turn:approval");
      target.emit({ id: "server:approval", method: "item/commandExecution/requestApproval", params: {} });
    }
  });
  assert.deepEqual((await createProvider(approvalProcess).execute(executeInput(approvalProcess))).kind, "ambiguous");
  const malformedProcess = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:malformed", "inProgress") } });
      emitTurnStarted(target, "turn:malformed");
      target.stdout.push(Buffer.from("not-json\n", "utf8"));
    }
  });
  assert.deepEqual((await createProvider(malformedProcess).execute(executeInput(malformedProcess))).kind, "ambiguous");
  const missing = new CodexAppServerContainedTurnProvider({
    boundary, manifest, processes: { get() {} }, tmpDir: syntheticTmp,
  });
  assert.deepEqual((await missing.execute(executeInput(malformedProcess))).kind, "ambiguous");
});
test("fails before turn bytes when initialize reports the wrong private Codex home", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (message.method === "initialize") {
      target.emit({
        id: message.id,
        result: { codexHome: "/synthetic/substituted-home", platformFamily: "unix", platformOs: "linux", userAgent: "codex/0.150.1" },
      });
    }
  });
  assert.equal((await createProvider(process).execute(executeInput(process))).kind, "not_accepted");
  assert.equal(process.requests.some(message => message.method === "turn/start"), false);
  assert.equal(process.closeCount, 1);
});
test("fails before turn bytes for absent, disallowed, or wrong permission profiles", async () => {
  const variants = [
    [] as Message[],
    [{ allowed: false, description: null, id: boundary.permissionProfileId }],
    [{ allowed: true, id: boundary.permissionProfileId }],
    [{ allowed: true, description: null, id: boundary.permissionProfileId, substituted: true }],
    [{ allowed: true, description: null, id: "substituted-profile" }],
  ];
  for (const data of variants) {
    const process = new FakeCodexProcess((message, target) => {
      if (message.method === "permissionProfile/list") {
        target.emit({ id: message.id, result: { data, nextCursor: null } });
        return;
      }
      standardHandshake(message, target);
    });
    assert.equal((await createProvider(process).execute(executeInput(process))).kind, "not_accepted");
    assert.equal(process.requests.some(message => message.method === "turn/start"), false);
  }
});
test("rejects duplicate qualified config layers before creating a Codex thread", async () => {
  for (const duplicatedType of ["user", "sessionFlags"] as const) {
    const process = new FakeCodexProcess((message, target) => {
      if (message.method === "config/read") {
        const result = exactConfigResult();
        const layers = result.layers as Message[];
        const duplicate = layers.find(layer => (layer.name as Message).type === duplicatedType);
        target.emit({ id: message.id, result: { ...result, layers: [...layers, duplicate] } });
        return;
      }
      standardHandshake(message, target);
    });
    assert.equal((await createProvider(process).execute(executeInput(process))).kind, "not_accepted");
    assert.equal(process.requests.some(message => message.method === "thread/start"), false);
  }
});
test("rejects project config substitution before creating a Codex thread or turn", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (message.method === "config/read") {
      target.emit({
        id: message.id,
        result: {
          config: {
            default_permissions: boundary.permissionProfileId,
            permissions: { [boundary.permissionProfileId]: boundary.permissionProfile },
          },
          layers: [{
            config: { permissions: { [boundary.permissionProfileId]: boundary.permissionProfile } },
            disabledReason: null,
            name: { dotCodexFolder: `${boundary.workspaceRef}/.codex`, type: "project" },
            version: "hostile",
          }],
          origins: {},
        },
      });
      return;
    }
    standardHandshake(message, target);
  });
  assert.equal((await createProvider(process).execute(executeInput(process))).kind, "not_accepted");
  assert.equal(process.requests.some(message => message.method === "thread/start"), false);
  assert.equal(process.requests.some(message => message.method === "turn/start"), false);
});
test("requires active profile provenance before sending turn bytes", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (message.method === "thread/start") {
      target.emit({ id: message.id, result: { thread: { id: "thread:test" } } });
      return;
    }
    standardHandshake(message, target);
  });
  assert.equal((await createProvider(process, { turnTimeoutMs: 20 }).execute(executeInput(process))).kind, "not_accepted");
  assert.equal(process.requests.some(message => message.method === "turn/start"), false);
});
test("rejects wrong active profile provenance before sending turn bytes", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (message.method === "thread/start") {
      target.emit({
        method: "thread/settings/updated",
        params: {
          threadId: "thread:test",
          threadSettings: {
            activePermissionProfile: { extends: ":workspace", id: "wrong-profile" },
            approvalPolicy: "never",
            cwd: boundary.workspaceRef,
            sandboxPolicy: { networkAccess: false, type: "readOnly" },
          },
        },
      });
      target.emit({ id: message.id, result: { thread: { id: "thread:test" } } });
      return;
    }
    standardHandshake(message, target);
  });
  assert.equal((await createProvider(process).execute(executeInput(process))).kind, "not_accepted");
  assert.equal(process.requests.some(message => message.method === "turn/start"), false);
});
test("rejects semantic error, plan, and passive-item replays with substituted fields", async () => {
  for (const emitAdversary of [
    (target: FakeCodexProcess) => {
      const error = { additionalDetails: null, codexErrorInfo: null, message: "synthetic" };
      target.emit({ method: "error", params: { error, threadId: "thread:test", turnId: "turn:replay", willRetry: false } });
      target.emit({ method: "error", params: { error, threadId: "thread:test", turnId: "turn:replay", willRetry: true } });
    },
    (target: FakeCodexProcess) => target.emit({ method: "error", params: {
      error: { additionalDetails: null, codexErrorInfo: null, message: "synthetic", unused: true },
      threadId: "thread:test", turnId: "turn:replay", willRetry: false,
    } }),
    (target: FakeCodexProcess) => {
      const plan = [{ status: "pending", step: "inspect" }];
      target.emit({ method: "turn/plan/updated", params: { explanation: null, plan, threadId: "thread:test", turnId: "turn:replay" } });
      target.emit({ method: "turn/plan/updated", params: { explanation: "substituted", plan, threadId: "thread:test", turnId: "turn:replay" } });
    },
    (target: FakeCodexProcess) => {
      target.emit({ method: "item/started", params: { item: commandExecution("item:command", {
        cwd: boundary.workspaceRef,
      }), startedAtMs: 1, threadId: "thread:test", turnId: "turn:replay" } });
      target.emit({ method: "item/commandExecution/outputDelta", params: { delta: "x", itemId: "item:command", threadId: "thread:test", turnId: "turn:replay", unused: true } });
    },
  ]) {
    const process = new FakeCodexProcess((message, target) => {
      if (standardHandshake(message, target)) {return;}
      if (message.method === "turn/start") {target.emit({ id: message.id, result: { turn: generatedTurn("turn:replay", "inProgress") } }); emitTurnStarted(target, "turn:replay"); emitAdversary(target);}
    });
    assertContainmentRequired(await createProvider(process).execute(
      executeInput(process, async () => false, "workspace-write"),
    ));
  }
});
test("requires assistant item identity and rejects malformed delta lifecycles", async () => {
  for (const deltas of [
    [{ delta: "missing-item", threadId: "thread:test", turnId: "turn:delta" }],
    [{ delta: "replay", itemId: "item:changed", threadId: "thread:test", turnId: "turn:delta" }],
    [{ delta: "replay", itemId: "item:replay", threadId: "thread:test", turnId: "turn:delta", unused: true }],
  ]) {
    const output: string[] = [];
    const process = new FakeCodexProcess((message, target) => {
      if (standardHandshake(message, target)) {return;}
      if (message.method === "turn/start") {
        target.emit({ id: message.id, result: { turn: generatedTurn("turn:delta", "inProgress") } });
        emitTurnStarted(target, "turn:delta");
        emitAgentStarted(target, "turn:delta", "item:replay");
        for (const params of deltas) {target.emit({ method: "item/agentMessage/delta", params });}
      }
    });
    assertContainmentRequired(await createProvider(process).execute({
      ...executeInput(process), emit: async chunk => {output.push(chunk.text);},
    }));
    assert.deepEqual(output, []);
  }
});
test("bounds active notification messages and canonical bytes", async () => {
  for (const overrides of [
    { maxActiveNotificationBytes: 16 },
    { maxActiveNotifications: 1 },
  ]) {
    const process = new FakeCodexProcess((message, target) => {
      if (standardHandshake(message, target)) {return;}
      if (message.method === "turn/start") {
        target.emit({ id: message.id, result: { turn: generatedTurn("turn:bounded", "inProgress") } });
        emitTurnStarted(target, "turn:bounded");
        target.emit({ method: "warning", params: { message: "one", threadId: "thread:test" } });
        target.emit({ method: "warning", params: { message: "two", threadId: "thread:test" } });
      }
    });
    assertContainmentRequired(await createProvider(process, overrides).execute(executeInput(process)));
  }
});
test("rejects fatal UTF-8 decoding errors after dispatch", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:utf8", "inProgress") } });
      emitTurnStarted(target, "turn:utf8");
      target.stdout.push(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]));
    }
  });
  assertContainmentRequired(await createProvider(process).execute(executeInput(process)));
});
const assertContainmentRequired = (outcome: Awaited<ReturnType<CodexAppServerContainedTurnProvider["execute"]>>): void => {
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
  assert.equal("integrationRequired" in outcome && outcome.integrationRequired,
    "kernel-custody-containment-reconciliation/v1");
  assert.equal("outputDrainProven" in outcome && outcome.outputDrainProven, false);
};
test("requires EOF and clean exit after terminal observation and rejects late or duplicate messages", async () => {
  for (const lateMessage of [
    { method: "item/agentMessage/delta", params: { delta: "late", itemId: "item:late", threadId: "thread:test", turnId: "turn:late" } },
    { method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:late", "completed") } },
  ]) {
    const process = new FakeCodexProcess((message, target) => {
      if (standardHandshake(message, target)) {return;}
      if (message.method === "turn/start") {
        target.emit({ id: message.id, result: { turn: generatedTurn("turn:late", "inProgress") } });
        emitTurnStarted(target, "turn:late");
        target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:late", "completed") } });
        target.emit(lateMessage);
      }
    });
    const outcome = await createProvider(process).execute(executeInput(process));
    assertContainmentRequired(outcome);
    assert.equal("protocolTerminalObserved" in outcome && outcome.protocolTerminalObserved, true);
  }
  const eofTimeout = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:eof", "inProgress") } });
      emitTurnStarted(target, "turn:eof");
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:eof", "completed") } });
    }
  }, { closeWithoutEof: true });
  const eofOutcome = await createProvider(eofTimeout).execute(executeInput(eofTimeout));
  assertContainmentRequired(eofOutcome);
  assert.equal(eofTimeout.events.includes("wait-exit"), false);
  const exitTimeout = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:exit", "inProgress") } });
      emitTurnStarted(target, "turn:exit");
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:exit", "completed") } });
    }
  }, { hangExit: true });
  assertContainmentRequired(await createProvider(exitTimeout).execute(executeInput(exitTimeout)));
  assert.deepEqual(exitTimeout.events.slice(0, 2), ["close-input", "wait-exit"]);
});
test("preserves valid protocol-terminal observation when downstream output emission times out", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:emit-timeout", "inProgress") } });
      emitTurnStarted(target, "turn:emit-timeout");
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test",
        turn: generatedTurn("turn:emit-timeout", "failed", {
          additionalDetails: null,
          codexErrorInfo: null,
          message: "synthetic terminal diagnostic",
        }),
      } });
    }
  });
  const outcome = await createProvider(process).execute({
    ...executeInput(process),
    emit: async () => new Promise(() => {}),
  });
  assertContainmentRequired(outcome);
  assert.equal("protocolTerminalObserved" in outcome && outcome.protocolTerminalObserved, true);
});
test("bounds post-dispatch write and close and surfaces containment reconciliation", async () => {
  const writeTimeout = new FakeCodexProcess((message, target) => {
    standardHandshake(message, target);
  }, { hangWriteMethod: "turn/start" });
  assertContainmentRequired(await createProvider(writeTimeout).execute(executeInput(writeTimeout)));
  const closeTimeout = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:close", "inProgress") } });
      emitTurnStarted(target, "turn:close");
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:close", "completed") } });
    }
  }, { hangClose: true });
  assertContainmentRequired(await createProvider(closeTimeout).execute(executeInput(closeTimeout)));
});
test("returns typed uncertainty when pre-dispatch stdin closure is unproven", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (message.method === "initialize") {
      target.emit({ id: message.id, result: {
        codexHome: "/wrong-home", platformFamily: "unix", platformOs: "linux", userAgent: "codex/0.150.1",
      } });
    }
  }, { hangClose: true });
  assertContainmentRequired(await createProvider(process).execute(executeInput(process)));
  assert.equal(process.requests.some(message => message.method === "turn/start"), false);
});
test("requires full pre-dispatch process drain for no-start proof", async () => {
  for (const behavior of [{ closeWithoutEof: true }, { hangExit: true }, { hangStderr: true }]) {
    const process = new FakeCodexProcess(rejectInitialize, behavior);
    assertContainmentRequired(await createProvider(process).execute(executeInput(process)));
  }
});
test("stderr iterator failure remains ambiguous before dispatch and after a protocol terminal", async () => {
  const preDispatch = new FakeCodexProcess(rejectInitialize, { failStderr: true });
  assertContainmentRequired(await createProvider(preDispatch).execute(executeInput(preDispatch)));
  assert.equal(preDispatch.requests.some(message => message.method === "turn/start"), false);
  const terminal = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:stderr", "inProgress") } });
      emitTurnStarted(target, "turn:stderr");
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:stderr", "completed") } });
    }
  }, { failStderr: true });
  const outcome = await createProvider(terminal).execute(executeInput(terminal));
  assertContainmentRequired(outcome);
  assert.equal("protocolTerminalObserved" in outcome && outcome.protocolTerminalObserved, true);
});
test("accepts one exact empty interrupt result and rejects duplicate or malformed acknowledgements", async () => {
  for (const results of [[{}, {}], [{ accepted: true }]]) {
    const process = new FakeCodexProcess((message, target) => {
      if (standardHandshake(message, target)) {return;}
      if (message.method === "turn/start") {
        target.emit({ id: message.id, result: { turn: generatedTurn("turn:interrupt-shape", "inProgress") } });
        emitTurnStarted(target, "turn:interrupt-shape");
      }
      if (message.method === "turn/interrupt") {
        for (const result of results) {target.emit({ id: message.id, result });}
        target.emit({ method: "turn/completed", params: {
          threadId: "thread:test",
          turn: generatedTurn("turn:interrupt-shape", "interrupted"),
        } });
      }
    });
    assertContainmentRequired(await createProvider(process).execute(executeInput(process, async () => true)));
  }
});
test("actual diagnostics and outcomes are byte-identical across private notification values, JSON sizes, and counts", async () => {
  // Kept beside the assertion so the complete public-oracle scenario remains reviewable as one test.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const publicEvidence = async (hostile: string, warningCount: number) => {
    const output: { readonly cursor: number; readonly kind: string; readonly text: string }[] = [];
    const process = new FakeCodexProcess((message, target) => {
      if (standardHandshake(message, target)) {return;}
      if (message.method === "turn/start") {
        target.emit({ id: message.id, result: { turn: generatedTurn("turn:oracle", "inProgress") } });
        emitTurnStarted(target, "turn:oracle");
        for (let index = 0; index < warningCount; index += 1) {
          target.emit({ method: "warning", params: { message: `${hostile}:${index}`, threadId: "thread:test" } });
        }
        target.emit({ method: "error", params: {
          error: { additionalDetails: hostile, codexErrorInfo: null, message: hostile },
          threadId: "thread:test",
          turnId: "turn:oracle",
          willRetry: false,
        } });
        target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn(
          "turn:oracle", "failed", { additionalDetails: hostile, codexErrorInfo: null, message: hostile },
        ) } });
      }
    });
    process.stderr.push(Buffer.from(hostile, "utf8"));
    const outcome = await createProvider(process).execute({
      ...executeInput(process),
      emit: async chunk => {output.push(chunk);},
    });
    return { outcome, output };
  };
  const privateCases = [
    { count: 0, value: "AR_PRIVATE_SHORT_6c31" },
    { count: 1, value: "AR_PROVIDER_SECRET_8f2d" },
    { count: 3, value: `${boundary.codexHome}:${"long-private-value".repeat(100)}` },
    { count: 7, value: `${syntheticTmp}:credential-derived-value` },
  ];
  const outcomes = await Promise.all(privateCases.map(({ count, value }) => publicEvidence(value, count)));
  const serialized = outcomes.map(evidence => JSON.stringify(evidence));
  assert.ok(outcomes.every(({ outcome }) => outcome.kind === "completed"));
  assert.equal(new Set(serialized).size, 1);
  assert.deepEqual(outcomes[0]?.output, [
    { cursor: 0, kind: "diagnostic", text: "codex-provider-error-notification-redacted/v1" },
    { cursor: 1, kind: "diagnostic", text: "codex-provider-terminal-failure-redacted/v1" },
  ]);
  for (const [index, privateCase] of privateCases.entries()) {
    assert.equal(serialized[index]?.includes(privateCase.value), false);
  }
});

test("rejects a sensitive marker split across assistant deltas before public evidence", async () => {
  const privateSecret = "AR_PRIVATE_SPLIT_SENTINEL_1f82";
  const splitAt = Math.floor(privateSecret.length / 2);
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: generatedTurn("turn:split", "inProgress") } });
      emitTurnStarted(target, "turn:split"); emitAgentStarted(target, "turn:split", "item:split");
      for (const delta of [privateSecret.slice(0, splitAt), privateSecret.slice(splitAt)]) {
        target.emit({ method: "item/agentMessage/delta", params: {
          delta, itemId: "item:split", threadId: "thread:test", turnId: "turn:split",
        } });
      }
    }
  });
  const provider = new CodexAppServerContainedTurnProvider({ boundary, manifest,
    processes: { get: () => process }, sensitiveOutputTokens: [privateSecret], tmpDir: syntheticTmp });
  const outcome = await provider.execute(executeInput(process));
  assertContainmentRequired(outcome);
  assert.equal(JSON.stringify(outcome).includes(privateSecret), false);
});
