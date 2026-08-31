import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import {
  CODEX_APP_SERVER_ADAPTER_REVISION,
  CODEX_APP_SERVER_BINARY_REVISION,
  CODEX_CAPABILITY_MANIFEST_REVISION,
  createCodexAppServerPermissionBoundary,
} from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CodexAppServerContainedTurnProvider } from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import type { CustodiedProviderProcess } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import { emitTurnStarted, generatedTurn } from "./codex-app-server-test-messages.mjs";

export type Message = Record<string, unknown>;
interface FakeCodexProcessBehavior {
  readonly closeWithoutEof?: boolean;
  readonly failStderr?: boolean;
  readonly hangClose?: boolean;
  readonly hangExit?: boolean;
  readonly hangStderr?: boolean;
  readonly hangWriteMethod?: string;
}

const syntheticRoot = mkdtempSync(join(tmpdir(), "agent-runtime-codex-boundary-test-"));
const syntheticCodexHome = join(syntheticRoot, "private-codex-home");
export const syntheticWorkspace = join(syntheticRoot, "workspace");
export const syntheticTmp = join(syntheticRoot, "tmp");
mkdirSync(syntheticCodexHome, { mode: 0o700 });
mkdirSync(syntheticWorkspace);
mkdirSync(syntheticTmp, { mode: 0o700 });
after(() => rmSync(syntheticRoot, { force: true, recursive: true }));

export const boundary = createCodexAppServerPermissionBoundary({
  codexHome: syntheticCodexHome,
  workspaceRef: syntheticWorkspace,
});
export const manifest = Object.freeze({
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
});

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #buffer: Uint8Array[] = [];
  readonly #waiters: ((value: IteratorResult<Uint8Array>) => void)[] = [];
  #ended = false;
  #failure: Error | undefined;
  public end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {waiter({ done: true, value: undefined });}
  }
  public push(bytes: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {this.#buffer.push(bytes);} else {waiter({ done: false, value: bytes });}
  }
  public fail(): void {this.#failure = new Error("synthetic iterator failure");}
  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        if (this.#failure !== undefined) {throw this.#failure;}
        const buffered = this.#buffer.shift();
        if (buffered !== undefined) {return { done: false, value: buffered };}
        if (this.#ended) {return { done: true, value: undefined };}
        return new Promise<IteratorResult<Uint8Array>>(resolve => {this.#waiters.push(resolve);});
      },
    };
  }
}

export class FakeCodexProcess implements CustodiedProviderProcess {
  readonly #onRequest: (message: Message, process: FakeCodexProcess) => void;
  public readonly custodyRef = "custody:codex:test";
  public readonly environment: Readonly<Record<string, string>>;
  public readonly requests: Message[] = [];
  public readonly stderr = new AsyncByteQueue();
  public readonly stdout = new AsyncByteQueue();
  public closeCount = 0;
  public readonly events: string[] = [];
  readonly #behavior: FakeCodexProcessBehavior;
  public constructor(
    onRequest: (message: Message, process: FakeCodexProcess) => void,
    behavior: FakeCodexProcessBehavior = {},
    environment: Readonly<Record<string, string>> = {
      CODEX_HOME: boundary.codexHome,
      HOME: boundary.codexHome,
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: syntheticTmp,
    },
  ) {
    this.#onRequest = onRequest;
    this.#behavior = behavior;
    this.environment = Object.freeze({ ...environment });
    if (behavior.failStderr === true) {this.stderr.fail();}
    else if (behavior.hangStderr !== true) {this.stderr.end();}
  }
  public closeInput(): Promise<void> {
    this.closeCount += 1;
    this.events.push("close-input");
    if (this.#behavior.hangClose === true) {return new Promise(() => {});}
    if (this.#behavior.closeWithoutEof !== true) {this.stdout.end();}
    return Promise.resolve();
  }
  public emit(message: Message): void {
    this.stdout.push(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
  }
  public waitForExit(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
    this.events.push("wait-exit");
    if (this.#behavior.hangExit === true) {return new Promise(() => {});}
    return Promise.resolve({ code: 0, signal: null });
  }
  public async write(bytes: Uint8Array): Promise<void> {
    for (const line of Buffer.from(bytes).toString("utf8").trim().split("\n")) {
      if (line.length === 0) {continue;}
      const message = JSON.parse(line) as Message;
      this.requests.push(message);
      this.#onRequest(message, this);
      if (message.method === this.#behavior.hangWriteMethod) {await new Promise(() => {});}
    }
  }
}

export const exactConfigResult = (): Message => ({
  config: {
    default_permissions: boundary.permissionProfileId,
    permissions: { [boundary.permissionProfileId]: boundary.permissionProfile },
  },
  layers: [
    { config: {}, disabledReason: null, name: { file: "/opt/codex/defaults.toml", type: "packagedDefaults" }, version: "1" },
    {
      config: { permissions: { [boundary.permissionProfileId]: boundary.permissionProfile } },
      disabledReason: null,
      name: { file: `${boundary.codexHome}/config.toml`, profile: null, type: "user" },
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
    permissions: { name: { file: `${boundary.codexHome}/config.toml`, profile: null, type: "user" }, version: "2" },
  },
});

export const standardHandshake = (message: Message, process: FakeCodexProcess): boolean => {
  if (message.method === "initialize") {
    process.emit({
      id: message.id,
      result: { codexHome: boundary.codexHome, platformFamily: "unix", platformOs: "linux", userAgent: "codex/0.150.1" },
    });
    return true;
  }
  if (message.method === "initialized") {return true;}
  if (message.method === "config/read") {
    process.emit({ id: message.id, result: exactConfigResult() });
    return true;
  }
  if (message.method === "permissionProfile/list") {
    process.emit({
      id: message.id,
      result: { data: [{ allowed: true, description: null, id: boundary.permissionProfileId }], nextCursor: null },
    });
    return true;
  }
  if (message.method === "thread/start") {
    const sandbox = (message.params as Message).sandbox;
    const sandboxPolicy = sandbox === "read-only"
      ? { networkAccess: false, type: "readOnly" }
      : {
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
          networkAccess: false,
          type: "workspaceWrite",
          writableRoots: [boundary.workspaceRef],
        };
    process.emit({
      method: "thread/settings/updated",
      params: {
        threadId: "thread:test",
        threadSettings: {
          activePermissionProfile: { extends: ":workspace", id: boundary.permissionProfileId },
          approvalPolicy: "never",
          cwd: boundary.workspaceRef,
          sandboxPolicy,
        },
      },
    });
    process.emit({ id: message.id, result: { thread: { id: "thread:test" } } });
    return true;
  }
  return false;
};

export const rejectInitialize = (message: Message, target: FakeCodexProcess): void => {
  if (message.method === "initialize") {target.emit({ id: message.id, result: {} });}
};

export const createProvider = (process: FakeCodexProcess, overrides: {
  readonly maxActiveNotificationBytes?: number;
  readonly maxActiveNotifications?: number;
  readonly turnTimeoutMs?: number;
} = {}) => new CodexAppServerContainedTurnProvider({
  boundary,
  cancellationPollMs: 2,
  manifest,
  ...(overrides.maxActiveNotificationBytes === undefined ? {} : {
    maxActiveNotificationBytes: overrides.maxActiveNotificationBytes,
  }),
  ...(overrides.maxActiveNotifications === undefined ? {} : {
    maxActiveNotifications: overrides.maxActiveNotifications,
  }),
  processes: {
    get(custodyRef) {
      if (custodyRef === process.custodyRef) {return process;}
    },
  },
  requestTimeoutMs: 2_000,
  tmpDir: syntheticTmp,
  turnTimeoutMs: overrides.turnTimeoutMs ?? 2_000,
});

export const executeInput = (
  process: FakeCodexProcess,
  cancellation = async () => false,
  mode: "analysis" | "workspace-write" = "analysis",
) => ({
  attemptId: "attempt:test",
  custody: { custodyRef: process.custodyRef },
  effectId: "effect:test",
  emit: async (_chunk: { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }) => {},
  intent: { mode, prompt: "Inspect only this disposable workspace." },
  isCancellationRequested: cancellation,
  operationId: "operation:test",
  workspaceRef: boundary.workspaceRef,
});

export const completedProcess = () => new FakeCodexProcess((message, target) => {
  if (standardHandshake(message, target)) {return;}
  if (message.method === "turn/start") {
    target.emit({ id: message.id, result: { turn: generatedTurn("turn:receipt", "inProgress") } });
    emitTurnStarted(target, "turn:receipt");
    target.emit({ method: "turn/completed", params: { threadId: "thread:test", turn: generatedTurn("turn:receipt", "completed") } });
  }
});

export const completedReceiptRefs = (
  outcome: Awaited<ReturnType<CodexAppServerContainedTurnProvider["execute"]>>,
): readonly string[] => {
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") {throw new Error("expected completed outcome");}
  return [outcome.acceptanceReceiptRef, outcome.effectReceiptRef, outcome.executionReceiptRef, outcome.outputDrainReceiptRef];
};

export const expectedCompletedReceipt = (
  kind: string,
  identity: { readonly attemptId: string; readonly effectId: string; readonly operationId: string },
  status: "completed" | "failed" | "interrupted" = "completed",
): string => `urn:agent-runtime:${kind}:${createHash("sha256").update(JSON.stringify({
  adapterRevision: CODEX_APP_SERVER_ADAPTER_REVISION,
  attemptId: identity.attemptId,
  binaryRevision: CODEX_APP_SERVER_BINARY_REVISION,
  codes: [status === "completed" ? "codex-protocol-terminal-completed-observed"
    : status === "interrupted" ? "codex-protocol-terminal-interrupted-observed"
      : "codex-protocol-terminal-failed-observed"],
  effectId: identity.effectId,
  kind,
  operationId: identity.operationId,
  protocolRevision: CODEX_CAPABILITY_MANIFEST_REVISION,
  provider: "codex",
  redaction: "product-owned-receipt-identity/v2",
})).digest("hex")}`;
