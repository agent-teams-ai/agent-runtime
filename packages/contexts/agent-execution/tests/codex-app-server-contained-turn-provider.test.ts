import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexAppServerContainedTurnProvider } from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import { createCodexAppServerLaunchPlan } from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import type { CustodiedProviderProcess } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

type Message = Record<string, unknown>;

const manifest = Object.freeze({
  effectClass: "contained_unmediated_effect" as const,
  providerBinding: Object.freeze({
    adapterRevision: "codex-app-server-adapter:0.150.1",
    binaryRevision: "@openai/codex:0.150.1+linux-x64",
    capabilityManifestRevision: "codex-contained-turn:v1",
    credentialBindingDigest: "credential:test",
    provider: "codex" as const,
    providerRouteRef: "provider-route:test",
  }),
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
});

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #buffer: Uint8Array[] = [];
  readonly #waiters: ((value: IteratorResult<Uint8Array>) => void)[] = [];
  #ended = false;

  public end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {waiter({ done: true, value: undefined });}
  }

  public push(bytes: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {this.#buffer.push(bytes);} else {waiter({ done: false, value: bytes });}
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const buffered = this.#buffer.shift();
        if (buffered !== undefined) {return { done: false, value: buffered };}
        if (this.#ended) {return { done: true, value: undefined };}
        return new Promise<IteratorResult<Uint8Array>>(resolve => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

class FakeCodexProcess implements CustodiedProviderProcess {
  readonly #onRequest: (message: Message, process: FakeCodexProcess) => void;
  public readonly custodyRef = "custody:codex:test";
  public readonly requests: Message[] = [];
  public readonly stderr = new AsyncByteQueue();
  public readonly stdout = new AsyncByteQueue();
  public closeCount = 0;

  public constructor(onRequest: (message: Message, process: FakeCodexProcess) => void) {
    this.#onRequest = onRequest;
    this.stderr.end();
  }

  public closeInput(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }

  public emit(message: Message): void {
    this.stdout.push(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
  }

  public waitForExit(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
    return Promise.resolve({ code: 0, signal: null });
  }

  public async write(bytes: Uint8Array): Promise<void> {
    for (const line of Buffer.from(bytes).toString("utf8").trim().split("\n")) {
      if (line.length === 0) {continue;}
      const message = JSON.parse(line) as Message;
      this.requests.push(message);
      this.#onRequest(message, this);
    }
  }
}

const standardHandshake = (message: Message, process: FakeCodexProcess): boolean => {
  if (message.method === "initialize") {
    process.emit({ id: message.id, result: { codexHome: "/synthetic", platformFamily: "unix", platformOs: "linux", userAgent: "codex/0.150.1" } });
    return true;
  }
  if (message.method === "initialized") {return true;}
  if (message.method === "thread/start") {
    process.emit({ id: message.id, result: { thread: { id: "thread:test" } } });
    return true;
  }
  return false;
};

const createProvider = (process: FakeCodexProcess, overrides: { readonly turnTimeoutMs?: number } = {}) =>
  new CodexAppServerContainedTurnProvider({
    cancellationPollMs: 2,
    manifest,
    processes: {
      get(custodyRef) {
        if (custodyRef === process.custodyRef) {return process;}
      },
    },
    requestTimeoutMs: 50,
    turnTimeoutMs: overrides.turnTimeoutMs ?? 100,
  });

const executeInput = (process: FakeCodexProcess, cancellation = async () => false) => ({
  attemptId: "attempt:test",
  custody: { custodyRef: process.custodyRef },
  effectId: "effect:test",
  emit: async (_chunk: { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }) => {},
  intent: { mode: "analysis" as const, prompt: "Inspect only this disposable workspace." },
  isCancellationRequested: cancellation,
  operationId: "operation:test",
  workspaceRef: "/synthetic/workspace",
});

test("maps one exact Codex App Server turn to provider-neutral receipts", async () => {
  const output: string[] = [];
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: { id: "turn:test", status: "inProgress" } } });
      target.emit({ method: "item/agentMessage/delta", params: { delta: "contained", itemId: "item:test", threadId: "thread:test", turnId: "turn:test" } });
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: { id: "turn:test", status: "completed" } } });
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
});

test("observes durable cancellation and interrupts the exact Codex turn", async () => {
  let cancellationChecks = 0;
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: { id: "turn:cancel", status: "inProgress" } } });
    }
    if (message.method === "turn/interrupt") {
      target.emit({ id: message.id, result: {} });
      target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: { id: "turn:cancel", status: "interrupted" } } });
    }
  });
  const outcome = await createProvider(process).execute(executeInput(process, async () => {
    cancellationChecks += 1;
    return true;
  }));
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "cancelled");}
  assert.ok(cancellationChecks >= 1);
  const interrupt = process.requests.find(message => message.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "thread:test", turnId: "turn:cancel" });
});

test("maps an explicit turn rejection to known not accepted", async () => {
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ error: { code: -32_000, message: "synthetic rejection" }, id: message.id });
    }
  });
  const outcome = await createProvider(process).execute(executeInput(process));
  assert.equal(outcome.kind, "not_accepted");
});

test("preserves a bounded Codex terminal diagnostic", async () => {
  const output: { readonly kind: string; readonly text: string }[] = [];
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: { id: "turn:failed", status: "inProgress" } } });
      target.emit({
        method: "turn/completed",
        params: {
          threadId: "thread:test",
          turn: { error: { message: "synthetic provider failure" }, id: "turn:failed", status: "failed" },
        },
      });
    }
  });
  const outcome = await createProvider(process).execute({
    ...executeInput(process),
    emit: async chunk => {output.push(chunk);},
  });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "failed");}
  assert.deepEqual(output, [{ kind: "diagnostic", text: "synthetic provider failure", cursor: 0 }]);
});

test("fails ambiguous after dispatch for approval requests, malformed output, and missing custody", async () => {
  const approvalProcess = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: { id: "turn:approval", status: "inProgress" } } });
      target.emit({ id: "server:approval", method: "item/commandExecution/requestApproval", params: {} });
    }
  });
  assert.deepEqual((await createProvider(approvalProcess).execute(executeInput(approvalProcess))).kind, "ambiguous");

  const malformedProcess = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({ id: message.id, result: { turn: { id: "turn:malformed", status: "inProgress" } } });
      target.stdout.push(Buffer.from("not-json\n", "utf8"));
    }
  });
  assert.deepEqual((await createProvider(malformedProcess).execute(executeInput(malformedProcess))).kind, "ambiguous");

  const missing = new CodexAppServerContainedTurnProvider({ manifest, processes: { get() {} } });
  assert.deepEqual((await missing.execute(executeInput(malformedProcess))).kind, "ambiguous");
});

test("constructs the exact fail-closed Codex launch arguments", () => {
  const plan = createCodexAppServerLaunchPlan({
    binaryRevision: manifest.providerBinding.binaryRevision,
    environment: { CODEX_HOME: "/synthetic/codex", HOME: "/synthetic", PATH: "/usr/bin" },
    executablePath: "/opt/codex",
    executableSha256: "a".repeat(64),
  });
  assert.deepEqual(plan.arguments.slice(0, 3), ["app-server", "--stdio", "--strict-config"]);
  assert.ok(plan.arguments.includes("multi_agent"));
  assert.ok(plan.arguments.includes("multi_agent_v2"));
  assert.equal(plan.provider, "codex");
});
