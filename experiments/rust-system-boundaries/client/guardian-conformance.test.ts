import assert from "node:assert/strict";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify, TextDecoder } from "node:util";

const CURRENT_PROTOCOL_VERSION = 2;
const MAX_FRAME_BYTES = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 2_000;
const execFile = promisify(execFileCallback);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const clientDirectory = dirname(fileURLToPath(import.meta.url));
const experimentDirectory = resolve(clientDirectory, "..");
const repositoryDirectory = resolve(experimentDirectory, "..", "..");
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

type OsProcessSnapshot = {
  pid: number;
  alive: boolean;
  processGroupId: number | null;
  state: string | null;
  command: string | null;
};

type SyntheticProcessEvidence = {
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

const asRecord = (value: unknown, context: string): Record<string, unknown> => {
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
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert.deepEqual(actual, wanted, `${context} must use the closed-world schema`);
};

const asString = (value: unknown, context: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  return value;
};

const asInteger = (value: unknown, context: string): number => {
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

const parseResponse = (line: string): ResponseEnvelope => {
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

const assertResponseMatchesRequest = (
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
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const guardianArtifacts = (): { guardian: string; fixtureChild: string } => ({
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

class GuardianClient {
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
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#child.stdin.write(`${frame}\n`, (error) => {
        if (error === undefined || error === null) {
          resolveWrite();
        } else {
          rejectWrite(error);
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
    return await new Promise<ResponseEnvelope>((resolveResponse, rejectResponse) => {
      let waiter: ResponseWaiter;
      const timer = setTimeout(() => {
        if (this.#waiters.delete(waiter)) {
          rejectResponse(new Error(`${description} timed out`));
        }
      }, timeoutMs);
      waiter = { resolve: resolveResponse, reject: rejectResponse, timer };
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

const inspectRequest = (requestId: string, protocolVersion: number): RequestEnvelope => ({
  protocol_version: protocolVersion,
  request_id: requestId,
  command: { kind: "inspect_containment" },
});

const spawnRequest = (
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

const v1SpawnRequest = (
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

const queryRequest = (requestId: string, operationId: string): RequestEnvelope => ({
  protocol_version: CURRENT_PROTOCOL_VERSION,
  request_id: requestId,
  command: { kind: "query", operation_id: operationId },
});

const terminateRequest = (
  requestId: string,
  operationId: string,
  opaqueFence: string,
  protocolVersion = CURRENT_PROTOCOL_VERSION,
): RequestEnvelope => ({
  protocol_version: protocolVersion,
  request_id: requestId,
  command: { kind: "terminate", operation_id: operationId, opaque_fence: opaqueFence },
});

const observed = (result: GuardianResult, status: ObservedStatus): CustodyObservation => {
  assert.equal(result.status, status);
  if (!("observation" in result)) {
    throw new Error(`guardian result ${status} did not include custody observation`);
  }
  return result.observation;
};

const inspectProcess = async (pid: number): Promise<OsProcessSnapshot> => {
  if (process.platform === "win32") {
    const { stdout } = await execFile(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { cwd: repositoryDirectory },
    );
    const match = stdout.trim().match(/^"([^"]+)","([0-9]+)"/);
    if (match === null || Number(match[2]) !== pid) {
      return { pid, alive: false, processGroupId: null, state: null, command: null };
    }
    return {
      pid,
      alive: true,
      processGroupId: null,
      state: null,
      command: match[1] ?? null,
    };
  }

  try {
    const { stdout } = await execFile(
      "ps",
      ["-p", String(pid), "-o", "pgid=", "-o", "stat=", "-o", "command="],
      { cwd: repositoryDirectory },
    );
    const match = stdout.trim().match(/^([0-9]+)\s+(\S+)\s+(.+)$/);
    if (match === null) {
      return { pid, alive: false, processGroupId: null, state: null, command: null };
    }
    return {
      pid,
      alive: true,
      processGroupId: Number(match[1]),
      state: match[2] ?? null,
      command: match[3] ?? null,
    };
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === "ESRCH") {
      return { pid, alive: false, processGroupId: null, state: null, command: null };
    }
    throw error;
  }
};

const assertSyntheticIdentity = (snapshot: OsProcessSnapshot): void => {
  if (!snapshot.alive) {
    return;
  }
  const command = snapshot.command ?? "";
  const fixtureName = basename(guardianArtifacts().fixtureChild).toLowerCase();
  const matchesFixture =
    process.platform === "win32"
      ? command.toLowerCase() === fixtureName
      : command.includes(guardianArtifacts().fixtureChild);
  assert.ok(
    matchesFixture,
    `refusing to treat PID ${snapshot.pid} as synthetic fixture: ${command || "unknown command"}`,
  );
};

const inspectSyntheticProcesses = async (
  evidence: SyntheticProcessEvidence,
): Promise<[OsProcessSnapshot, OsProcessSnapshot]> => {
  const [root, descendant] = await Promise.all([
    inspectProcess(evidence.rootPid),
    inspectProcess(evidence.descendantPid),
  ]);
  return [root, descendant];
};

const assertSyntheticProcessesGone = async (
  evidence: SyntheticProcessEvidence,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let snapshots = await inspectSyntheticProcesses(evidence);
  while (snapshots.some((snapshot) => snapshot.alive) && Date.now() < deadline) {
    await delay(25);
    snapshots = await inspectSyntheticProcesses(evidence);
  }
  const survivors = snapshots.filter((snapshot) => snapshot.alive);
  assert.equal(
    survivors.length,
    0,
    `synthetic processes survived teardown: ${survivors
      .map(
        (snapshot) =>
          `pid=${snapshot.pid} pgid=${String(snapshot.processGroupId)} state=${String(
            snapshot.state,
          )} command=${String(snapshot.command)}`,
      )
      .join("; ")}`,
  );
};

const waitForSyntheticProcessEvidence = async (
  stateRoot: string,
  operationId: string,
): Promise<SyntheticProcessEvidence> => {
  const custodyPath = join(stateRoot, "custody", `${operationId}.json`);
  const descendantPath = join(stateRoot, "operations", operationId, "descendant.pid");
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const custody = asRecord(
        JSON.parse(await readFile(custodyPath, "utf8")) as unknown,
        "durable custody witness",
      );
      assert.equal(custody.state, "live");
      assert.equal(custody.spawn_attempts, 1);
      const rootPid = asInteger(custody.pid, "custody root pid");
      const recordedProcessGroupId =
        custody.process_group_id === null
          ? null
          : asInteger(custody.process_group_id, "custody process group id");
      const descendantPid = Number((await readFile(descendantPath, "utf8")).trim());
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

      // The fixture emits its bounded-output burst immediately after publishing
      // the descendant PID. Keep Guardian's pipe readers alive until it finishes.
      await delay(200);
      const evidence = { rootPid, descendantPid, recordedProcessGroupId };
      const [root, descendant] = await inspectSyntheticProcesses(evidence);
      assert.equal(root.alive, true, "synthetic root must be live before Guardian crash");
      assert.equal(descendant.alive, true, "synthetic descendant must be live before Guardian crash");
      assertSyntheticIdentity(root);
      assertSyntheticIdentity(descendant);
      if (process.platform !== "win32") {
        assert.equal(recordedProcessGroupId, rootPid, "recorded PGID must identify the root");
        assert.equal(root.processGroupId, recordedProcessGroupId, "root must be in recorded PGID");
        assert.equal(
          descendant.processGroupId,
          recordedProcessGroupId,
          "descendant must initially inherit the recorded PGID",
        );
      }
      return evidence;
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  throw new Error("synthetic fixture did not publish complete live PID evidence", {
    cause: lastError,
  });
};

const requestGuardianTermination = async (
  preferredClient: GuardianClient | undefined,
  stateRoot: string,
  operationId: string,
  opaqueFence: string,
): Promise<void> => {
  let client = preferredClient;
  let ownsClient = false;
  try {
    if (client === undefined || client.exited) {
      client = await GuardianClient.start(stateRoot);
      ownsClient = true;
    }
    const response = await client.request(
      terminateRequest("cleanup-terminate", operationId, opaqueFence),
    );
    if (response.result.status !== "terminated" && response.result.status !== "reconcile_gone") {
      throw new Error(`cleanup did not reach a terminal custody state: ${response.result.status}`);
    }
  } catch (firstError) {
    if (client !== undefined && !client.exited) {
      await client.crash().catch(() => undefined);
    }
    const recovery = await GuardianClient.start(stateRoot);
    try {
      const response = await recovery.request(
        terminateRequest("cleanup-recovery-terminate", operationId, opaqueFence),
      );
      if (response.result.status !== "terminated" && response.result.status !== "reconcile_gone") {
        throw new Error(
          `recovery cleanup did not reach a terminal custody state: ${response.result.status}`,
        );
      }
    } catch (recoveryError) {
      throw new AggregateError(
        [firstError, recoveryError],
        "Guardian cleanup did not produce a terminal response",
      );
    } finally {
      await recovery.close().catch(() => undefined);
    }
  } finally {
    if (ownsClient && client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }
};

const cleanupSyntheticOperation = async (
  preferredClient: GuardianClient | undefined,
  stateRoot: string,
  operationId: string,
  opaqueFence: string,
  evidence: SyntheticProcessEvidence,
): Promise<void> => {
  const failures: unknown[] = [];
  try {
    await requestGuardianTermination(preferredClient, stateRoot, operationId, opaqueFence);
  } catch (error) {
    failures.push(error);
  }
  try {
    await assertSyntheticProcessesGone(evidence, 1_000);
    return;
  } catch (error) {
    failures.push(error);
  }
  throw new AggregateError(
    failures,
    `Guardian cleanup failed closed; synthetic evidence retained at ${stateRoot}`,
  );
};

test("TypeScript response decoder rejects schema drift", () => {
  const valid = {
    protocol_version: CURRENT_PROTOCOL_VERSION,
    request_id: "inspect",
    result: {
      status: "containment",
      report: {
        mechanism: "unix_process_group",
        qualified_for_bounded_fixture: true,
        limitation: null,
      },
    },
  };

  assert.equal(parseResponse(JSON.stringify(valid)).result.status, "containment");
  assert.throws(
    () => parseResponse(JSON.stringify({ ...valid, unexpected: true })),
    /closed-world schema/,
  );
  assert.throws(
    () =>
      parseResponse(
        JSON.stringify({
          ...valid,
          result: { ...valid.result, unexpected: true },
        }),
      ),
    /closed-world schema/,
  );

  const mismatchedCorrelatedResponse = parseResponse(
    JSON.stringify({
      ...valid,
      protocol_version: 1,
    }),
  );
  assert.throws(
    () =>
      assertResponseMatchesRequest(
        inspectRequest("inspect", CURRENT_PROTOCOL_VERSION),
        mismatchedCorrelatedResponse,
      ),
    /must use the request protocol version/,
  );
});

test(
  "frozen N-1 TypeScript request shape runs against the current Guardian",
  { timeout: 90_000 },
  async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agent-runtime-guardian-v1-client-"));
    const operationId = `ts-v1-${process.pid}-${Date.now()}`;
    const opaqueFence = `v1-fence-${process.pid}-${Date.now()}`;
    let client: GuardianClient | undefined;
    let evidence: SyntheticProcessEvidence | undefined;
    let testError: unknown;

    try {
      client = await GuardianClient.start(stateRoot);
      const spawned = await client.request(
        v1SpawnRequest("v1-spawn", operationId, opaqueFence),
      );
      assert.equal(spawned.protocol_version, 1);
      observed(spawned.result, "spawned");
      evidence = await waitForSyntheticProcessEvidence(stateRoot, operationId);

      const terminated = await client.request(
        terminateRequest("v1-terminate", operationId, opaqueFence, 1),
      );
      assert.equal(terminated.protocol_version, 1);
      observed(terminated.result, "terminated");
      await assertSyntheticProcessesGone(evidence);
    } catch (error) {
      testError = error;
    }

    let cleanupError: unknown;
    if (evidence !== undefined) {
      try {
        await cleanupSyntheticOperation(
          client,
          stateRoot,
          operationId,
          opaqueFence,
          evidence,
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    await client?.close().catch(() => undefined);
    if (cleanupError === undefined) {
      await rm(stateRoot, { recursive: true, force: true });
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "N-1 test and exact synthetic cleanup failed",
      );
    }
    if (testError !== undefined) {
      throw testError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  },
);

test(
  "TypeScript caller preserves one operation identity across Guardian process loss",
  { timeout: 60_000 },
  async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agent-runtime-guardian-client-"));
    const operationId = `ts-ambiguous-${process.pid}-${Date.now()}`;
    const opaqueFence = `opaque-fence-${process.pid}-${Date.now()}`;
    let firstGuardian: GuardianClient | undefined;
    let restartedGuardian: GuardianClient | undefined;
    let processEvidence: SyntheticProcessEvidence | undefined;
    let spawned = false;
    let livenessProven = false;
    let testError: unknown;

    try {
      firstGuardian = await GuardianClient.start(stateRoot);

      const current = await firstGuardian.request(inspectRequest("inspect-n", 2));
      assert.equal(current.protocol_version, 2);
      assert.equal(current.result.status, "containment");

      const previous = await firstGuardian.request(inspectRequest("inspect-n-minus-1", 1));
      assert.equal(previous.protocol_version, 1);
      assert.equal(previous.result.status, "containment");

      const newer = await firstGuardian.request(inspectRequest("inspect-n-plus-1", 3));
      assert.equal(newer.request_id, null);
      assert.equal(newer.result.status, "protocol_rejected");
      if (newer.result.status === "protocol_rejected") {
        assert.equal(newer.result.code, "unsupported_version");
      }

      await firstGuardian.sendRaw(
        '{"protocol_version":2,"request_id":"malformed","unexpected":true,"command":{"kind":"inspect_containment"}}',
      );
      const malformed = await firstGuardian.nextResponse(RESPONSE_TIMEOUT_MS, "malformed response");
      assert.equal(malformed.request_id, null);
      assert.equal(malformed.result.status, "protocol_rejected");
      if (malformed.result.status === "protocol_rejected") {
        assert.equal(malformed.result.code, "malformed_frame");
      }

      await firstGuardian.sendRaw("x".repeat(MAX_FRAME_BYTES + 1));
      const oversized = await firstGuardian.nextResponse(RESPONSE_TIMEOUT_MS, "oversized response");
      assert.equal(oversized.request_id, null);
      assert.equal(oversized.result.status, "protocol_rejected");
      if (oversized.result.status === "protocol_rejected") {
        assert.equal(oversized.result.code, "frame_too_large");
      }

      const transportStillHealthy = await firstGuardian.request(
        inspectRequest("inspect-after-rejections", CURRENT_PROTOCOL_VERSION),
      );
      assert.equal(transportStillHealthy.result.status, "containment");

      spawned = true;
      await firstGuardian.send(
        spawnRequest("spawn-lost-response", operationId, opaqueFence, true),
      );
      await assert.rejects(
        firstGuardian.nextResponse(250, "intentionally dropped spawn response"),
        /timed out/,
      );

      processEvidence = await waitForSyntheticProcessEvidence(stateRoot, operationId);

      await firstGuardian.crash();
      restartedGuardian = await GuardianClient.start(stateRoot);

      const reconciled = await restartedGuardian.request(
        queryRequest("reconcile-after-guardian-crash", operationId),
      );
      // KILL_ON_JOB_CLOSE reaps Windows fixtures with the Guardian; POSIX process
      // groups outlive the Guardian and must be reconciled by the replacement.
      const expectedReconciliation =
        process.platform === "win32" ? "reconcile_gone" : "reconcile_verified_live";
      const reconciledObservation = observed(reconciled.result, expectedReconciliation);
      assert.equal(reconciledObservation.operation_id, operationId);
      assert.equal(reconciledObservation.spawn_attempts, 1);
      assert.equal(reconciledObservation.pid, processEvidence.rootPid);

      const retry = await restartedGuardian.request(
        spawnRequest("would-be-retry", operationId, opaqueFence, false),
      );
      const retryObservation = observed(retry.result, "operation_already_exists");
      assert.equal(retryObservation.custody_id, reconciledObservation.custody_id);
      assert.equal(retryObservation.pid, reconciledObservation.pid);
      assert.equal(retryObservation.spawn_attempts, 1);

      const terminated = await restartedGuardian.request(
        terminateRequest("terminate-matching-fence", operationId, opaqueFence),
      );
      const expectedTermination = process.platform === "win32" ? "reconcile_gone" : "terminated";
      const terminatedObservation = observed(terminated.result, expectedTermination);
      assert.equal(terminatedObservation.custody_id, reconciledObservation.custody_id);
      if (process.platform !== "win32") {
        assert.equal(terminatedObservation.state, "terminated");
      }
      await assertSyntheticProcessesGone(processEvidence);
      livenessProven = true;
    } catch (error) {
      testError = error;
    }

    let cleanupError: unknown;
    if (spawned) {
      try {
        processEvidence ??= await waitForSyntheticProcessEvidence(stateRoot, operationId);
        if (!livenessProven) {
          await cleanupSyntheticOperation(
            restartedGuardian ?? firstGuardian,
            stateRoot,
            operationId,
            opaqueFence,
            processEvidence,
          );
        }
        await assertSyntheticProcessesGone(processEvidence, 1_000);
      } catch (error) {
        cleanupError = error;
      }
    }

    await restartedGuardian?.close().catch(() => undefined);
    await firstGuardian?.close().catch(() => undefined);
    if (cleanupError === undefined) {
      await rm(stateRoot, { recursive: true, force: true });
    }

    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([testError, cleanupError], "test and exact synthetic cleanup failed");
    }
    if (testError !== undefined) {
      throw testError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  },
);
