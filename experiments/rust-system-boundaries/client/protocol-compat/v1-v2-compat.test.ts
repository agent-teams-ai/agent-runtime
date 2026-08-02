import assert from "node:assert/strict";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const clientDirectory = dirname(fileURLToPath(import.meta.url));
const experimentDirectory = resolve(clientDirectory, "..", "..");
const executableExtension = process.platform === "win32" ? ".exe" : "";
const protocolServer =
  process.env.BOUNDARY_PROTOCOL_COMPAT_SERVER ??
  join(
    experimentDirectory,
    "target",
    "debug",
    `protocol-compat-server${executableExtension}`,
  );
const EXCHANGE_TIMEOUT_MS = 10_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 2_000;

type FrozenV1AcceptedResponse = {
  kind: "accepted";
  operation_id: string;
  custody_state: string;
};

type FrozenV1Response = {
  protocol_version: 1;
  request_id: string | null;
  result: FrozenV1AcceptedResponse;
};

type CurrentV2Response = {
  protocol_version: 2;
  request_id: string | null;
  result: FrozenV1AcceptedResponse & { execution_id: string | null };
};

const v1Hello =
  '{"kind":"protocol_hello","handshake_version":1,"supported_protocol_versions":[1]}';
const v1Request =
  '{"protocol_version":1,"request_id":"v1-request","command":{"kind":"spawn","operation_id":"operation-v1","opaque_fence":"fence-v1","fixture_mode":"tree"}}';
const v2Hello =
  '{"kind":"protocol_hello","handshake_version":2,"supported_protocol_versions":[2,1]}';
const futureV3ClientHello =
  '{"kind":"protocol_hello","handshake_version":2,"supported_protocol_versions":[3,2,1]}';
const v2Request =
  '{"protocol_version":2,"request_id":"v2-request","command":{"kind":"spawn","operation_id":"operation-v2","opaque_fence":"fence-v2","fixture_mode":"tree","drop_response":false}}';
const unsupportedHello =
  '{"kind":"protocol_hello","handshake_version":2,"supported_protocol_versions":[3]}';

type HelloExpectation = {
  handshakeVersion: 1 | 2;
  clientVersions: readonly number[];
  selectedVersion: 1 | 2;
};

type ExchangeOptions = {
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
};

type ExchangeResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

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
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${context} schema drift`);
};

const asStringOrNull = (value: unknown, context: string): string | null => {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${context} must be a string or null`);
  }
  return value;
};

const asProtocolVersions = (value: unknown, context: string): number[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some(
      (version) => !Number.isInteger(version) || (version as number) < 1 || (version as number) > 65_535,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${context} must be an array of protocol versions`);
  }
  return value;
};

const parseHelloAck = (line: string, expected: HelloExpectation): void => {
  const value = asRecord(JSON.parse(line) as unknown, "protocol hello acknowledgement");
  assertExactKeys(
    value,
    expected.handshakeVersion === 1
      ? ["kind", "handshake_version", "selected_protocol_version"]
      : [
          "kind",
          "handshake_version",
          "selected_protocol_version",
          "server_supported_protocol_versions",
        ],
    "protocol hello acknowledgement",
  );
  assert.equal(value.kind, "protocol_hello_ack");
  assert.equal(value.handshake_version, expected.handshakeVersion);
  assert.equal(value.selected_protocol_version, expected.selectedVersion);

  if (expected.handshakeVersion === 2) {
    const serverVersions = asProtocolVersions(
      value.server_supported_protocol_versions,
      "server-supported protocol versions",
    );
    const highestMutual = Math.max(
      ...expected.clientVersions.filter((version) => serverVersions.includes(version)),
    );
    assert.ok(Number.isFinite(highestMutual), "current handshake requires a mutual version");
    assert.equal(
      value.selected_protocol_version,
      highestMutual,
      "current handshake must select the highest version both sides explicitly support",
    );
  }
};

const parseHelloRejection = (line: string, handshakeVersion: 1 | 2): void => {
  const value = asRecord(JSON.parse(line) as unknown, "protocol hello rejection");
  assertExactKeys(
    value,
    ["kind", "handshake_version", "code", "detail"],
    "protocol hello rejection",
  );
  assert.equal(value.kind, "protocol_hello_rejected");
  assert.equal(value.handshake_version, handshakeVersion);
  assert.equal(value.code, "no_mutual_version");
  assert.equal(typeof value.detail, "string");
};

// This parser intentionally contains no import from the current v2 model.
const parseFrozenV1Response = (line: string): FrozenV1Response => {
  const envelope = asRecord(JSON.parse(line) as unknown, "frozen v1 response");
  assertExactKeys(envelope, ["protocol_version", "request_id", "result"], "frozen v1 envelope");
  assert.equal(envelope.protocol_version, 1);
  const result = asRecord(envelope.result, "frozen v1 result");
  assertExactKeys(
    result,
    ["kind", "operation_id", "custody_state"],
    "frozen v1 accepted result",
  );
  assert.equal(result.kind, "accepted");
  if (typeof result.operation_id !== "string" || typeof result.custody_state !== "string") {
    throw new Error("frozen v1 accepted response fields must be strings");
  }
  return {
    protocol_version: 1,
    request_id: asStringOrNull(envelope.request_id, "frozen v1 request_id"),
    result: {
      kind: "accepted",
      operation_id: result.operation_id,
      custody_state: result.custody_state,
    },
  };
};

const parseCurrentV2Response = (line: string): CurrentV2Response => {
  const envelope = asRecord(JSON.parse(line) as unknown, "current v2 response");
  assertExactKeys(envelope, ["protocol_version", "request_id", "result"], "current v2 envelope");
  assert.equal(envelope.protocol_version, 2);
  const result = asRecord(envelope.result, "current v2 result");
  assertExactKeys(
    result,
    ["kind", "operation_id", "custody_state", "execution_id"],
    "current v2 accepted result",
  );
  assert.equal(result.kind, "accepted");
  if (typeof result.operation_id !== "string" || typeof result.custody_state !== "string") {
    throw new Error("current v2 accepted response fields must be strings");
  }
  return {
    protocol_version: 2,
    request_id: asStringOrNull(envelope.request_id, "current v2 request_id"),
    result: {
      kind: "accepted",
      operation_id: result.operation_id,
      custody_state: result.custody_state,
      execution_id: asStringOrNull(result.execution_id, "current v2 execution_id"),
    },
  };
};

const buildServer = async (): Promise<void> => {
  if (process.env.BOUNDARY_PROTOCOL_COMPAT_SERVER !== undefined) {
    return;
  }
  buildPromise ??= execFile(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      "Cargo.toml",
      "-p",
      "boundary-protocol",
      "--bin",
      "protocol-compat-server",
    ],
    { cwd: experimentDirectory, maxBuffer: 4 * 1024 * 1024 },
  ).then(() => undefined);
  await buildPromise;
};

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
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

const runExchange = async (
  frames: readonly string[],
  options: ExchangeOptions = {},
): Promise<ExchangeResult> => {
  await buildServer();
  const child = spawn(options.command ?? protocolServer, options.args ?? [], {
    cwd: experimentDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  options.onSpawn?.(child);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveCompletion, rejectCompletion) => {
      child.once("error", rejectCompletion);
      child.once("close", (code, signal) => resolveCompletion({ code, signal }));
    },
  );
  try {
    child.stdin.end(`${frames.join("\n")}\n`);
    const exit = await withTimeout(
      completion,
      options.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
      "protocol compatibility exchange",
    );
    return {
      ...exit,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await withTimeout(
        completion.catch(() => undefined),
        PROCESS_CLEANUP_TIMEOUT_MS,
        "protocol compatibility child cleanup",
      ).catch(() => undefined);
    }
  }
};

const exchange = async (frames: readonly string[]): Promise<readonly string[]> => {
  const result = await runExchange(frames);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
};

test("frozen v1 client and current v2 server negotiate and project both directions", async () => {
  const frames = await exchange([v1Hello, v1Request]);
  assert.equal(frames.length, 2);
  parseHelloAck(frames[0]!, {
    handshakeVersion: 1,
    clientVersions: [1],
    selectedVersion: 1,
  });
  const response = parseFrozenV1Response(frames[1]!);
  assert.equal(response.request_id, "v1-request");
  assert.equal(response.result.operation_id, "operation-v1");
  assert.equal(response.result.custody_state, "accepted");
  assert.equal(Object.hasOwn(response.result, "execution_id"), false);
});

test("current v2 client retains the current response-only execution correlation", async () => {
  const frames = await exchange([v2Hello, v2Request]);
  assert.equal(frames.length, 2);
  parseHelloAck(frames[0]!, {
    handshakeVersion: 2,
    clientVersions: [2, 1],
    selectedVersion: 2,
  });
  const response = parseCurrentV2Response(frames[1]!);
  assert.equal(response.request_id, "v2-request");
  assert.equal(response.result.operation_id, "operation-v2");
  assert.equal(response.result.execution_id, "compatibility-execution-1");
});

test("current server accepts a bounded future client advertisement and selects its highest known mutual version", async () => {
  const frames = await exchange([futureV3ClientHello, v2Request]);
  assert.equal(frames.length, 2);
  parseHelloAck(frames[0]!, {
    handshakeVersion: 2,
    clientVersions: [3, 2, 1],
    selectedVersion: 2,
  });
  const response = parseCurrentV2Response(frames[1]!);
  assert.equal(response.request_id, "v2-request");
  assert.equal(response.result.operation_id, "operation-v2");
});

test("unsupported protocol versions receive a typed negotiation rejection", async () => {
  const frames = await exchange([unsupportedHello]);
  assert.equal(frames.length, 1);
  parseHelloRejection(frames[0]!, 2);
});

test("current client rejects a declared downgrade even when the frame is otherwise valid", () => {
  assert.throws(
    () =>
      parseHelloAck(
        '{"kind":"protocol_hello_ack","handshake_version":2,"selected_protocol_version":1,"server_supported_protocol_versions":[2,1]}',
        {
          handshakeVersion: 2,
          clientVersions: [2, 1],
          selectedVersion: 1,
        },
      ),
    /highest version both sides explicitly support/,
  );
});

test("current client accepts a bounded future server advertisement and keeps the highest mutual version", () => {
  parseHelloAck(
    '{"kind":"protocol_hello_ack","handshake_version":2,"selected_protocol_version":2,"server_supported_protocol_versions":[3,2,1]}',
    {
      handshakeVersion: 2,
      clientVersions: [2, 1],
      selectedVersion: 2,
    },
  );
});

test("compatibility server rejects an oversized first frame without unbounded read", async () => {
  const result = await runExchange(["x".repeat(64 * 1024 + 1)]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /FrameTooLarge|frame exceeds|frame limit/);
});

test("exchange times out and terminates a nonresponsive compatibility peer", async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  await assert.rejects(
    runExchange([v2Hello], {
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1_000);"],
      timeoutMs: 50,
      onSpawn: (spawned) => {
        child = spawned;
      },
    }),
    /protocol compatibility exchange timed out/,
  );
  assert.ok(child !== undefined, "test peer was started");
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "timed-out peer was terminated during cleanup",
  );
});
