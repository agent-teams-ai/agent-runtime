import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
import type { DockerEndpointObservation } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
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
const HOST_BOOT = "1".repeat(64);
const DAEMON_BOOT = "2".repeat(64);

const call = (milliseconds = 10_000): DockerEngineCall => ({
  deadlineEpochMs: Date.now() + milliseconds,
  signal: new AbortController().signal,
});

const policy = (root: string): DockerEnginePolicy => ({
  allowedEnvironmentKeys: ["AR_OPERATION"],
  allowedNetworkName: "ar-operation-gateway",
  appArmorProfile: "agent-runtime-contained-turn-v1",
  cpuNanoCpus: 500_000_000,
  daemonPidFileMode: 0o600,
  daemonPidFileOwnerGid: process.getgid?.() ?? 0,
  daemonPidFileOwnerUid: process.getuid?.() ?? 0,
  daemonPidFilePath: join(root, "docker.pid"),
  hostIdentitySha256: HOST,
  memoryBytes: 100_663_296,
  pidsLimit: 32,
  privateRootSourceRoot: join(root, "private"),
  seccompProfileJson: SECCOMP_JSON,
  seccompProfileSha256: SECCOMP_SHA256,
  socketMode: 0o600,
  socketOwnerGid: process.getgid?.() ?? 0,
  socketOwnerUid: process.getuid?.() ?? 0,
  socketPath: join(root, "docker.sock"),
  tmpfsBytes: 16_777_216,
  user: "65532:65532",
  workspaceSourceRoot: join(root, "workspaces"),
  writableLayerBytes: 33_554_432,
});

const createInput = (root: string, nonce = NONCE): DockerContainerCreate => ({
  arguments: ["serve", "--stdio"],
  entrypoint: "/usr/local/bin/provider",
  environment: { AR_OPERATION: "opaque-operation" },
  imageDigest: IMAGE,
  launchFingerprintSha256: FINGERPRINT,
  operationNonceSha256: nonce,
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

const jsonResponse = (statusCode: number, value?: unknown) => ({
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

const responseFactory = (response: IncomingMessage): ((options: RequestOptions) => ClientRequest) => () => {
  const events = new EventEmitter();
  return Object.assign(events, {
    destroy() {events.emit("error", new Error("synthetic close"));},
    end() {queueMicrotask(() => {events.emit("response", response);});},
  }) as unknown as ClientRequest;
};

interface MutationPlan {
  readonly body?: unknown;
  readonly effect: boolean;
  readonly failure?: "disconnect";
  readonly statusCode: number;
}

interface SyntheticDaemon {
  readonly bodies: unknown[];
  readonly client: {
    buffered(input: { readonly body?: Uint8Array; readonly call: DockerEngineCall; readonly method: "DELETE" | "GET" | "POST"; readonly path: string }): Promise<{ readonly body: Uint8Array; readonly contentType: string; readonly statusCode: number }>;
    endpointIdentity(): Promise<{ readonly canonicalSocketPath: string; readonly daemonBootGenerationSha256: string; readonly hostBootGenerationSha256: string }>;
    stream(input: { readonly call: DockerEngineCall; readonly method: "DELETE" | "GET" | "POST"; readonly path: string }): Promise<{ readonly body: AsyncIterable<Uint8Array>; readonly contentType: string; readonly statusCode: number }>;
  };
  daemonBoot: string;
  extraInfoField: boolean;
  infoCgroupVersion: unknown;
  inspectTransform: ((value: Record<string, unknown>) => void) | undefined;
  logLeavesRunning: boolean;
  loseNextCreate: boolean;
  mutationPlan: MutationPlan | undefined;
  rawCreateBody: Uint8Array | undefined;
  readonly routes: string[];
}

const syntheticDaemon = (): SyntheticDaemon => {
  const routes: string[] = [];
  const bodies: unknown[] = [];
  const state = {
    daemonBoot: DAEMON_BOOT,
    extraInfoField: false,
    infoCgroupVersion: "2" as unknown,
    inspectTransform: undefined as ((value: Record<string, unknown>) => void) | undefined,
    logLeavesRunning: false,
    loseNextCreate: false,
    mutationPlan: undefined as MutationPlan | undefined,
    present: false,
    rawCreateBody: undefined as Uint8Array | undefined,
    running: false,
    terminal: false,
  };
  let created: Record<string, unknown> | undefined;
  const inspect = (): Record<string, unknown> => {
    const body = created ?? {};
    const host = body.HostConfig as Record<string, unknown> | undefined;
    const configuredMounts = Array.isArray(host?.Mounts) ? host.Mounts as Array<Record<string, unknown>> : [];
    const value: Record<string, unknown> = {
      AppArmorProfile: "agent-runtime-contained-turn-v1",
      Config: {
        Cmd: body.Cmd,
        Entrypoint: body.Entrypoint,
        Env: body.Env,
        Image: IMAGE,
        Labels: body.Labels,
        User: "65532:65532",
        WorkingDir: "/workspace",
      },
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        CgroupParent: "system.slice/agent-runtime.slice",
        CgroupnsMode: "private",
        CpuPeriod: 100_000,
        Init: true,
        IpcMode: "private",
        Memory: 100_663_296,
        MemorySwap: 100_663_296,
        Mounts: host?.Mounts,
        NanoCpus: 500_000_000,
        NetworkMode: "ar-operation-gateway",
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
      Name: `/ar-turn-${(body.Labels as Record<string, unknown> | undefined)?.["com.agent-runtime.operation-nonce-sha256"] ?? NONCE}`,
      State: {
        Dead: false,
        Error: "",
        ExitCode: state.terminal ? 0 : 0,
        FinishedAt: state.terminal ? "2026-01-01T00:00:01Z" : "0001-01-01T00:00:00Z",
        OOMKilled: false,
        Pid: state.running ? 4242 : 0,
        Running: state.running,
        StartedAt: state.running || state.terminal ? "2026-01-01T00:00:00Z" : "0001-01-01T00:00:00Z",
        Status: state.running ? "running" : state.terminal ? "exited" : "created",
      },
    };
    state.inspectTransform?.(value);
    return value;
  };
  const applyMutation = (path: string): void => {
    if (path.includes("/start")) {state.running = true; state.terminal = false;}
    else if (path.includes("/stop") || path.includes("/kill")) {state.running = false; state.terminal = true;}
    else if (path.includes("?force=")) {state.present = false;}
  };
  const client = {
    async buffered(request: { readonly body?: Uint8Array; readonly method: string; readonly path: string }) {
      routes.push(`${request.method} ${request.path}`);
      if (request.path === "/v1.47/info") {
        const value: Record<string, unknown> = {
          CgroupDriver: "systemd",
          CgroupVersion: state.infoCgroupVersion,
          Driver: "overlay2",
          ID: "persistent-synthetic-daemon",
          ServerVersion: "29.6.1",
        };
        if (state.extraInfoField) {value.Unexpected = true;}
        return jsonResponse(200, value);
      }
      if (request.method === "POST" && request.path.startsWith("/v1.47/containers/create?name=")) {
        const body = JSON.parse(Buffer.from(request.body ?? []).toString("utf8")) as Record<string, unknown>;
        bodies.push(body);
        created = body;
        state.present = true;
        const plan = state.mutationPlan;
        if (plan !== undefined) {
          state.mutationPlan = undefined;
          if (plan.statusCode !== 201) {return jsonResponse(plan.statusCode, { message: "synthetic rejection" });}
        }
        if (state.loseNextCreate) {state.loseNextCreate = false; throw new DockerEngineError("daemon-disconnected");}
        if (state.rawCreateBody !== undefined) {
          const response = { body: state.rawCreateBody, contentType: "application/json", statusCode: 201 };
          state.rawCreateBody = undefined;
          return response;
        }
        return jsonResponse(201, { Id: CONTAINER, Warnings: [] });
      }
      if (request.method === "GET" && request.path.endsWith("/json")) {
        return state.present ? jsonResponse(200, inspect()) : jsonResponse(404, { message: "gone" });
      }
      if (request.path.includes("/wait?")) {return jsonResponse(200, { StatusCode: 0 });}
      const plan = state.mutationPlan ?? { effect: true, statusCode: 204 };
      state.mutationPlan = undefined;
      if (plan.effect) {applyMutation(request.path);}
      if (plan.failure === "disconnect") {throw new DockerEngineError("daemon-disconnected");}
      const body = plan.body ?? (plan.statusCode >= 400 ? { message: "synthetic rejection" } : undefined);
      return jsonResponse(plan.statusCode, body);
    },
    async endpointIdentity() {
      return {
        canonicalSocketPath: "/policy/docker.sock",
        daemonBootGenerationSha256: state.daemonBoot,
        hostBootGenerationSha256: HOST_BOOT,
      };
    },
    async stream(request: { readonly method: string; readonly path: string }) {
      routes.push(`${request.method} ${request.path}`);
      const bytes = Buffer.concat([multiplex(1, Buffer.from("out")), multiplex(2, Buffer.from("err"))]);
      async function* logChunks(): AsyncIterable<Uint8Array> {
        yield bytes.subarray(0, 5);
        yield bytes.subarray(5);
        if (!state.logLeavesRunning) {state.running = false; state.terminal = true;}
      }
      return { body: logChunks(), contentType: "application/vnd.docker.raw-stream", statusCode: 200 };
    },
  };
  return {
    bodies,
    client,
    get daemonBoot() {return state.daemonBoot;},
    set daemonBoot(value: string) {state.daemonBoot = value;},
    get extraInfoField() {return state.extraInfoField;},
    set extraInfoField(value: boolean) {state.extraInfoField = value;},
    get infoCgroupVersion() {return state.infoCgroupVersion;},
    set infoCgroupVersion(value: unknown) {state.infoCgroupVersion = value;},
    get inspectTransform() {return state.inspectTransform;},
    set inspectTransform(value: ((record: Record<string, unknown>) => void) | undefined) {state.inspectTransform = value;},
    get logLeavesRunning() {return state.logLeavesRunning;},
    set logLeavesRunning(value: boolean) {state.logLeavesRunning = value;},
    get loseNextCreate() {return state.loseNextCreate;},
    set loseNextCreate(value: boolean) {state.loseNextCreate = value;},
    get mutationPlan() {return state.mutationPlan;},
    set mutationPlan(value: MutationPlan | undefined) {state.mutationPlan = value;},
    get rawCreateBody() {return state.rawCreateBody;},
    set rawCreateBody(value: Uint8Array | undefined) {state.rawCreateBody = value;},
    routes,
  };
};

const disposable = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ar-docker-engine-"));
  await mkdir(join(root, "private", "operation"), { recursive: true });
  await mkdir(join(root, "workspaces", "operation"), { recursive: true });
  return root;
};

test("Node adapter emits the closed schema and completes lifecycle only by exact observations", async t => {
  const root = await disposable();
  const daemon = syntheticDaemon();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.equal(authority.daemonBootGenerationSha256, DAEMON_BOOT);
  const body = daemon.bodies[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).toSorted(), [
    "AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Entrypoint", "Env", "HostConfig", "Image",
    "Labels", "NetworkDisabled", "OpenStdin", "StdinOnce", "StopSignal", "Tty", "User", "WorkingDir",
  ]);
  await engine.start(authority, call());
  const frames: DockerLogFrame[] = [];
  for await (const frame of engine.logs(authority, call())) {frames.push(frame);}
  assert.deepEqual(frames.map(frame => [frame.stream, Buffer.from(frame.bytes).toString()]), [
    ["stdout", "out"], ["stderr", "err"],
  ]);
  const terminal = await engine.wait(authority, call());
  assert.equal(terminal.existence, "present");
  await engine.remove(authority, call());
  assert.equal((await engine.inspect(authority, call())).existence, "absent");
  assert.ok(daemon.routes.filter(route => /(?:start|stop|kill|wait|force=)/u.test(route))
    .every(route => route.includes(CONTAINER)));
});

test("strict JSON and closed decoders reject duplicate keys, unknown fields, and primitive coercion", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  for (const mutate of [
    (daemon: SyntheticDaemon) => {daemon.extraInfoField = true;},
    (daemon: SyntheticDaemon) => {daemon.infoCgroupVersion = 2;},
  ]) {
    const daemon = syntheticDaemon();
    mutate(daemon);
    const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
    await assert.rejects(engine.create(createInput(root, createHash("sha256").update(String(Math.random())).digest("hex")), call()), {
      code: "malformed-response",
    });
  }
  const duplicate = syntheticDaemon();
  duplicate.rawCreateBody = Buffer.from(`{"Id":"${CONTAINER}","Id":"${CONTAINER}","Warnings":[]}`);
  const duplicateEngine = new NodeUnixSocketDockerEngine({ client: duplicate.client, policy: policy(root) });
  const reconciled = await duplicateEngine.create(createInput(root, "8".repeat(64)), call());
  assert.equal(reconciled.containerId, CONTAINER);
  assert.ok(duplicate.routes.includes(`GET /v1.47/containers/ar-turn-${"8".repeat(64)}/json`));
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  daemon.mutationPlan = {
    body: { Unexpected: true, message: "synthetic rejection" },
    effect: false,
    statusCode: 409,
  };
  await assert.rejects(engine.remove(authority, call()), { code: "malformed-response" });
  daemon.inspectTransform = value => {
    const config = value.Config as Record<string, unknown>;
    config.Unexpected = true;
  };
  await assert.rejects(engine.inspect(authority, call()), { code: "malformed-response" });
});

test("lost create reconciliation refuses every policy-adjacent foreign specification", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const transforms: Array<(value: Record<string, unknown>) => void> = [
    value => {value.Name = `/ar-turn-${"9".repeat(64)}`;},
    value => {const config = value.Config as Record<string, unknown>; config.Cmd = ["serve", "--foreign"];},
    value => {const config = value.Config as Record<string, unknown>; config.Entrypoint = ["/foreign/provider"];},
    value => {const config = value.Config as Record<string, unknown>; config.Env = ["HOME=/agent-private/home", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", "AR_OPERATION=foreign"];},
    value => {const config = value.Config as Record<string, unknown>; config.WorkingDir = "/agent-private";},
    value => {const config = value.Config as Record<string, unknown>; config.Image = `registry.invalid/foreign@sha256:${"f".repeat(64)}`;},
    value => {const config = value.Config as Record<string, unknown>; const labels = config.Labels as Record<string, unknown>; labels["com.agent-runtime.launch-fingerprint-sha256"] = "f".repeat(64);},
    value => {const host = value.HostConfig as Record<string, unknown>; const mounts = host.Mounts as Array<Record<string, unknown>>; mounts[0] = { ...mounts[0], Source: join(root, "workspaces", "foreign") };},
    value => {const mounts = value.Mounts as Array<Record<string, unknown>>; mounts[1] = { ...mounts[1], Source: join(root, "private", "foreign") };},
  ];
  await mkdir(join(root, "workspaces", "foreign"));
  await mkdir(join(root, "private", "foreign"));
  for (const [index, transform] of transforms.entries()) {
    const daemon = syntheticDaemon();
    daemon.loseNextCreate = true;
    daemon.inspectTransform = transform;
    const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
    await assert.rejects(engine.create(createInput(root, createHash("sha256").update(`foreign-${index}`).digest("hex")), call()), {
      code: "create-acknowledgement-unknown",
    });
  }
});

test("persistent daemon identity is additionally fenced by daemon and host boot generations", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  daemon.daemonBoot = "3".repeat(64);
  await assert.rejects(engine.inspect(authority, call()), { code: "daemon-identity-changed" });
  const fake = new FakeDockerEngine(policy(root));
  const fakeAuthority = await fake.create(createInput(root), call());
  fake.restartDaemon("replacement");
  await assert.rejects(fake.inspect(fakeAuthority, call()), { code: "daemon-identity-changed" });
  const second = new FakeDockerEngine(policy(root));
  const hostAuthority = await second.create(createInput(root), call());
  second.restartHost("replacement");
  await assert.rejects(second.inspect(hostAuthority, call()), { code: "daemon-identity-changed" });
});

test("ambiguous and 304 mutation acknowledgements require exact postconditions and 409 diagnostics are operation-specific", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  daemon.mutationPlan = { body: { Unexpected: true }, effect: true, statusCode: 204 };
  await engine.start(authority, call());
  daemon.mutationPlan = { effect: false, statusCode: 304 };
  await assert.rejects(engine.stop(authority, call()), { code: "mutation-acknowledgement-unknown" });
  daemon.mutationPlan = { effect: true, failure: "disconnect", statusCode: 204 };
  await engine.stop(authority, call());
  daemon.mutationPlan = { effect: false, statusCode: 409 };
  await assert.rejects(engine.remove(authority, call()), { code: "request-rejected", statusCode: 409 });
  const duplicate = syntheticDaemon();
  const duplicateEngine = new NodeUnixSocketDockerEngine({ client: duplicate.client, policy: policy(root) });
  await duplicateEngine.create(createInput(root), call());
  duplicate.mutationPlan = { effect: false, statusCode: 409 };
  await assert.rejects(duplicateEngine.create(createInput(root, "4".repeat(64)), call()), {
    code: "resource-already-exists",
    statusCode: 409,
  });
});

test("log EOF is incomplete while running and wait requires an exact terminal observation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  daemon.logLeavesRunning = true;
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  await engine.start(authority, call());
  await assert.rejects(drain(engine.logs(authority, call())), { code: "terminal-observation-unknown" });
  await assert.rejects(engine.wait(authority, call()), { code: "terminal-observation-unknown" });
  await engine.stop(authority, call());
  assert.equal((await engine.wait(authority, call())).existence, "present");
});

test("Unix transport fails closed on non-socket, symlink, owner/mode drift, inode replacement, and duplicate headers", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const socketPath = join(root, "custodied.sock");
  const endpointPolicy = {
    daemonPidFileMode: 0o600,
    daemonPidFileOwnerGid: 42,
    daemonPidFileOwnerUid: 41,
    daemonPidFilePath: join(root, "docker.pid"),
    socketMode: 0o600,
    socketOwnerGid: 42,
    socketOwnerUid: 41,
    socketPath,
  };
  const observed: DockerEndpointObservation = {
    canonicalSocketPath: socketPath,
    ctimeNs: 3n,
    daemonBootGeneration: "pid=17;start=300;socket=400",
    daemonCustodyToken: "pid-file-custody-v1",
    device: 1n,
    gid: 42n,
    hostBootId: "12345678-1234-4123-8123-123456789abc",
    inode: 2n,
    mode: 0o600,
    socket: true,
    symbolicLink: false,
    uid: 41n,
  };
  let current = observed;
  const observer = async (): Promise<DockerEndpointObservation> => current;
  const client = new BoundedUnixHttpClient(
    endpointPolicy,
    responseFactory(incoming(Buffer.from("{}"))),
    observer,
  );
  await client.endpointIdentity(call());
  current = { ...observed, daemonCustodyToken: "replaced-daemon-process" };
  await assert.rejects(client.endpointIdentity(call()), { code: "endpoint-custody-lost" });
  current = { ...observed, inode: 4n };
  await assert.rejects(client.endpointIdentity(call()), { code: "endpoint-custody-lost" });

  const regular = join(root, "regular.sock");
  await writeFile(regular, "not a socket");
  await chmod(regular, 0o600);
  await assert.rejects(new BoundedUnixHttpClient({ ...endpointPolicy, socketPath: regular }).endpointIdentity(call()), {
    code: "endpoint-custody-lost",
  });
  const alias = join(root, "alias.sock");
  await symlink(socketPath, alias);
  await assert.rejects(new BoundedUnixHttpClient({ ...endpointPolicy, socketPath: alias }).endpointIdentity(call()), {
    code: "endpoint-custody-lost",
  });
  await assert.rejects(new BoundedUnixHttpClient(
    { ...endpointPolicy, socketMode: 0o660 },
    responseFactory(incoming(Buffer.from("{}"))),
    async () => observed,
  ).endpointIdentity(call()), {
    code: "endpoint-custody-lost",
  });
  await assert.rejects(new BoundedUnixHttpClient(
    { ...endpointPolicy, socketOwnerUid: endpointPolicy.socketOwnerUid + 1 },
    responseFactory(incoming(Buffer.from("{}"))),
    async () => observed,
  ).endpointIdentity(call()), { code: "endpoint-custody-lost" });
  const duplicateHeaders = new BoundedUnixHttpClient(
    endpointPolicy,
    responseFactory(incoming(Buffer.from("{}"), [
      "Content-Type", "application/json", "content-type", "application/json",
    ])),
    async () => observed,
  );
  await assert.rejects(duplicateHeaders.buffered({ call: call(), method: "GET", path: "/fixed" }), {
    code: "protocol-violation",
  });
});

test("Fake parity covers canonical mounts, exact adoption, ambiguous effects, endpoint custody, and terminal logs", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const fake = new FakeDockerEngine(policy(root));
  fake.enqueueCreateOutcome("lost-acknowledgement");
  const authority = await fake.create(createInput(root), call());
  fake.enqueueCreateOutcome("malformed-response");
  await fake.create(createInput(root, "7".repeat(64)), call());
  await fake.start(authority, call());
  fake.setLogs(authority, [{ bytes: Buffer.from("running-eof"), stream: "stdout" }]);
  await assert.rejects(drain(fake.logs(authority, call())), { code: "terminal-observation-unknown" });
  fake.enqueueMutationOutcome("stop", { acknowledgement: "304", effect: "not-applied" });
  await assert.rejects(fake.stop(authority, call()), { code: "mutation-acknowledgement-unknown" });
  fake.enqueueMutationOutcome("stop", { acknowledgement: "lost", effect: "applied" });
  await fake.stop(authority, call());
  fake.setLogs(authority, [{ bytes: Buffer.from("complete"), stream: "stdout" }]);
  await drain(fake.logs(authority, call()));
  await fake.wait(authority, call());
  fake.replaceCreateInput(authority.containerId, { ...createInput(root), arguments: ["foreign"] });
  await assert.rejects(fake.inspect(authority, call()), { code: "authority-conflict" });
  const escapedWorkspace = join(root, "workspaces", "escaped");
  await symlink(join(root, "private", "operation"), escapedWorkspace, "dir");
  await assert.rejects(new FakeDockerEngine(policy(root)).create({
    ...createInput(root, "5".repeat(64)),
    workspaceSource: escapedWorkspace,
  }, call()), { code: "invalid-create-request" });
  const endpointFake = new FakeDockerEngine(policy(root));
  endpointFake.loseEndpointCustody();
  await assert.rejects(endpointFake.create(createInput(root, "6".repeat(64)), call()), {
    code: "endpoint-custody-lost",
  });
  assert.ok(DockerEngineError.prototype instanceof Error);
});

test("multiplex parser preserves frames and refuses malformed, oversized, and truncated bytes", async () => {
  const valid = Buffer.concat([multiplex(1, Buffer.from("a")), multiplex(2, Buffer.from("bc"))]);
  const observed: DockerLogFrame[] = [];
  for await (const frame of parseDockerMultiplexedStream(chunks(valid), 8, 16)) {observed.push(frame);}
  assert.deepEqual(observed.map(frame => [frame.stream, Buffer.from(frame.bytes).toString()]), [
    ["stdout", "a"], ["stderr", "bc"],
  ]);
  await assert.rejects(drain(parseDockerMultiplexedStream(chunks(valid.subarray(0, 8)), 8, 16)), {
    code: "stream-truncated",
  });
  await assert.rejects(drain(parseDockerMultiplexedStream(chunks(multiplex(1, Buffer.alloc(9))), 8, 16)), {
    code: "stream-frame-too-large",
  });
  const malformed = valid.slice();
  malformed[1] = 1;
  await assert.rejects(drain(parseDockerMultiplexedStream(chunks(malformed), 8, 16)), {
    code: "protocol-violation",
  });
  const fullFrame = { bytes: Buffer.alloc(65_536), stream: "stdout" as const };
  const root = await disposable();
  try {
    const fake = new FakeDockerEngine(policy(root));
    const authority = await fake.create(createInput(root), call());
    fake.setLogs(authority, Array.from({ length: (DOCKER_LOG_MAX_STREAM_BYTES / 65_536) + 1 }, () => fullFrame));
    await assert.rejects(drain(fake.logs(authority, call())), { code: "stream-too-large" });
  } finally {await rm(root, { force: true, recursive: true });}
});
