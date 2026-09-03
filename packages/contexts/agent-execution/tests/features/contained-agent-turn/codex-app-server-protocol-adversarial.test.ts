import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  CODEX_APP_SERVER_ADAPTER_REVISION,
  CODEX_APP_SERVER_BINARY_REVISION,
  CODEX_CAPABILITY_MANIFEST_REVISION,
  createCodexAppServerPermissionBoundary,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CodexAppServerContainedTurnProvider } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import type { CodexEffectCustodyAuthority } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-effect-custody.js";
import type { CustodiedProviderProcess } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import { agentMessage, commandExecution, emitAgentCompleted, emitAgentStarted, fileChange,
  generatedTurn } from "../../codex-app-server-test-messages.mjs";
import { codexEffectivePermissionProfile, codexUserPermissionProfile } from "./codex-permission-profile-fixture.ts";

type Message = Record<string, unknown>;

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: ((value: IteratorResult<Uint8Array>) => void)[] = [];
  #ended = false;
  public end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {waiter({ done: true, value: undefined });}
  }
  public push(value: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {this.#values.push(value);} else {waiter({ done: false, value });}
  }
  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: async () => {
      const value = this.#values.shift();
      if (value !== undefined) {return { done: false, value };}
      if (this.#ended) {return { done: true, value: undefined };}
      return new Promise(resolve => {this.#waiters.push(resolve);});
    } };
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-protocol-test-")));
const privateRoot = join(root, "private");
const codexHome = join(privateRoot, "codex-home");
const workspace = join(root, "workspace");
const privateTmp = join(privateRoot, "tmp");
mkdirSync(privateRoot, { mode: 0o700 });
mkdirSync(codexHome, { mode: 0o700 });
mkdirSync(workspace);
mkdirSync(privateTmp, { mode: 0o700 });
after(() => rmSync(root, { force: true, recursive: true }));
const boundary = createCodexAppServerPermissionBoundary({ codexHome, workspaceRef: workspace });

class ProtocolProcess implements CustodiedProviderProcess {
  public readonly custodyRef = "custody:protocol-adversarial";
  public readonly environment = Object.freeze({
    CODEX_HOME: codexHome,
    HOME: codexHome,
    LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: privateTmp,
  });
  public readonly stderr = new ByteQueue();
  public readonly stdout = new ByteQueue();
  public turnStartParams: Message | undefined;
  readonly #active: (target: ProtocolProcess) => void;
  readonly #interrupt: (message: Message, target: ProtocolProcess) => void;
  readonly #mode: "analysis" | "workspace-write";
  public constructor(
    active: (target: ProtocolProcess) => void,
    mode: "analysis" | "workspace-write",
    interrupt: (message: Message, target: ProtocolProcess) => void = () => {},
  ) {
    this.#active = active;
    this.#interrupt = interrupt;
    this.#mode = mode;
    this.stderr.end();
  }
  public closeInput(): Promise<void> {this.stdout.end(); return Promise.resolve();}
  public emit(message: Message): void {
    this.stdout.push(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
  }
  public waitForExit(): Promise<{ readonly code: number; readonly signal: null }> {
    return Promise.resolve({ code: 0, signal: null });
  }
  public async write(bytes: Uint8Array): Promise<void> {
    for (const line of Buffer.from(bytes).toString("utf8").trim().split("\n")) {
      if (line.length === 0) {continue;}
      const message = JSON.parse(line) as Message;
      if (this.#handshake(message)) {continue;}
      if (message.method === "turn/start") {
        this.turnStartParams = message.params as Message;
        this.emit({ id: message.id, result: { turn: generatedTurn("turn:adversarial", "inProgress") } });
        this.emit({
          method: "turn/started",
          params: { threadId: "thread:test", turn: generatedTurn("turn:adversarial", "inProgress") },
        });
        this.#active(this);
      }
      if (message.method === "turn/interrupt") {this.#interrupt(message, this);}
    }
  }
  #handshake(message: Message): boolean {
    if (message.method === "initialize") {
      this.emit({ id: message.id, result: {
        codexHome, platformFamily: "unix", platformOs: "linux", userAgent: "agent-runtime/0.150.1 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.150.1)",
      } });
      return true;
    }
    if (message.method === "initialized") {return true;}
    if (message.method === "config/read") {
      this.emit({ id: message.id, result: {
        config: {
          default_permissions: boundary.permissionProfileId,
          permissions: { [boundary.permissionProfileId]: codexEffectivePermissionProfile(codexHome) },
        },
        layers: [
          { config: {}, disabledReason: null, name: { file: "/opt/codex/defaults.toml", type: "packagedDefaults" }, version: "1" },
          {
            config: { permissions: { [boundary.permissionProfileId]: codexUserPermissionProfile(codexHome) } },
            disabledReason: null,
            name: { file: `${codexHome}/config.toml`, profile: null, type: "user" },
            version: "2",
          },
          {
            config: { default_permissions: boundary.permissionProfileId },
            disabledReason: null,
            name: { type: "sessionFlags" },
            version: "3",
          },
        ],
        origins: {
          default_permissions: { name: { type: "sessionFlags" }, version: "3" },
          permissions: { name: { file: `${codexHome}/config.toml`, profile: null, type: "user" }, version: "2" },
        },
      } });
      return true;
    }
    if (message.method === "permissionProfile/list") {
      this.emit({ id: message.id, result: {
        data: [{ allowed: true, description: null, id: boundary.permissionProfileId }],
        nextCursor: null,
      } });
      return true;
    }
    if (message.method === "thread/start") {
      const sandboxPolicy = this.#mode === "analysis"
        ? { networkAccess: false, type: "readOnly" }
        : { excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false,
          type: "workspaceWrite", writableRoots: [workspace] };
      this.emit({ method: "thread/settings/updated", params: {
        threadId: "thread:test",
        threadSettings: {
          activePermissionProfile: { extends: ":workspace", id: boundary.permissionProfileId },
          approvalPolicy: "never",
          cwd: workspace,
          sandboxPolicy,
        },
      } });
      this.emit({ id: message.id, result: { thread: { id: "thread:test" } } });
      return true;
    }
    return false;
  }
}

const execute = async (
  active: (target: ProtocolProcess) => void,
  mode: "analysis" | "workspace-write" = "analysis",
  turnTimeoutMs = 100,
  requestTimeoutMs = 50,
  options: {
    readonly cancellation?: () => Promise<boolean>;
    readonly effectCustody?: CodexEffectCustodyAuthority;
    readonly interrupt?: (message: Message, target: ProtocolProcess) => void;
  } = {},
) => {
  const process = new ProtocolProcess(active, mode, options.interrupt);
  const provider = new CodexAppServerContainedTurnProvider({
    boundary,
    cancellationPollMs: 2,
    effectCustody: options.effectCustody,
    manifest: Object.freeze({
      effectClass: "contained_unmediated_effect" as const,
      providerBinding: Object.freeze({
        adapterRevision: CODEX_APP_SERVER_ADAPTER_REVISION,
        binaryRevision: CODEX_APP_SERVER_BINARY_REVISION,
        capabilityManifestRevision: CODEX_CAPABILITY_MANIFEST_REVISION,
        credentialBindingDigest: "credential:test",
        provider: "codex" as const,
        providerRouteRef: "provider-route:test",
      }),
      supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
    }),
    privateRootPath: privateRoot,
    processes: { get: custodyRef => custodyRef === process.custodyRef ? process : undefined },
    requestTimeoutMs,
    tmpDir: privateTmp,
    turnTimeoutMs,
  });
  return provider.execute({
    attemptId: "attempt:test",
    custody: { custodyRef: process.custodyRef },
    effectId: "effect:test",
    emit: async () => {},
    intent: { mode, prompt: "Inspect only this disposable workspace." },
    isCancellationRequested: options.cancellation ?? (async () => false),
    operationId: "operation:test",
    workspaceRef: workspace,
  });
};

const assertFailClosed = async (active: (target: ProtocolProcess) => void): Promise<void> => {
  const outcome = await execute(active, "analysis", 2_000, 2_000);
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
  assert.equal("outputDrainProven" in outcome && outcome.outputDrainProven, false);
};

const assertWorkspaceWriteFailClosed = async (active: (target: ProtocolProcess) => void): Promise<void> => {
  const outcome = await execute(active, "workspace-write", 2_000, 2_000);
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
  assert.equal("outputDrainProven" in outcome && outcome.outputDrainProven, false);
};

const fileChangeWithPath = (path: string, kind: Record<string, unknown> = { type: "add" }) =>
  fileChange("item:path", { changes: [{ diff: "+x", kind, path }] });

test("never treats unsolicited or unacknowledged interrupted notifications as cancelled truth", async () => {
  const unsolicited = await execute(target => {
    target.emit({ method: "turn/completed", params: {
      threadId: "thread:test", turn: generatedTurn("turn:adversarial", "interrupted"),
    } });
  });
  assert.equal(unsolicited.kind, "ambiguous");
  assert.equal("containmentRequired" in unsolicited && unsolicited.containmentRequired, true);

  const beforeAcknowledgement = await execute(
    () => {},
    "analysis",
    2_000,
    2_000,
    {
      cancellation: async () => true,
      interrupt: (_message, target) => {
        target.emit({ method: "turn/completed", params: {
          threadId: "thread:test", turn: generatedTurn("turn:adversarial", "interrupted"),
        } });
      },
    },
  );
  assert.equal(beforeAcknowledgement.kind, "ambiguous");
  assert.equal("containmentRequired" in beforeAcknowledgement && beforeAcknowledgement.containmentRequired, true);
});

test("fails closed for unknown and non-command effectful 0.150.1 item-union members", async () => {
  const unknown = { id: "item:unknown", type: "unknownTool" };
  const effectStarted = fileChange("item:effect");
  for (const { completed, started } of [
    { completed: unknown, started: unknown },
    {
      completed: { ...effectStarted, status: "completed" },
      started: effectStarted,
    },
  ]) {
    await assertFailClosed(target => {
      target.emit({ method: "item/started", params: {
        item: started, startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "item/completed", params: {
        completedAtMs: 2, item: completed, threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test", turn: generatedTurn("turn:adversarial", "completed", null, [completed]),
      } });
    });
  }
});

test("normalizes every optional agent-message field from the pinned schema before admission", async () => {
  const variants = [
    {},
    { delivery: "async" },
    { phase: "commentary" },
    { phase: "final_answer" },
    { memoryCitation: { entries: [{ lineEnd: 2, lineStart: 1, note: "bounded",
      path: join(workspace, "citation.md") }],
      threadIds: ["thread:test"] } },
  ];
  for (const [index, optional] of variants.entries()) {
    const id = `item:optional:${index}`;
    const started = { id, text: "", type: "agentMessage", ...optional };
    const completed = { ...started, text: "bounded" };
    const outcome = await execute(target => {
      target.emit({ method: "item/started", params: { item: started, startedAtMs: 1,
        threadId: "thread:test", turnId: "turn:adversarial" } });
      target.emit({ method: "item/agentMessage/delta", params: { delta: "bounded", itemId: id,
        threadId: "thread:test", turnId: "turn:adversarial" } });
      target.emit({ method: "item/completed", params: { completedAtMs: 2, item: completed,
        threadId: "thread:test", turnId: "turn:adversarial" } });
      target.emit({ method: "turn/completed", params: { threadId: "thread:test",
        turn: generatedTurn("turn:adversarial", "completed", null, [completed]) } });
    }, "analysis", 2_000, 2_000);
    assert.equal(outcome.kind, "completed", `optional agent-message variant ${index}`);
  }
});

test("fails closed for path-bearing command and file effects until exact opened-object custody exists", async () => {
  const commandStarted = commandExecution("item:command", { cwd: workspace });
  const commandCompleted = commandExecution("item:command", {
    aggregatedOutput: "bounded", cwd: workspace, durationMs: 2, exitCode: 0,
    processId: "process:command", status: "completed",
  });
  const silentStarted = commandExecution("item:silent", { command: "true", cwd: workspace });
  const silentCompleted = commandExecution("item:silent", {
    aggregatedOutput: "", command: "true", cwd: workspace, durationMs: 1, exitCode: 0, status: "completed",
  });
  const change = { diff: "+exact\n", kind: { type: "add" }, path: "exact.txt" };
  const fileStarted = fileChange("item:file");
  const fileCompleted = fileChange("item:file", { changes: [change], status: "completed" });
  const outcome = await execute(target => {
    target.emit({ method: "item/started", params: { item: commandStarted, startedAtMs: 1,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/commandExecution/terminalInteraction", params: { itemId: commandStarted.id,
      processId: "process:command", stdin: "", threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/commandExecution/outputDelta", params: { delta: "bounded",
      itemId: commandStarted.id, threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/completed", params: { completedAtMs: 2, item: commandCompleted,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/started", params: { item: silentStarted, startedAtMs: 3,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/completed", params: { completedAtMs: 4, item: silentCompleted,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/started", params: { item: fileStarted, startedAtMs: 5,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/fileChange/outputDelta", params: { delta: "+exact\n",
      itemId: fileStarted.id, threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/fileChange/patchUpdated", params: { changes: [change],
      itemId: fileStarted.id, threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/completed", params: { completedAtMs: 6, item: fileCompleted,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "turn/completed", params: { threadId: "thread:test",
      turn: generatedTurn("turn:adversarial", "completed", null,
        [commandCompleted, silentCompleted, fileCompleted]) } });
  }, "workspace-write", 2_000, 2_000);
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
});

const exactWorkspaceCustody = (behavior: "admit" | "stale" | "substitute" = "admit"): CodexEffectCustodyAuthority => {
  const admissions = new Map<string, object>();
  return {
    admit(request) {
      const rootIdentity = request.endpointObservations[0]?.existing[0];
      if (request.custodyRef !== "custody:protocol-adversarial" || request.workspaceRef !== workspace
        || rootIdentity?.path !== workspace
        || rootIdentity.device !== BigInt(boundary.workspaceIdentity.device)
        || rootIdentity.inode !== BigInt(boundary.workspaceIdentity.inode)) {return;}
      const prior = admissions.get(request.itemId);
      if (request.phase === "started") {
        const admission = Object.freeze({ authority: "synthetic-opened-workspace-descriptor" });
        admissions.set(request.itemId, admission);
        return admission;
      }
      if (behavior === "stale") {return;}
      if (behavior === "substitute") {return Object.freeze({ authority: "substituted" });}
      return prior === request.priorAdmission ? prior : undefined;
    },
  };
};

const executeCustodiedCommand = (effectCustody: CodexEffectCustodyAuthority) => {
  const started = commandExecution("item:custodied", { command: "pwd", cwd: workspace });
  const completed = commandExecution("item:custodied", {
    aggregatedOutput: "", command: "pwd", cwd: workspace, durationMs: 1, exitCode: 0, status: "completed",
  });
  return execute(target => {
    target.emit({ method: "item/started", params: { item: started, startedAtMs: 1,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/completed", params: { completedAtMs: 2, item: completed,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "turn/completed", params: { threadId: "thread:test",
      turn: generatedTurn("turn:adversarial", "completed", null, [completed]) } });
  }, "workspace-write", 2_000, 2_000, { effectCustody });
};

test("admits an effect only when opaque opened-workspace custody remains identity-bound", async () => {
  assert.equal((await executeCustodiedCommand(exactWorkspaceCustody())).kind, "completed");
  for (const behavior of ["stale", "substitute"] as const) {
    assert.equal((await executeCustodiedCommand(exactWorkspaceCustody(behavior))).kind, "ambiguous");
  }
});

test("invokes effect custody through its detached read-once receiver", async () => {
  const backing = exactWorkspaceCustody();
  let originalAdmit: CodexEffectCustodyAuthority["admit"];
  const authority: CodexEffectCustodyAuthority = {
    admit(request) {
      authority.admit = () => {throw new Error("private mutated custody receiver");};
      if (this.admit !== originalAdmit) {throw new Error("private original custody receiver retained");}
      return backing.admit(request);
    },
  };
  originalAdmit = authority.admit;
  assert.equal((await executeCustodiedCommand(authority)).kind, "completed");
});


test("schema-valid command action and source shapes still fail closed without path custody receipts", async () => {
  const optionalPath = [{}, { path: null }, { path: workspace }] as const;
  const optionalQuery = [{}, { query: null }, { query: "needle" }] as const;
  const commandActions = [
    { command: "read", name: "workspace", path: workspace, type: "read" },
    ...optionalPath.map(path => ({ command: "list", type: "listFiles", ...path })),
    ...optionalPath.flatMap(path => optionalQuery.map(query => ({ command: "search", type: "search",
      ...path, ...query }))),
    { command: "opaque", type: "unknown" },
  ];
  for (const source of ["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"]) {
    const started = commandExecution(`item:${source}`, { commandActions, cwd: workspace, source });
    const completed = { ...started, aggregatedOutput: "", durationMs: 1, exitCode: 0, status: "completed" };
    const outcome = await execute(target => {
      target.emit({ method: "item/started", params: { item: started, startedAtMs: 1,
        threadId: "thread:test", turnId: "turn:adversarial" } });
      target.emit({ method: "item/completed", params: { completedAtMs: 2, item: completed,
        threadId: "thread:test", turnId: "turn:adversarial" } });
      target.emit({ method: "turn/completed", params: { threadId: "thread:test",
        turn: generatedTurn("turn:adversarial", "completed", null, [completed]) } });
    }, "analysis", 2_000, 2_000);
    assert.equal(outcome.kind, "ambiguous");
    assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
  }
});

test("accepts schema-defaulted reasoning and optional clientId and nested text element fields", async () => {
  const user = { content: [{ text: "bounded", text_elements: [{ byteRange: { end: 0, start: 0 } }],
    type: "text" }], id: "item:user-defaults", type: "userMessage" };
  const reasoning = { id: "item:reasoning-defaults", type: "reasoning" };
  const outcome = await execute(target => {
    for (const [index, item] of [user, reasoning].entries()) {
      target.emit({ method: "item/started", params: { item, startedAtMs: index * 2 + 1,
        threadId: "thread:test", turnId: "turn:adversarial" } });
      target.emit({ method: "item/completed", params: { completedAtMs: index * 2 + 2, item,
        threadId: "thread:test", turnId: "turn:adversarial" } });
    }
    target.emit({ method: "turn/completed", params: { threadId: "thread:test",
      turn: generatedTurn("turn:adversarial", "completed", null, [user, reasoning]) } });
  }, "analysis", 2_000, 2_000);
  assert.equal(outcome.kind, "completed");
});

test("admits identical deltas and distinct item identities with identical assistant text", async () => {
  const items = [agentMessage("item:first", "samesame"), agentMessage("item:second", "samesame")];
  const outcome = await execute(target => {
    for (const [index, item] of items.entries()) {
      emitAgentStarted(target, "turn:adversarial", item.id);
      for (const delta of index === 0 ? ["same", "same"] : ["samesame"]) {
        target.emit({ method: "item/agentMessage/delta", params: { delta, itemId: item.id,
          threadId: "thread:test", turnId: "turn:adversarial" } });
      }
      emitAgentCompleted(target, "turn:adversarial", item.id, item.text);
    }
    for (const responseId of ["response:first", "response:second"]) {
      target.emit({ method: "rawResponse/completed", params: {
        responseId, threadId: "thread:test", turnId: "turn:adversarial", usage: null,
      } });
    }
    target.emit({ method: "turn/completed", params: { threadId: "thread:test",
      turn: generatedTurn("turn:adversarial", "completed", null, items) } });
  }, "analysis", 2_000, 2_000);
  assert.equal(outcome.kind, "completed");
});

test("rejects fractional, non-finite, coerced, or out-of-range generated integer fields", async () => {
  for (const malformed of [
    commandExecution("item:fractional-duration", { cwd: workspace, durationMs: 1.5 }),
    commandExecution("item:unsafe-duration", { cwd: workspace, durationMs: Number.MAX_SAFE_INTEGER + 1 }),
    commandExecution("item:fractional-exit", { cwd: workspace, exitCode: 0.5 }),
    commandExecution("item:high-exit", { cwd: workspace, exitCode: 2_147_483_648 }),
    commandExecution("item:low-exit", { cwd: workspace, exitCode: -2_147_483_649 }),
    { clientId: null, content: [{ text: "x", text_elements: [{
      byteRange: { end: 1, start: -1 }, placeholder: null,
    }], type: "text" }], id: "item:negative-byte-range", type: "userMessage" },
    { ...agentMessage("item:wide-line", "bounded"), memoryCitation: { entries: [{
      lineEnd: 4_294_967_296, lineStart: 1, note: "bounded", path: workspace,
    }], threadIds: [] } },
  ]) {
    await assertFailClosed(target => target.emit({ method: "item/started", params: {
      item: malformed, startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial",
    } }));
  }
  for (const startedAtMs of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY,
    "1", true, null]) {
    await assertFailClosed(target => target.emit({ method: "item/started", params: {
      item: agentMessage("item:timestamp", ""), startedAtMs,
      threadId: "thread:test", turnId: "turn:adversarial",
    } }));
  }
  for (const [method, field] of [
    ["item/reasoning/summaryPartAdded", "summaryIndex"],
    ["item/reasoning/summaryTextDelta", "summaryIndex"],
    ["item/reasoning/textDelta", "contentIndex"],
  ] as const) {
    for (const malformedIndex of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN,
      Number.POSITIVE_INFINITY, "0", true, null]) {
      await assertFailClosed(target => {
        target.emit({ method: "item/started", params: { item: { id: "item:index", type: "reasoning" },
          startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial" } });
        target.emit({ method, params: { ...(method.includes("Delta") ? { delta: "x" } : {}),
          [field]: malformedIndex, itemId: "item:index", threadId: "thread:test", turnId: "turn:adversarial" } });
      });
    }
  }
  for (const malformedCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN,
    Number.POSITIVE_INFINITY, "1", true, null]) {
    await assertFailClosed(target => target.emit({ method: "rawResponse/completed", params: {
      responseId: "response:integer", threadId: "thread:test", turnId: "turn:adversarial",
      usage: { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: malformedCount,
        outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    } }));
    await assertFailClosed(target => target.emit({ method: "error", params: {
      error: { additionalDetails: null, codexErrorInfo: { httpConnectionFailed: {
        httpStatusCode: malformedCount,
      } }, message: "generic" }, threadId: "thread:test", turnId: "turn:adversarial", willRetry: false,
    } }));
  }
  for (const malformedTurn of [
    { ...generatedTurn("turn:adversarial", "completed"), startedAt: 1.5 },
    { ...generatedTurn("turn:adversarial", "completed"), completedAt: 1.5 },
    { ...generatedTurn("turn:adversarial", "completed"), durationMs: 1.5 },
    { ...generatedTurn("turn:adversarial", "completed"), durationMs: -1 },
    { ...generatedTurn("turn:adversarial", "completed"), completedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...generatedTurn("turn:adversarial", "completed"), error: {
      additionalDetails: null, codexErrorInfo: null, message: "not permitted for success",
    } },
    { ...generatedTurn("turn:adversarial", "failed"), error: { message: "incomplete shape" } },
    { ...generatedTurn("turn:adversarial", "failed"), error: null },
    { ...generatedTurn("turn:adversarial", "inProgress"), completedAt: 1 },
  ]) {
    await assertFailClosed(target => target.emit({ method: "turn/completed", params: {
      threadId: "thread:test", turn: malformedTurn,
    } }));
  }
});

test("rejects untrusted provider paths outside exact disposable workspace custody", async () => {
  const link = join(workspace, "ambiguous-link"); const casePath = join(workspace, "CaseSensitive.txt");
  symlinkSync(privateTmp, link); writeFileSync(casePath, "exact");
  const commandWith = (overrides: Record<string, unknown>) => commandExecution("item:path", {
    cwd: workspace, ...overrides,
  });
  for (const item of [
    commandWith({ cwd: "../canonical-project" }), commandWith({ cwd: "/canonical-project" }),
    commandWith({ pluginId: "plugin:test", scriptPath: "../canonical-project/plugin.sh" }),
    commandWith({ commandActions: [{ command: "read", name: "outside",
      path: "../canonical-project", type: "read" }] }),
    commandWith({ commandActions: [{ command: "ls", path: "../canonical-project", type: "listFiles" }] }),
    commandWith({ commandActions: [{ command: "rg", path: "../canonical-project", query: null, type: "search" }] }),
    commandWith({ commandActions: [{ command: "rg", path: "nested\\alternate", query: null, type: "search" }] }),
    commandWith({ commandActions: [{ command: "rg", path: "e\u0301", query: null, type: "search" }] }),
    commandWith({ commandActions: [{ command: "rg", path: "nested／escape", query: null, type: "search" }] }),
    fileChangeWithPath("../canonical-project/pwn"), fileChangeWithPath("/canonical-project/pwn"),
    fileChangeWithPath(link), fileChangeWithPath(join(workspace, "caseSensitive.txt")),
    fileChangeWithPath(join(workspace, "renamed.txt"), { move_path: "../canonical-project/moved", type: "update" }),
    { ...agentMessage("item:citation", "bounded"), memoryCitation: { entries: [{ lineEnd: 1, lineStart: 1,
      note: "outside", path: "../canonical-project/README.md" }], threadIds: [] } },
    { clientId: null, content: [{ path: "../canonical-project/image.png", type: "localImage" }],
      id: "item:local-image", type: "userMessage" },
    { clientId: null, content: [{ path: "../canonical-project/audio.wav", type: "localAudio" }],
      id: "item:local-audio", type: "userMessage" },
    { clientId: null, content: [{ name: "outside", path: "../canonical-project/mention", type: "mention" }],
      id: "item:mention", type: "userMessage" },
    { clientId: null, content: [{ name: "outside", path: "../canonical-project/SKILL.md", type: "skill" }],
      id: "item:skill", type: "userMessage" },
  ]) {await assertWorkspaceWriteFailClosed(target => target.emit({ method: "item/started", params: {
    item, startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial",
  } }));}
  await assertWorkspaceWriteFailClosed(target => {
    const started = fileChange("item:patch-path");
    target.emit({ method: "item/started", params: { item: started, startedAtMs: 1,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    target.emit({ method: "item/fileChange/patchUpdated", params: { changes: [{
      diff: "+outside", kind: { type: "add" }, path: "../canonical-project/pwn",
    }], itemId: started.id, threadId: "thread:test", turnId: "turn:adversarial" } });
  });
  rmSync(link); rmSync(casePath);
});

test("fails closed when an admitted command ancestor is renamed and recreated", async () => {
  const parent = join(workspace, "identity-parent");
  const displaced = join(workspace, "identity-parent-displaced");
  mkdirSync(parent); writeFileSync(join(parent, "leaf.txt"), "admitted");
  const started = commandExecution("item:ancestor-replacement", { commandActions: [{ command: "read",
    name: "leaf", path: join(parent, "leaf.txt"), type: "read" }], cwd: parent });
  const completed = { ...started, aggregatedOutput: "", durationMs: 1, exitCode: 0, status: "completed" };
  await assertWorkspaceWriteFailClosed(target => {
    target.emit({ method: "item/started", params: { item: started, startedAtMs: 1,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    renameSync(parent, displaced); mkdirSync(parent); writeFileSync(join(parent, "leaf.txt"), "replacement");
    target.emit({ method: "item/completed", params: { completedAtMs: 2, item: completed,
      threadId: "thread:test", turnId: "turn:adversarial" } });
  });
  rmSync(parent, { recursive: true }); rmSync(displaced, { recursive: true });
});

test("fails closed when an admitted command leaf is renamed and recreated", async () => {
  const leaf = join(workspace, "identity-leaf.txt"); const displaced = `${leaf}.displaced`;
  writeFileSync(leaf, "admitted");
  const started = commandExecution("item:leaf-replacement", { commandActions: [{ command: "read",
    name: "leaf", path: leaf, type: "read" }], cwd: workspace });
  const completed = { ...started, aggregatedOutput: "", durationMs: 1, exitCode: 0, status: "completed" };
  await assertWorkspaceWriteFailClosed(target => {
    target.emit({ method: "item/started", params: { item: started, startedAtMs: 1,
      threadId: "thread:test", turnId: "turn:adversarial" } });
    renameSync(leaf, displaced); writeFileSync(leaf, "replacement");
    target.emit({ method: "item/completed", params: { completedAtMs: 2, item: completed,
      threadId: "thread:test", turnId: "turn:adversarial" } });
  });
  rmSync(leaf); rmSync(displaced);
});

test("rejects workspace-write effect substitutions and non-command/file effects", async () => {
  const started = commandExecution("item:command", { cwd: workspace });
  for (const active of [
    (target: ProtocolProcess) => {
      target.emit({ method: "item/started", params: { item: started, startedAtMs: 1,
        threadId: "thread:test", turnId: "turn:adversarial" } });
      target.emit({ method: "item/completed", params: { completedAtMs: 2,
        item: commandExecution("item:command", { command: "substituted", cwd: workspace,
          durationMs: 1, exitCode: 0, status: "completed" }),
        threadId: "thread:test", turnId: "turn:adversarial" } });
    },
    (target: ProtocolProcess) => target.emit({ method: "item/started", params: {
      item: { id: "item:web", type: "webSearch" }, startedAtMs: 1,
      threadId: "thread:test", turnId: "turn:adversarial",
    } }),
  ]) {
    const outcome = await execute(active, "workspace-write");
    assert.equal(outcome.kind, "ambiguous");
    assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
  }
});

test("rejects substituted fields on every admitted passive item-union member", async () => {
  for (const item of [
    { clientId: null, content: [], id: "item:user", type: "userMessage" },
    { fragments: [], id: "item:hook", type: "hookPrompt" },
    agentMessage("item:agent", ""),
    { id: "item:plan", text: "", type: "plan" },
    { content: [], id: "item:reasoning", summary: [], type: "reasoning" },
    { id: "item:entered", review: "review", type: "enteredReviewMode" },
    { id: "item:exited", review: "review", type: "exitedReviewMode" },
    { id: "item:compact", type: "contextCompaction" },
  ]) {
    const substituted = { ...item, substituted: true };
    await assertFailClosed(target => {
      target.emit({ method: "item/started", params: {
        item: substituted, startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "item/completed", params: {
        completedAtMs: 2, item: substituted, threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test",
        turn: generatedTurn("turn:adversarial", "completed", null, [substituted]),
      } });
    });
  }
});

test("rejects substituted item payloads and terminal item reconciliation mismatches", async () => {
  const started = agentMessage("item:agent", "");
  const completed = agentMessage("item:agent", "exact");
  for (const active of [
    (target: ProtocolProcess) => {
      target.emit({ method: "item/started", params: {
        item: started, startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "item/agentMessage/delta", params: {
        delta: "exact", itemId: "item:agent", threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "item/completed", params: {
        completedAtMs: 2, item: { ...completed, phase: "final_answer" },
        threadId: "thread:test", turnId: "turn:adversarial",
      } });
    },
    (target: ProtocolProcess) => {
      target.emit({ method: "item/started", params: {
        item: started, startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "item/agentMessage/delta", params: {
        delta: "exact", itemId: "item:agent", threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "item/completed", params: {
        completedAtMs: 2, item: completed, threadId: "thread:test", turnId: "turn:adversarial",
      } });
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test",
        turn: generatedTurn("turn:adversarial", "completed", null, [agentMessage("item:agent", "substituted")]),
      } });
    },
  ]) {await assertFailClosed(active);}
});

test("reconciles exact plan and reasoning delta lifecycles with full terminal items", async () => {
  const plan = { id: "item:plan", text: "inspect", type: "plan" };
  const reasoning = { content: ["detail"], id: "item:reasoning", summary: ["summary"], type: "reasoning" };
  const outcome = await execute(target => {
    target.emit({ method: "item/started", params: {
      item: { ...plan, text: "" }, startedAtMs: 1, threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "item/plan/delta", params: {
      delta: "inspect", itemId: plan.id, threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "item/completed", params: {
      completedAtMs: 2, item: plan, threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "item/started", params: {
      item: { ...reasoning, content: [], summary: [] }, startedAtMs: 3,
      threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "item/reasoning/summaryPartAdded", params: {
      itemId: reasoning.id, summaryIndex: 0, threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "item/reasoning/summaryTextDelta", params: {
      delta: "summary", itemId: reasoning.id, summaryIndex: 0,
      threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "item/reasoning/textDelta", params: {
      contentIndex: 0, delta: "detail", itemId: reasoning.id,
      threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "item/completed", params: {
      completedAtMs: 4, item: reasoning, threadId: "thread:test", turnId: "turn:adversarial",
    } });
    target.emit({ method: "turn/completed", params: {
      threadId: "thread:test",
      turn: generatedTurn("turn:adversarial", "completed", null, [plan, reasoning]),
    } });
  });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {assert.equal(outcome.outcome, "succeeded");}
});

test("rejects summary and notLoaded terminal item ambiguity", async () => {
  for (const itemsView of ["summary", "notLoaded"]) {
    await assertFailClosed(target => target.emit({ method: "turn/completed", params: {
      threadId: "thread:test",
      turn: generatedTurn("turn:adversarial", "completed", null, [], itemsView),
    } }));
  }
});

const usage = (totalTokens: number) => ({
  cacheWriteInputTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 1,
  outputTokens: totalTokens - 1,
  reasoningOutputTokens: 0,
  totalTokens,
});

test("keys raw response replay by stable responseId and rejects mutable-usage conflicts", async () => {
  for (const secondUsage of [usage(2), usage(3)]) {
    await assertFailClosed(target => {
      target.emit({ method: "rawResponse/completed", params: {
        responseId: "response:stable", threadId: "thread:test", turnId: "turn:adversarial", usage: usage(2),
      } });
      target.emit({ method: "rawResponse/completed", params: {
        responseId: "response:stable", threadId: "thread:test", turnId: "turn:adversarial", usage: secondUsage,
      } });
      target.emit({ method: "turn/completed", params: {
        threadId: "thread:test", turn: generatedTurn("turn:adversarial", "completed"),
      } });
    });
  }
});
