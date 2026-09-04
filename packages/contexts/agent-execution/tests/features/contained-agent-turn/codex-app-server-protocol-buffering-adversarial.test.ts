import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  CODEX_APP_SERVER_ADAPTER_REVISION,
  CODEX_APP_SERVER_BINARY_REVISION,
  CODEX_CAPABILITY_MANIFEST_REVISION,
  createCodexAppServerPermissionBoundary,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {
  CODEX_MAX_PRE_TURN_NOTIFICATION_BYTES,
  CodexAppServerContainedTurnProvider,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import type { CustodiedProviderProcess } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import { generatedTurn } from "../../codex-app-server-test-messages.mjs";
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

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-buffering-test-")));
const privateRoot = join(root, "private");
const codexHome = join(privateRoot, "codex-home");
const workspace = join(root, "workspace");
const privateTmp = join(privateRoot, "tmp");
mkdirSync(privateRoot, { mode: 0o700 });
mkdirSync(codexHome, { mode: 0o700 });
mkdirSync(workspace);
mkdirSync(privateTmp, { mode: 0o700 });
after(() => rmSync(root, { force: true, recursive: true }));
const boundary = createCodexAppServerPermissionBoundary({ codexHome, intentMode: "analysis", workspaceRef: workspace });

class BufferingProcess implements CustodiedProviderProcess {
  public readonly custodyRef = "custody:protocol-buffering-adversarial";
  public readonly environment = Object.freeze({
    CODEX_HOME: codexHome,
    HOME: codexHome,
    LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: privateTmp,
  });
  public readonly stderr = new ByteQueue();
  public readonly stdout = new ByteQueue();
  readonly #active: (target: BufferingProcess) => void;
  readonly #preResponse: (method: string, target: BufferingProcess) => void;
  public constructor(
    active: (target: BufferingProcess) => void,
    preResponse: (method: string, target: BufferingProcess) => void,
  ) {
    this.#active = active;
    this.#preResponse = preResponse;
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
        this.#preResponse("turn/start", this);
        this.emit({ id: message.id, result: { turn: generatedTurn("turn:adversarial", "inProgress") } });
        this.emit({
          method: "turn/started",
          params: { threadId: "thread:test", turn: generatedTurn("turn:adversarial", "inProgress") },
        });
        this.#active(this);
      }
    }
  }
  #handshake(message: Message): boolean {
    if (message.method === "initialize") {
      this.#preResponse("initialize", this);
      this.emit({ id: message.id, result: {
        codexHome, platformFamily: "unix", platformOs: "linux", userAgent: "agent-runtime/0.150.1 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.150.1+native-permission-config-v2)",
      } });
      return true;
    }
    if (message.method === "initialized") {return true;}
    if (message.method === "config/read") {
      this.#preResponse("config/read", this);
      this.emit({ id: message.id, result: {
        config: {
          default_permissions: boundary.permissionProfileId,
          permissions: { [boundary.permissionProfileId]: codexEffectivePermissionProfile(codexHome, "analysis") },
        },
        layers: [
          { config: {}, disabledReason: null, name: { file: "/etc/codex/config.toml", type: "system" }, version: "1" },
          {
            config: { permissions: { [boundary.permissionProfileId]: codexUserPermissionProfile(codexHome, "analysis") } },
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
      this.#preResponse("permissionProfile/list", this);
      this.emit({ id: message.id, result: {
        data: [{ allowed: true, description: null, id: boundary.permissionProfileId }],
        nextCursor: null,
      } });
      return true;
    }
    if (message.method === "thread/start") {
      this.#preResponse("thread/start", this);
      this.emit({ id: message.id, result: { thread: { id: "thread:test" }, activePermissionProfile: { extends: ":read-only", id: boundary.permissionProfileId }, approvalPolicy: "never", cwd: workspace, sandbox: { networkAccess: false, type: "readOnly" } } });
      return true;
    }
    return false;
  }
}

const execute = async (
  active: (target: BufferingProcess) => void,
  turnTimeoutMs = 10_000,
  requestTimeoutMs = 10_000,
  options: {
    readonly maxLineBytes?: number;
    readonly preResponse?: (method: string, target: BufferingProcess) => void;
  } = {},
) => {
  const process = new BufferingProcess(active, options.preResponse ?? (() => {}));
  const provider = new CodexAppServerContainedTurnProvider({
    boundary,
    cancellationPollMs: 2,
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
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    tmpDir: privateTmp,
    turnTimeoutMs,
  });
  return provider.execute({
    attemptId: "attempt:test",
    custody: { custodyRef: process.custodyRef },
    effectId: "effect:test",
    emit: async () => {},
    intent: { mode: "analysis", prompt: "Inspect only this disposable workspace." },
    isCancellationRequested: async () => false,
    operationId: "operation:test",
    workspaceRef: workspace,
  });
};

const preResponseNotification = (padding = ""): Message => ({
  method: "remoteControl/status/changed",
  params: { environmentId: null, installationId: "test", serverName: "test", status: "disabled" },
  padding,
});

const notificationsForBytes = (total: number): Message[] => {
  const notifications: Message[] = [];
  let remaining = total;
  while (remaining > 0) {
    const candidate = preResponseNotification("x".repeat(Math.min(900_000, remaining)));
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes > remaining) {
      const base = preResponseNotification("");
      const paddingLength = Math.max(0, remaining - Buffer.byteLength(JSON.stringify(base), "utf8"));
      const adjusted = preResponseNotification("x".repeat(paddingLength));
      const adjustedBytes = Buffer.byteLength(JSON.stringify(adjusted), "utf8");
      if (adjustedBytes !== remaining) {throw new Error("unable to construct exact notification bytes");}
      notifications.push(adjusted);
      remaining = 0;
    } else {
      notifications.push(candidate);
      remaining -= bytes;
    }
  }
  return notifications;
};

test("bounds pre-response notification bytes at the exact aggregate ceiling", async () => {
  const notifications = notificationsForBytes(CODEX_MAX_PRE_TURN_NOTIFICATION_BYTES);
  const outcome = await execute(target => {target.emit({ method: "turn/completed", params: {
    threadId: "thread:test", turn: generatedTurn("turn:adversarial", "completed"),
  } });}, 10_000, 10_000, {
    preResponse: (_method, target) => {for (const message of notifications.splice(0)) {target.emit(message);}},
  });
  assert.equal(outcome.kind, "completed");
});

test("fails closed on one-byte and count excess in pre-response buffers", async () => {
  for (const notifications of [
    notificationsForBytes(CODEX_MAX_PRE_TURN_NOTIFICATION_BYTES + 1),
    Array.from({ length: 257 }, () => preResponseNotification()),
  ]) {
    const outcome = await execute(() => {}, 10_000, 10_000, {
      preResponse: (_method, target) => {for (const message of notifications.splice(0)) {target.emit(message);}},
    });
    assert.equal(outcome.kind, "ambiguous");
  }
});

test("bounds many small pre-response notifications and rejects oversized configured lines", async () => {
  const notifications = Array.from({ length: 256 }, () => preResponseNotification("small"));
  const outcome = await execute(target => {target.emit({ method: "turn/completed", params: {
    threadId: "thread:test", turn: generatedTurn("turn:adversarial", "completed"),
  } });}, 10_000, 10_000, {
    preResponse: (_method, target) => {for (const message of notifications.splice(0)) {target.emit(message);}},
  });
  assert.equal(outcome.kind, "completed");
  await assert.rejects(() => execute(() => {}, 100, 100, { maxLineBytes: 1_048_577 }), /maxLineBytes/u);
});

test("shares the notification count budget across split-phase 256-plus-1 buffering", async () => {
  for (const [handshakeCount, expectedKind] of [[255, "completed"], [256, "ambiguous"]] as const) {
    const outcome = await execute(target => {target.emit({ method: "turn/completed", params: {
      threadId: "thread:test", turn: generatedTurn("turn:adversarial", "completed"),
    } });}, 10_000, 10_000, {
      preResponse: (method, target) => {
        const count = method === "thread/start" ? handshakeCount : method === "turn/start" ? 1 : 0;
        for (let index = 0; index < count; index += 1) {target.emit(preResponseNotification());}
      },
    });
    assert.equal(outcome.kind, expectedKind);
  }
});
