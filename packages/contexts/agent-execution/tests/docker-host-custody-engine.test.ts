import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  DOCKER_LOG_MAX_STREAM_BYTES,
  DockerEngineError,
  FakeDockerEngine,
  NodeUnixSocketDockerEngine,
  parseDockerMultiplexedStream,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { BoundedUnixHttpClient } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import type {
  DockerContainerCreate,
  DockerEngineCall,
  DockerEnginePolicy,
  DockerLogFrame,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";

const HOST = "a".repeat(64);
const NONCE = "b".repeat(64);
const FINGERPRINT = "c".repeat(64);
const CONTAINER = "d".repeat(64);
const IMAGE = `registry.invalid:5443/runtime@sha256:${"e".repeat(64)}`;
const SECCOMP_JSON = JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] });
const SECCOMP_SHA256 = createHash("sha256").update(SECCOMP_JSON).digest("hex");

const call = (milliseconds = 10_000): DockerEngineCall => ({
  deadlineEpochMs: Date.now() + milliseconds,
  signal: new AbortController().signal,
});

const policy = (root: string): DockerEnginePolicy => ({
  allowedEnvironmentKeys: ["AR_OPERATION"],
  allowedNetworkName: "ar-operation-gateway",
  appArmorProfile: "agent-runtime-contained-turn-v1",
  cpuNanoCpus: 500_000_000,
  hostIdentitySha256: HOST,
  memoryBytes: 100_663_296,
  pidsLimit: 32,
  privateRootSourceRoot: join(root, "private"),
  seccompProfileJson: SECCOMP_JSON,
  seccompProfileSha256: SECCOMP_SHA256,
  tmpfsBytes: 16_777_216,
  user: "65532:65532",
  workspaceSourceRoot: join(root, "workspaces"),
  writableLayerBytes: 33_554_432,
});

const createInput = (root: string): DockerContainerCreate => ({
  arguments: ["serve", "--stdio"],
  entrypoint: "/usr/local/bin/provider",
  environment: { AR_OPERATION: "opaque-operation" },
  imageDigest: IMAGE,
  launchFingerprintSha256: FINGERPRINT,
  operationNonceSha256: NONCE,
  privateRootSource: join(root, "private", "operation"),
  workspaceSource: join(root, "workspaces", "operation"),
  workspaceWritable: true,
});

const multiplex = (stream: 1 | 2, bytes: Uint8Array): Buffer => {
  const frame = Buffer.alloc(8 + bytes.byteLength);
  frame[0] = stream;
  frame.writeUInt32BE(bytes.byteLength, 4);
  Buffer.from(bytes).copy(frame, 8);
  return frame;
};

const response = (statusCode: number, value?: unknown) => ({
  body: value === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(value)),
  contentType: value === undefined ? "" : "application/json",
  statusCode,
});

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes.slice(0, 3);
  yield bytes.slice(3);
}

const drain = async (source: AsyncIterable<unknown>): Promise<void> => {
  for await (const value of source) {void value;}
};

const incoming = (
  body: Uint8Array,
  rawHeaders: readonly string[] = ["content-type", "application/json"],
): IncomingMessage => Object.assign(Readable.from([body]), {
  complete: true,
  headers: { "content-type": "application/json" },
  rawHeaders: [...rawHeaders],
  statusCode: 200,
}) as unknown as IncomingMessage;

const responseFactory = (incomingResponse: IncomingMessage): ((options: RequestOptions) => ClientRequest) => () => {
  const events = new EventEmitter();
  return Object.assign(events, {
    destroy() {events.emit("error", new Error("synthetic close"));},
    end() {queueMicrotask(() => {events.emit("response", incomingResponse);});},
  }) as unknown as ClientRequest;
};

const errorFactory = (code: string): ((options: RequestOptions) => ClientRequest) => () => {
  const events = new EventEmitter();
  return Object.assign(events, {
    destroy() {events.emit("error", Object.assign(new Error("synthetic close"), { code }));},
    end() {queueMicrotask(() => {events.emit("error", Object.assign(new Error("synthetic failure"), { code }));});},
  }) as unknown as ClientRequest;
};

interface SyntheticDaemon {
  readonly bodies: unknown[];
  readonly client: {
    buffered(input: { readonly body?: Uint8Array; readonly method: string; readonly path: string }): Promise<{
      readonly body: Uint8Array; readonly contentType: string; readonly statusCode: number;
    }>;
    stream(input: { readonly method: string; readonly path: string }): Promise<{
      readonly body: AsyncIterable<Uint8Array>; readonly contentType: string; readonly statusCode: number;
    }>;
  };
  daemonId: string;
  logContentType: string;
  loseNextCreate: boolean;
  malformedNextCreate: boolean;
  malformedInfo: boolean;
  removed: boolean;
  readonly routes: string[];
}

const syntheticDaemon = async (): Promise<SyntheticDaemon> => {
  const routes: string[] = [];
  const bodies: unknown[] = [];
  const state = {
    daemonId: "synthetic-daemon-a",
    logContentType: "application/vnd.docker.raw-stream",
    loseNextCreate: false,
    malformedNextCreate: false,
    malformedInfo: false,
    removed: false,
  };
  let created: Record<string, unknown> | undefined;
  const inspect = (): Record<string, unknown> => {
    const body = created ?? {};
    const host = body.HostConfig as Record<string, unknown> | undefined;
    const configuredMounts = Array.isArray(host?.Mounts) ? host.Mounts as Array<Record<string, unknown>> : [];
    return {
      AppArmorProfile: "agent-runtime-contained-turn-v1",
      Config: { Image: IMAGE, Labels: body.Labels, User: "65532:65532" },
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        CgroupParent: "system.slice/agent-runtime.slice",
        CgroupnsMode: "private",
        Init: true,
        IpcMode: "private",
        Memory: 100_663_296,
        MemorySwap: 100_663_296,
        NanoCpus: 500_000_000,
        NetworkMode: "ar-operation-gateway",
        Mounts: (body.HostConfig as Record<string, unknown> | undefined)?.Mounts,
        OomKillDisable: false,
        PidMode: "private",
        PidsLimit: 32,
        Privileged: false,
        ReadonlyRootfs: true,
        RestartPolicy: { MaximumRetryCount: 0, Name: "no" },
        SecurityOpt: [
          "no-new-privileges=true",
          `seccomp=${SECCOMP_JSON}`,
          "apparmor=agent-runtime-contained-turn-v1",
        ],
        StorageOpt: { size: "33554432" },
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16777216,mode=1777" },
      },
      Id: CONTAINER,
      Mounts: configuredMounts.map(mount => ({
        Destination: mount.Target,
        Propagation: "rprivate",
        RW: mount.ReadOnly !== true,
        Source: mount.Source,
        Type: "bind",
      })),
      State: {
        Dead: false,
        Error: "",
        ExitCode: 0,
        FinishedAt: "0001-01-01T00:00:00Z",
        OOMKilled: false,
        Pid: state.removed ? 0 : 4242,
        Running: !state.removed,
        StartedAt: "2026-01-01T00:00:00Z",
        Status: state.removed ? "exited" : "running",
      },
    };
  };
  const buffered = async (request: {
    readonly body?: Uint8Array; readonly method: string; readonly path: string;
  }) => {
    const route = `${request.method} ${request.path}`;
    routes.push(route);
    if (request.path === "/v1.47/info") {
      if (state.malformedInfo) {return response(200, { ID: 7 });}
      return response(200, {
        CgroupDriver: "systemd",
        CgroupVersion: "2",
        Driver: "overlay2",
        ID: state.daemonId,
        ServerVersion: "29.6.1",
      });
    }
    if (request.method === "POST" && request.path.startsWith("/v1.47/containers/create?name=ar-turn-")) {
      const body = JSON.parse(Buffer.from(request.body ?? []).toString("utf8"));
      bodies.push(body);
      created = body as Record<string, unknown>;
      if (state.loseNextCreate) {
        state.loseNextCreate = false;
        throw new DockerEngineError("daemon-disconnected");
      }
      if (state.malformedNextCreate) {
        state.malformedNextCreate = false;
        return { body: Buffer.from("{"), contentType: "application/json", statusCode: 201 };
      }
      return response(201, { Id: CONTAINER, Warnings: [] });
    }
    if (request.method === "GET" && request.path.endsWith("/json")) {
      return state.removed ? response(404, { message: "gone" }) : response(200, inspect());
    }
    if (request.method === "DELETE") {state.removed = true; return response(204);}
    if (request.method === "POST") {return response(204);}
    return response(404, { message: "not found" });
  };
  const stream = async (request: { readonly method: string; readonly path: string }) => {
    routes.push(`${request.method} ${request.path}`);
    const bytes = Buffer.concat([multiplex(1, Buffer.from("out")), multiplex(2, Buffer.from("err"))]);
    async function* logChunks(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 5);
      yield bytes.subarray(5);
    }
    return { body: logChunks(), contentType: state.logContentType, statusCode: 200 };
  };
  return {
    get daemonId() {return state.daemonId;},
    set daemonId(value: string) {state.daemonId = value;},
    get logContentType() {return state.logContentType;},
    set logContentType(value: string) {state.logContentType = value;},
    bodies,
    client: { buffered, stream },
    get loseNextCreate() {return state.loseNextCreate;},
    set loseNextCreate(value: boolean) {state.loseNextCreate = value;},
    get malformedInfo() {return state.malformedInfo;},
    set malformedInfo(value: boolean) {state.malformedInfo = value;},
    get malformedNextCreate() {return state.malformedNextCreate;},
    set malformedNextCreate(value: boolean) {state.malformedNextCreate = value;},
    get removed() {return state.removed;},
    set removed(value: boolean) {state.removed = value;},
    routes,
  };
};

const disposable = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ar-docker-engine-"));
  await mkdir(join(root, "private", "operation"), { recursive: true });
  await mkdir(join(root, "workspaces", "operation"), { recursive: true });
  return root;
};

test("Node adapter emits only the exact closed create schema and mutates by full ID", async t => {
  const root = await disposable();
  const daemon = await syntheticDaemon();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.equal(authority.operationNonceSha256, NONCE);
  const body = daemon.bodies[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).toSorted(), [
    "AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Entrypoint", "Env", "HostConfig", "Image",
    "Labels", "NetworkDisabled", "OpenStdin", "StdinOnce", "StopSignal", "Tty", "User", "WorkingDir",
  ]);
  const host = body.HostConfig as Record<string, unknown>;
  assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.deepEqual(host.RestartPolicy, { MaximumRetryCount: 0, Name: "no" });
  assert.equal(host.AutoRemove, false);
  assert.equal(host.Privileged, false);
  assert.equal(host.ReadonlyRootfs, true);
  assert.deepEqual(host.SecurityOpt, [
    "no-new-privileges=true",
    `seccomp=${SECCOMP_JSON}`,
    "apparmor=agent-runtime-contained-turn-v1",
  ]);
  assert.doesNotMatch(JSON.stringify(body), /docker\.sock|\/sys\/fs\/cgroup/u);
  await engine.start(authority, call());
  const frames: DockerLogFrame[] = [];
  for await (const frame of engine.logs(authority, call())) {frames.push(frame);}
  assert.deepEqual(frames.map(frame => [frame.stream, Buffer.from(frame.bytes).toString()]), [
    ["stdout", "out"], ["stderr", "err"],
  ]);
  daemon.logContentType = "application/vnd.docker.raw-stream-unsafe";
  await assert.rejects(drain(engine.logs(authority, call())), { code: "protocol-violation" });
  await engine.kill(authority, call());
  const afterKill = await engine.inspect(authority, call());
  assert.equal(afterKill.cgroupTree, "unobserved");
  if (afterKill.existence === "present") {
    assert.equal(afterKill.resources.pidNamespaceMode, "private");
    assert.equal(afterKill.resources.ipcNamespaceMode, "private");
    assert.equal(afterKill.resources.mountPropagation, "rprivate");
    assert.equal(afterKill.resources.seccompProfileSha256, SECCOMP_SHA256);
    assert.equal(afterKill.resources.user, "65532:65532");
  }
  await engine.remove(authority, call());
  const afterRemove = await engine.inspect(authority, call());
  assert.equal(afterRemove.existence, "absent");
  assert.equal(afterRemove.cgroupTree, "unobserved");
  const mutations = daemon.routes.filter(route => / (?:\/v1\.47\/containers\/)/u.test(route) &&
    !route.endsWith("/json") && !route.includes("create?"));
  assert.ok(mutations.every(route => route.includes(CONTAINER)));
});

test("lost create acknowledgement resolves once by exact name and labels", async t => {
  const root = await disposable();
  const daemon = await syntheticDaemon();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  daemon.loseNextCreate = true;
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.ok(daemon.routes.includes(`GET /v1.47/containers/ar-turn-${NONCE}/json`));
  assert.equal(daemon.routes.some(route => /(?:start|stop|kill)/u.test(route) && route.includes("ar-turn-")), false);
  daemon.malformedNextCreate = true;
  const recovered = await engine.create({ ...createInput(root), operationNonceSha256: "1".repeat(64) }, call());
  assert.equal(recovered.containerId, CONTAINER);
});

test("daemon identity changes fence stale full-ID authority", async t => {
  const root = await disposable();
  const daemon = await syntheticDaemon();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  daemon.daemonId = "synthetic-daemon-b";
  await assert.rejects(engine.kill(authority, call()), { code: "daemon-identity-changed", name: "DockerEngineError" });
  daemon.malformedInfo = true;
  await assert.rejects(engine.inspect(authority, call()), { code: "malformed-response", name: "DockerEngineError" });
});

test("multiplex parser preserves frames and refuses malformed, oversized, and truncated bytes", async () => {
  const valid = Buffer.concat([multiplex(1, Buffer.from("a")), multiplex(2, Buffer.from("bc"))]);
  const observed: DockerLogFrame[] = [];
  for await (const frame of parseDockerMultiplexedStream(chunks(valid), 8, 16)) {observed.push(frame);}
  assert.deepEqual(observed.map(frame => [frame.stream, Buffer.from(frame.bytes).toString()]), [
    ["stdout", "a"], ["stderr", "bc"],
  ]);
  await assert.rejects(async () => {
    await drain(parseDockerMultiplexedStream(chunks(valid.subarray(0, 8)), 8, 16));
  }, { code: "stream-truncated" });
  await assert.rejects(async () => {
    await drain(parseDockerMultiplexedStream(chunks(multiplex(1, Buffer.alloc(9))), 8, 16));
  }, { code: "stream-frame-too-large" });
  const malformed = valid.slice();
  malformed[1] = 1;
  await assert.rejects(async () => {
    await drain(parseDockerMultiplexedStream(chunks(malformed), 8, 16));
  }, { code: "protocol-violation" });
  const excessive = Buffer.concat([multiplex(1, Buffer.alloc(5)), multiplex(2, Buffer.alloc(5))]);
  await assert.rejects(async () => {
    await drain(parseDockerMultiplexedStream(chunks(excessive), 8, 8));
  }, { code: "stream-too-large" });
});

test("deterministic fake models ambiguity, restarts, reuse, malformed data, and delayed streams", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const fake = new FakeDockerEngine(policy(root));
  fake.enqueueCreateOutcome("lost-acknowledgement");
  const authority = await fake.create(createInput(root), call());
  assert.deepEqual(fake.events.slice(-2), ["create:lost-acknowledgement", "create:resolved-by-name"]);
  await fake.start(authority, call());
  fake.setLogs(authority, [{ bytes: Buffer.from("delayed"), stream: "stdout" }], { delayed: true });
  const iterator = fake.logs(authority, call())[Symbol.asyncIterator]();
  let settled = false;
  const pending = iterator.next().then(value => {settled = true; return value;});
  await Promise.resolve();
  assert.equal(settled, false);
  fake.releaseDelayedStreams();
  assert.equal(Buffer.from((await pending).value?.bytes ?? []).toString(), "delayed");
  const fullFrame = { bytes: Buffer.alloc(65_536), stream: "stdout" as const };
  fake.setLogs(authority, Array.from({ length: (DOCKER_LOG_MAX_STREAM_BYTES / 65_536) + 1 }, () => fullFrame));
  await assert.rejects(drain(fake.logs(authority, call())), { code: "stream-too-large" });
  fake.injectMalformedResponse("inspect");
  await assert.rejects(fake.inspect(authority, call()), { code: "malformed-response" });
  const replacement = await fake.create({ ...createInput(root), operationNonceSha256: "2".repeat(64) }, call());
  await assert.rejects(
    fake.create({ ...createInput(root), operationNonceSha256: "2".repeat(64) }, call()),
    { code: "resource-already-exists" },
  );
  fake.reuseNameOnNextLostAcknowledgement(replacement.containerId);
  fake.enqueueCreateOutcome("lost-acknowledgement");
  await assert.rejects(
    fake.create({ ...createInput(root), operationNonceSha256: "3".repeat(64) }, call()),
    { code: "create-acknowledgement-unknown" },
  );
  fake.replaceId(authority.containerId, { ...authority, launchFingerprintSha256: "f".repeat(64) });
  await assert.rejects(fake.inspect(authority, call()), { code: "authority-conflict" });
  fake.setLogs(replacement, [{ bytes: Buffer.from("late"), stream: "stderr" }], { delayed: true });
  const interrupted = fake.logs(replacement, call())[Symbol.asyncIterator]().next();
  await new Promise<void>(resolve => {setImmediate(resolve);});
  fake.restartDaemon("replacement");
  fake.releaseDelayedStreams();
  await assert.rejects(interrupted, { code: "daemon-identity-changed" });
  await assert.rejects(fake.inspect(authority, call()), { code: "daemon-identity-changed" });
  fake.setDisconnected(true);
  await assert.rejects(fake.create({ ...createInput(root), operationNonceSha256: "1".repeat(64) }, call()), {
    code: "daemon-disconnected",
  });
  assert.ok(DockerEngineError.prototype instanceof Error);
});

test("create rejects ambient paths, mutable images, root identity, and caller-controlled Docker variables", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const fake = new FakeDockerEngine(policy(root));
  const invalid = [
    { ...createInput(root), imageDigest: "runtime:latest" },
    { ...createInput(root), workspaceSource: "/tmp/not-authorized" },
    { ...createInput(root), environment: { DOCKER_HOST: "unix:///var/run/docker.sock" } },
    { ...createInput(root), environment: { AWS_SECRET_ACCESS_KEY: "ambient-secret" } },
  ];
  for (const input of invalid) {
    await assert.rejects(fake.create(input, call()), { code: "invalid-create-request" });
  }
  const daemon = await syntheticDaemon();
  const node = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const escapedWorkspace = join(root, "workspaces", "escaped");
  await symlink(join(root, "private", "operation"), escapedWorkspace, "dir");
  await assert.rejects(node.create({ ...createInput(root), workspaceSource: escapedWorkspace }, call()), {
    code: "invalid-create-request",
  });
  assert.throws(() => new FakeDockerEngine({ ...policy(root), user: "0:0" }), {
    code: "invalid-create-request",
  });
  const allowAll = JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW" });
  assert.throws(() => new FakeDockerEngine({
    ...policy(root),
    seccompProfileJson: allowAll,
    seccompProfileSha256: createHash("sha256").update(allowAll).digest("hex"),
  }), { code: "invalid-create-request" });
});

test("Unix HTTP transport bounds bodies and maps parser/header failures without diagnostics", async () => {
  const oversizedBody = new BoundedUnixHttpClient(
    "/synthetic/docker.sock",
    responseFactory(incoming(Buffer.alloc(262_145))),
  );
  await assert.rejects(oversizedBody.buffered({ call: call(), method: "GET", path: "/fixed" }), {
    code: "response-too-large",
  });
  await assert.rejects(oversizedBody.buffered({
    body: Buffer.alloc(131_073),
    call: call(),
    method: "POST",
    path: "/fixed",
  }), { code: "invalid-create-request" });
  const oversizedHeaders = new BoundedUnixHttpClient(
    "/synthetic/docker.sock",
    responseFactory(incoming(new Uint8Array(), ["x-bound", "x".repeat(16_385)])),
  );
  await assert.rejects(oversizedHeaders.buffered({ call: call(), method: "GET", path: "/fixed" }), {
    code: "response-too-large",
  });
  const parserOverflow = new BoundedUnixHttpClient(
    "/synthetic/docker.sock",
    errorFactory("HPE_HEADER_OVERFLOW"),
  );
  await assert.rejects(parserOverflow.buffered({ call: call(), method: "GET", path: "/fixed" }), {
    code: "response-too-large",
  });
  const invalidProtocol = new BoundedUnixHttpClient(
    "/synthetic/docker.sock",
    errorFactory("HPE_INVALID_HEADER_TOKEN"),
  );
  await assert.rejects(invalidProtocol.buffered({ call: call(), method: "GET", path: "/fixed" }), {
    code: "protocol-violation",
  });
});

test("absolute deadlines and AbortSignal fail deterministically", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const fake = new FakeDockerEngine(policy(root));
  await assert.rejects(fake.create(createInput(root), {
    deadlineEpochMs: Date.now() - 1,
    signal: new AbortController().signal,
  }), { code: "deadline-exceeded" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fake.create(createInput(root), {
    deadlineEpochMs: Date.now() + 1_000,
    signal: controller.signal,
  }), { code: "aborted" });
  const node = new NodeUnixSocketDockerEngine({
    policy: policy(root),
    socketPath: join(root, "missing-docker.sock"),
  });
  await assert.rejects(node.create(createInput(root), call()), { code: "daemon-disconnected" });
  await assert.rejects(node.create(createInput(root), {
    deadlineEpochMs: Date.now() - 1,
    signal: new AbortController().signal,
  }), { code: "deadline-exceeded" });
});
