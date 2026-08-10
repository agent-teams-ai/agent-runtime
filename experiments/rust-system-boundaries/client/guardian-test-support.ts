import assert from "node:assert/strict";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, TextDecoder } from "node:util";

export const CURRENT_PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 64 * 1024;
export const RESPONSE_TIMEOUT_MS = 2_000;
export const execFile = promisify(execFileCallback);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const clientDirectory = dirname(fileURLToPath(import.meta.url));
const experimentDirectory = resolvePath(clientDirectory, "..");
export const repositoryDirectory = resolvePath(experimentDirectory, "..", "..");
const executableExtension = process.platform === "win32" ? ".exe" : "";

type SpawnCommand = {
  kind: "spawn";
  operation_id: string;
  opaque_fence: string;
  fixture_mode: "tree";
  drop_response: boolean;
};

type V1SpawnCommand = {
  kind: "spawn";
  operation_id: string;
  opaque_fence: string;
  fixture_mode: "tree";
};

type GuardianCommand =
  | V1SpawnCommand
  | SpawnCommand
  | { kind: "query"; operation_id: string }
  | { kind: "terminate"; operation_id: string; opaque_fence: string }
  | { kind: "inspect_containment" };

type RequestEnvelope = {
  protocol_version: number;
  request_id: string;
  command: GuardianCommand;
};

type CustodyObservation = {
  operation_id: string;
  custody_id: string;
  pid: number | null;
  state: string;
  spawn_attempts: number;
};

type ObservedStatus =
  | "spawned"
  | "replay"
  | "operation_already_exists"
  | "found"
  | "reconcile_verified_live"
  | "reconcile_gone"
  | "reconcile_identity_unverified"
  | "reconcile_launch_uncertain"
  | "fence_advanced"
  | "terminated";

type GuardianResult =
  | { status: ObservedStatus; observation: CustodyObservation }
  | { status: "not_found"; operation_id: string }
  | { status: "containment" }
  | { status: "rejected" | "protocol_rejected"; code: string; detail: string };

type ResponseEnvelope = {
  protocol_version: number;
  request_id: string | null;
  result: GuardianResult;
};

type ResponseWaiter = {
  resolve: (response: ResponseEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type OsProcessSnapshot = {
  pid: number;
  alive: boolean;
  processGroupId: number | null;
  state: string | null;
  command: string | null;
};

export type SyntheticProcessEvidence = {
  rootPid: number;
  descendantPid: number;
  recordedProcessGroupId: number | null;
};

const observedStatuses = new Set<ObservedStatus>([
  "spawned",
  "replay",
  "operation_already_exists",
  "found",
  "reconcile_verified_live",
  "reconcile_gone",
  "reconcile_identity_unverified",
  "reconcile_launch_uncertain",
  "fence_advanced",
  "terminated",
]);

let buildPromise: Promise<void> | undefined;

export const asRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void => {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  assert.deepEqual(actual, wanted, `${context} must use the closed-world schema`);
};

const asString = (value: unknown, context: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  return value;
};

export const asInteger = (value: unknown, context: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${context} must be a safe integer`);
  }
  return value;
};

const parseObservation = (value: unknown): CustodyObservation => {
  const observation = asRecord(value, "guardian observation");
  assertExactKeys(
    observation,
    ["operation_id", "custody_id", "pid", "state", "containment", "spawn_attempts"],
    "guardian observation",
  );
  const pid = observation.pid;
  if (pid !== null && (typeof pid !== "number" || !Number.isSafeInteger(pid))) {
    throw new Error("guardian observation pid must be an integer or null");
  }
  const containment = asRecord(observation.containment, "guardian containment report");
  assertExactKeys(
    containment,
    ["mechanism", "qualified_for_bounded_fixture", "limitation"],
    "guardian containment report",
  );
  asString(containment.mechanism, "guardian containment mechanism");
  if (typeof containment.qualified_for_bounded_fixture !== "boolean") {
    throw new Error("guardian containment qualification must be boolean");
  }
  if (containment.limitation !== null && typeof containment.limitation !== "string") {
    throw new Error("guardian containment limitation must be a string or null");
  }
  return {
    operation_id: asString(observation.operation_id, "guardian observation operation_id"),
    custody_id: asString(observation.custody_id, "guardian observation custody_id"),
    pid,
    state: asString(observation.state, "guardian observation state"),
    spawn_attempts: asInteger(
      observation.spawn_attempts,
      "guardian observation spawn_attempts",
    ),
  };
};

const parseResult = (value: unknown): GuardianResult => {
  const result = asRecord(value, "guardian result");
  const status = asString(result.status, "guardian result status");
  if (observedStatuses.has(status as ObservedStatus)) {
    assertExactKeys(result, ["status", "observation"], "guardian observed result");
    return {
      status: status as ObservedStatus,
      observation: parseObservation(result.observation),
    };
  }
  if (status === "not_found") {
    assertExactKeys(result, ["status", "operation_id"], "guardian not-found result");
    return {
      status,
      operation_id: asString(result.operation_id, "guardian result operation_id"),
    };
  }
  if (status === "containment") {
    assertExactKeys(result, ["status", "report"], "guardian containment result");
    const report = asRecord(result.report, "guardian containment report");
    assertExactKeys(
      report,
      ["mechanism", "qualified_for_bounded_fixture", "limitation"],
      "guardian containment report",
    );
    return { status };
  }
  if (status === "rejected" || status === "protocol_rejected") {
    assertExactKeys(result, ["status", "code", "detail"], "guardian rejection result");
    return {
      status,
      code: asString(result.code, "guardian rejection code"),
      detail: asString(result.detail, "guardian rejection detail"),
    };
  }
  throw new Error(`guardian result has unsupported status: ${status}`);
};

export const parseResponse = (line: string): ResponseEnvelope => {
  const response = asRecord(JSON.parse(line) as unknown, "guardian response");
  assertExactKeys(
    response,
    ["protocol_version", "request_id", "result"],
    "guardian response",
  );
  const requestId = response.request_id;
  if (requestId !== null && typeof requestId !== "string") {
    throw new Error("guardian response request_id must be a string or null");
  }
  const protocolVersion = asInteger(
    response.protocol_version,
    "guardian response protocol_version",
  );
  if (protocolVersion !== 1 && protocolVersion !== CURRENT_PROTOCOL_VERSION) {
    throw new Error(`guardian response used unsupported protocol version: ${protocolVersion}`);
  }
  return {
    protocol_version: protocolVersion,
    request_id: requestId,
    result: parseResult(response.result),
  };
};

export const assertResponseMatchesRequest = (
  request: RequestEnvelope,
  response: ResponseEnvelope,
): void => {
  const uncorrelatedProtocolRejection =
    response.request_id === null && response.result.status === "protocol_rejected";
  assert.ok(
    uncorrelatedProtocolRejection || response.request_id === request.request_id,
    "response request_id must match request unless decoding rejected the envelope before correlation",
  );
  if (!uncorrelatedProtocolRejection) {
    assert.equal(
      response.protocol_version,
      request.protocol_version,
      "a correlated Guardian response must use the request protocol version",
    );
  }
};

const within = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export const guardianArtifacts = (): { guardian: string; fixtureChild: string } => ({
  guardian: join(
    experimentDirectory,
    "target",
    "debug",
    `spike-guardian${executableExtension}`,
  ),
  fixtureChild: join(
    experimentDirectory,
    "target",
    "debug",
    `fixture-child${executableExtension}`,
  ),
});

const buildGuardian = async (): Promise<void> => {
  buildPromise ??= (async () => {
    await execFile(
      "cargo",
      [
        "build",
        "--locked",
        "--manifest-path",
        "Cargo.toml",
        "-p",
        "execution-guardian",
        "--bins",
      ],
      {
        cwd: experimentDirectory,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  })();
  await buildPromise;
};

export class GuardianClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #responses: ResponseEnvelope[] = [];
  readonly #waiters = new Set<ResponseWaiter>();
  readonly #exitPromise: Promise<ProcessExit>;
  #stderrTail = "";
  #exit: ProcessExit | undefined;
  #transportError: Error | undefined;
  #closed = false;
  readonly #stdoutFrame = Buffer.allocUnsafe(MAX_FRAME_BYTES);
  #stdoutFrameLength = 0;

  private constructor(child: ChildProcessWithoutNullStreams) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("guardian subprocess must expose stdin, stdout, and stderr");
    }
    this.#child = child;
    this.#exitPromise = new Promise<ProcessExit>((resolve) => {
      child.once("exit", (code, signal) => {
        this.#exit = { code, signal };
        const detail = this.#stderrTail.trim();
        this.#fail(
          new Error(
            `guardian exited before the protocol exchange completed (${String(code)}, ${String(
              signal,
            )})${detail.length === 0 ? "" : `: ${detail}`}`,
          ),
        );
        resolve(this.#exit);
      });
    });
    child.once("error", (error) => this.#fail(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stdout.once("close", () => {
      if (!this.#closed && this.#exit === undefined) {
        this.#fail(new Error("guardian closed stdout before it exited"));
      }
    });
  }

  static async start(stateRoot: string): Promise<GuardianClient> {
    await buildGuardian();
    const artifacts = guardianArtifacts();
    const child = spawn(
      artifacts.guardian,
      ["--root", stateRoot, "--fixture-child", artifacts.fixtureChild],
      { cwd: repositoryDirectory, stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;
    return new GuardianClient(child);
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  async request(request: RequestEnvelope, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<ResponseEnvelope> {
    await this.send(request);
    const response = await this.nextResponse(timeoutMs, `response for ${request.request_id}`);
    assertResponseMatchesRequest(request, response);
    return response;
  }

  async send(request: RequestEnvelope): Promise<void> {
    await this.sendRaw(JSON.stringify(request));
  }

  async sendRaw(frame: string): Promise<void> {
    if (this.#closed) {
      throw new Error("guardian client is closed");
    }
    if (this.#transportError !== undefined) {
      throw this.#transportError;
    }
    if (frame.includes("\n")) {
      throw new Error("client frames must be one NDJSON line");
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${frame}\n`, (error) => {
        if (error === undefined || error === null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  async nextResponse(timeoutMs: number, description: string): Promise<ResponseEnvelope> {
    const buffered = this.#responses.shift();
    if (buffered !== undefined) {
      return buffered;
    }
    if (this.#transportError !== undefined) {
      throw this.#transportError;
    }
    return await new Promise<ResponseEnvelope>((resolve, reject) => {
      let waiter: ResponseWaiter;
      const timer = setTimeout(() => {
        if (this.#waiters.delete(waiter)) {
          reject(new Error(`${description} timed out`));
        }
      }, timeoutMs);
      waiter = { resolve, reject, timer };
      this.#waiters.add(waiter);
    });
  }

  async crash(): Promise<void> {
    if (this.#exit !== undefined) {
      return;
    }
    this.#closed = true;
    this.#child.kill("SIGKILL");
    await within(this.#exitPromise, RESPONSE_TIMEOUT_MS, "guardian crash");
  }

  async close(): Promise<void> {
    if (this.#exit !== undefined) {
      return;
    }
    this.#closed = true;
    this.#child.stdin.end();
    try {
      await within(this.#exitPromise, RESPONSE_TIMEOUT_MS, "guardian shutdown");
    } catch (error) {
      this.#child.kill("SIGKILL");
      await within(this.#exitPromise, RESPONSE_TIMEOUT_MS, "forced guardian shutdown");
      throw error;
    }
  }

  #pushResponse(response: ResponseEnvelope): void {
    const waiter = this.#waiters.values().next().value as ResponseWaiter | undefined;
    if (waiter === undefined) {
      this.#responses.push(response);
      return;
    }
    this.#waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }

  #consumeStdout(chunk: Buffer): void {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const frame = utf8Decoder.decode(
          this.#stdoutFrame.subarray(0, this.#stdoutFrameLength),
        );
        this.#stdoutFrameLength = 0;
        try {
          this.#pushResponse(parseResponse(frame));
        } catch (error) {
          this.#fail(error instanceof Error ? error : new Error(String(error)));
          this.#child.kill("SIGKILL");
          return;
        }
        continue;
      }
      if (this.#stdoutFrameLength === MAX_FRAME_BYTES) {
        this.#fail(new Error("guardian response exceeded the bounded NDJSON frame limit"));
        this.#child.kill("SIGKILL");
        return;
      }
      this.#stdoutFrame[this.#stdoutFrameLength] = byte;
      this.#stdoutFrameLength += 1;
    }
  }

  #fail(error: Error): void {
    this.#transportError ??= error;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.#transportError);
    }
    this.#waiters.clear();
  }
}

export const inspectRequest = (requestId: string, protocolVersion: number): RequestEnvelope => ({
  protocol_version: protocolVersion,
  request_id: requestId,
  command: { kind: "inspect_containment" },
});

export const spawnRequest = (
  requestId: string,
  operationId: string,
  opaqueFence: string,
  dropResponse: boolean,
): RequestEnvelope => ({
  protocol_version: CURRENT_PROTOCOL_VERSION,
  request_id: requestId,
  command: {
    kind: "spawn",
    operation_id: operationId,
    opaque_fence: opaqueFence,
    fixture_mode: "tree",
    drop_response: dropResponse,
  },
});

export const v1SpawnRequest = (
  requestId: string,
  operationId: string,
  opaqueFence: string,
): RequestEnvelope => ({
  protocol_version: 1,
  request_id: requestId,
  command: {
    kind: "spawn",
    operation_id: operationId,
    opaque_fence: opaqueFence,
    fixture_mode: "tree",
  },
});

export const queryRequest = (requestId: string, operationId: string): RequestEnvelope => ({
  protocol_version: CURRENT_PROTOCOL_VERSION,
  request_id: requestId,
  command: { kind: "query", operation_id: operationId },
});

export const terminateRequest = (
  requestId: string,
  operationId: string,
  opaqueFence: string,
  protocolVersion = CURRENT_PROTOCOL_VERSION,
): RequestEnvelope => ({
  protocol_version: protocolVersion,
  request_id: requestId,
  command: { kind: "terminate", operation_id: operationId, opaque_fence: opaqueFence },
});

export const observed = (result: GuardianResult, status: ObservedStatus): CustodyObservation => {
  assert.equal(result.status, status);
  if (!("observation" in result)) {
    throw new Error(`guardian result ${status} did not include custody observation`);
  }
  return result.observation;
};
