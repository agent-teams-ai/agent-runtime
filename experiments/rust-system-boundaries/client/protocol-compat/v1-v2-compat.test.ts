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
  '{"kind":"protocol_hello","handshake_version":1,"supported_protocol_versions":[2,1]}';
const v2Request =
  '{"protocol_version":2,"request_id":"v2-request","command":{"kind":"spawn","operation_id":"operation-v2","opaque_fence":"fence-v2","fixture_mode":"tree","drop_response":false}}';
const unsupportedHello =
  '{"kind":"protocol_hello","handshake_version":1,"supported_protocol_versions":[3]}';

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

const parseHelloAck = (line: string, expectedVersion: 1 | 2): void => {
  const value = asRecord(JSON.parse(line) as unknown, "protocol hello acknowledgement");
  assertExactKeys(
    value,
    ["kind", "handshake_version", "selected_protocol_version"],
    "protocol hello acknowledgement",
  );
  assert.equal(value.kind, "protocol_hello_ack");
  assert.equal(value.handshake_version, 1);
  assert.equal(value.selected_protocol_version, expectedVersion);
};

const parseHelloRejection = (line: string): void => {
  const value = asRecord(JSON.parse(line) as unknown, "protocol hello rejection");
  assertExactKeys(
    value,
    ["kind", "handshake_version", "code", "detail"],
    "protocol hello rejection",
  );
  assert.equal(value.kind, "protocol_hello_rejected");
  assert.equal(value.handshake_version, 1);
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

const exchange = async (frames: readonly string[]): Promise<readonly string[]> => {
  await buildServer();
  const child = spawn(protocolServer, [], {
    cwd: experimentDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const completion = new Promise<number | null>((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("exit", (code) => resolveCompletion(code));
  });
  child.stdin.end(`${frames.join("\n")}\n`);
  const code = await completion;
  assert.equal(code, 0, Buffer.concat(stderrChunks).toString("utf8"));
  return Buffer.concat(stdoutChunks)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
};

test("frozen v1 client and current v2 server negotiate and project both directions", async () => {
  const frames = await exchange([v1Hello, v1Request]);
  assert.equal(frames.length, 2);
  parseHelloAck(frames[0]!, 1);
  const response = parseFrozenV1Response(frames[1]!);
  assert.equal(response.request_id, "v1-request");
  assert.equal(response.result.operation_id, "operation-v1");
  assert.equal(response.result.custody_state, "accepted");
  assert.equal(Object.hasOwn(response.result, "execution_id"), false);
});

test("current v2 client retains the current response-only execution correlation", async () => {
  const frames = await exchange([v2Hello, v2Request]);
  assert.equal(frames.length, 2);
  parseHelloAck(frames[0]!, 2);
  const response = parseCurrentV2Response(frames[1]!);
  assert.equal(response.request_id, "v2-request");
  assert.equal(response.result.operation_id, "operation-v2");
  assert.equal(response.result.execution_id, "compatibility-execution-1");
});

test("unsupported protocol versions receive a typed negotiation rejection", async () => {
  const frames = await exchange([unsupportedHello]);
  assert.equal(frames.length, 1);
  parseHelloRejection(frames[0]!);
});
