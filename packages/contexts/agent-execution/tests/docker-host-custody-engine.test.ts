/* oxlint-disable max-lines -- this is the closed synthetic Docker Engine conformance suite. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { join } from "node:path";
import { Socket } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";

import {
  DOCKER_LOG_MAX_STREAM_BYTES,
  DockerEngineError,
  FakeDockerEngine,
  NodeUnixSocketDockerEngine,
  parseDockerMultiplexedStream,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { BoundedUnixHttpClient } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import { assertDockerUnixPeerPlatformSupported } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-unix-peer.js";
import { snapshotDockerEngineCall } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-boundary-snapshot.js";
import type { DockerEndpointObservation } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import type { DockerEngineCall, DockerLogFrame } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { createSpecificationMutations } from "./fixtures/docker-create-specification-mutations.ts";
import {
  CONTAINER,
  DAEMON_BOOT,
  HOST_BOOT,
  IMAGE,
  NONCE,
  SECCOMP_JSON,
  call,
  createInput,
  disposable,
  policy,
} from "./fixtures/docker-engine-test-fixture.ts";
import { verifyProductionUnixPeerBinding } from "./fixtures/docker-unix-peer-binding.ts";

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
  rawHeaders: readonly string[] = [
    "content-type", "application/json", "content-length", String(body.byteLength),
  ],
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

const syntheticPeerConnector = async () => {
  const socket = new Socket();
  return { release: async () => {socket.destroy();}, socket };
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
    buffered(input: { readonly beforeWrite?: () => void; readonly body?: Uint8Array; readonly call: DockerEngineCall; readonly method: "DELETE" | "GET" | "POST"; readonly path: string }): Promise<{ readonly body: Uint8Array; readonly contentType: string; readonly statusCode: number }>;
    endpointIdentity(): Promise<{ readonly canonicalSocketPath: string; readonly daemonBootGenerationSha256: string; readonly hostBootGenerationSha256: string }>;
    hijack(input: {readonly call: DockerEngineCall; readonly path: string}): Promise<{
      readonly input: PassThrough; readonly output: AsyncIterable<Uint8Array>; close(): Promise<void>;
    }>;
    stream(input: { readonly call: DockerEngineCall; readonly method: "DELETE" | "GET" | "POST"; readonly path: string }): Promise<{ readonly body: AsyncIterable<Uint8Array>; readonly contentType: string; readonly statusCode: number }>;
  };
  daemonBoot: string;
  extraInfoField: boolean;
  infoCgroupVersion: unknown;
  inspectTransform: ((value: Record<string, unknown>) => void) | undefined;
  readonly hijackCloseCount: number;
  logLeavesRunning: boolean;
  loseNextCreate: boolean;
  oversizeNextCreate: boolean;
  mutationPlan: MutationPlan | undefined;
  rawCreateBody: Uint8Array | undefined;
  failHijack(): void;
  pauseNextMutationWrite(at: "after" | "before"): { readonly reached: Promise<void>; release(): void };
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
    oversizeNextCreate: false,
    mutationPlan: undefined as MutationPlan | undefined,
    present: false,
    rawCreateBody: undefined as Uint8Array | undefined,
    running: false,
    terminal: false,
  };
  let hijackCloseCount = 0;
  let hijackInput: PassThrough | undefined;
  let mutationBarrier: {
    readonly at: "after" | "before";
    readonly reached: () => void;
    readonly released: Promise<void>;
  } | undefined;
  let created: Record<string, unknown> | undefined;
  const inspect = (): Record<string, unknown> => {
    const body = created ?? {};
    const host = body.HostConfig as Record<string, unknown> | undefined;
    const configuredMounts = Array.isArray(host?.Mounts) ? host.Mounts as Array<Record<string, unknown>> : [];
    const value: Record<string, unknown> = {
      AppArmorProfile: "agent-runtime-contained-turn-v1",
      Config: {
        AttachStderr: body.AttachStderr,
        AttachStdin: body.AttachStdin,
        AttachStdout: body.AttachStdout,
        Cmd: body.Cmd,
        Entrypoint: body.Entrypoint,
        Env: body.Env,
        Image: IMAGE,
        Labels: body.Labels,
        NetworkDisabled: body.NetworkDisabled,
        OpenStdin: body.OpenStdin,
        StdinOnce: body.StdinOnce,
        StopSignal: body.StopSignal,
        Tty: body.Tty,
        User: "65532:65532",
        WorkingDir: "/workspace",
      },
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        CgroupParent: host?.CgroupParent,
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
        Paused: false,
        Pid: state.running ? 4242 : 0,
        Restarting: false,
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
    async buffered(request: {
      readonly beforeWrite?: () => void;
      readonly body?: Uint8Array;
      readonly method: string;
      readonly path: string;
    }) {
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
        state.running = false;
        state.terminal = false;
        const plan = state.mutationPlan;
        if (plan !== undefined) {
          state.mutationPlan = undefined;
          if (plan.statusCode !== 201) {return jsonResponse(plan.statusCode, { message: "synthetic rejection" });}
        }
        if (state.loseNextCreate) {state.loseNextCreate = false; throw new DockerEngineError("daemon-disconnected");}
        if (state.oversizeNextCreate) {
          state.oversizeNextCreate = false;
          throw new DockerEngineError("response-too-large");
        }
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
      const barrier = mutationBarrier;
      mutationBarrier = undefined;
      if (barrier?.at === "before") {barrier.reached(); await barrier.released;}
      request.beforeWrite?.();
      if (barrier?.at === "after") {barrier.reached(); await barrier.released;}
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
    async hijack(request: {readonly path: string}) {
      routes.push(`POST ${request.path}`);
      const input = new PassThrough();
      hijackInput = input;
      const output = new PassThrough();
      let closed = false;
      return {close: async () => {
        if (closed) {return;}
        closed = true; hijackCloseCount += 1; input.destroy(); output.destroy();
      }, input, output};
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
    get hijackCloseCount() {return hijackCloseCount;},
    get inspectTransform() {return state.inspectTransform;},
    set inspectTransform(value: ((record: Record<string, unknown>) => void) | undefined) {state.inspectTransform = value;},
    get logLeavesRunning() {return state.logLeavesRunning;},
    set logLeavesRunning(value: boolean) {state.logLeavesRunning = value;},
    get loseNextCreate() {return state.loseNextCreate;},
    set loseNextCreate(value: boolean) {state.loseNextCreate = value;},
    get oversizeNextCreate() {return state.oversizeNextCreate;},
    set oversizeNextCreate(value: boolean) {state.oversizeNextCreate = value;},
    get mutationPlan() {return state.mutationPlan;},
    set mutationPlan(value: MutationPlan | undefined) {state.mutationPlan = value;},
    get rawCreateBody() {return state.rawCreateBody;},
    set rawCreateBody(value: Uint8Array | undefined) {state.rawCreateBody = value;},
    failHijack() {hijackInput?.destroy(new Error("synthetic hijack failure"));},
    pauseNextMutationWrite(at: "after" | "before") {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>(resolve => {reached = resolve;});
      const released = new Promise<void>(resolve => {release = resolve;});
      mutationBarrier = {at, reached, released};
      return {reached: reachedPromise, release};
    },
    routes,
  };
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
  assert.equal(body.AttachStdin, false);
  assert.equal(body.OpenStdin, true);
  assert.equal(body.StdinOnce, true);
  assert.equal(body.Tty, false);
  const custody = await engine.attachCustody(authority, call());
  await custody.write(Buffer.from("init-control"));
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

test("API v1.47 decoders accept a synthetic owner-binding projection of the retained Engine 29.6.1 fixture", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const fixtureUrl = new URL("./fixtures/docker-engine-api-v1.47-engine-29.6.1-redacted.json", import.meta.url);
  const fixtureSource = (await readFile(fixtureUrl, "utf8"))
    .replaceAll("__WORKSPACE_SOURCE__", join(root, "workspaces", "operation"))
    .replaceAll("__PRIVATE_SOURCE__", join(root, "private", "operation"));
  const fixture = JSON.parse(fixtureSource) as {
    readonly info: unknown;
    readonly inspect: { readonly Config: { readonly Labels: Record<string, string>; OpenStdin: boolean; StdinOnce: boolean } };
  };
  // The captured fixture predates owner binding. Project only this synthetic test
  // response; preserve the historical capture bytes and their original evidence.
  fixture.inspect.Config.Labels["com.agent-runtime.owner-identity-sha256"] = createInput(root).ownerIdentitySha256;
  fixture.inspect.Config.OpenStdin = true;
  fixture.inspect.Config.StdinOnce = true;
  let present = false;
  const client = {
    async buffered(request: { readonly method: string; readonly path: string }) {
      if (request.path === "/v1.47/info") {return jsonResponse(200, fixture.info);}
      if (request.method === "POST" && request.path.startsWith("/v1.47/containers/create?name=")) {
        present = true;
        return jsonResponse(201, { Id: CONTAINER, Warnings: [] });
      }
      if (request.method === "GET" && request.path.endsWith("/json") && present) {
        return jsonResponse(200, fixture.inspect);
      }
      return jsonResponse(404, { message: "not found" });
    },
    async endpointIdentity() {
      return {
        canonicalSocketPath: "/policy/docker.sock",
        daemonBootGenerationSha256: DAEMON_BOOT,
        hostBootGenerationSha256: HOST_BOOT,
      };
    },
    async stream() {throw new DockerEngineError("protocol-violation");},
  };
  const engine = new NodeUnixSocketDockerEngine({ client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.equal((await engine.inspect(authority, call())).existence, "present");
});

test("create environment keys use locale-independent byte ordering", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const orderedPolicy = { ...policy(root), allowedEnvironmentKeys: ["Z_KEY", "_A_KEY"] };
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: orderedPolicy });
  await engine.create({
    ...createInput(root),
    environment: { _A_KEY: "second", Z_KEY: "first" },
  }, call());
  const request = daemon.bodies[0] as { readonly Env: readonly string[] };
  assert.deepEqual(request.Env.slice(-2), ["Z_KEY=first", "_A_KEY=second"]);
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

test("public boundaries reject proxies, inherited fields, and accessors before deriving a request path", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  const routeCount = daemon.routes.length;
  await assert.rejects(engine.start(new Proxy(authority, {}), call()), { code: "invalid-authority" });
  assert.equal(daemon.routes.length, routeCount);

  const accessor = { ...authority } as Record<string, unknown>;
  Object.defineProperty(accessor, "containerId", {
    enumerable: true,
    get() {throw new Error("secret accessor diagnostic");},
  });
  await assert.rejects(engine.kill(accessor as unknown as typeof authority, call()), error =>
    error instanceof DockerEngineError && error.code === "invalid-authority" &&
    !error.message.includes("secret accessor diagnostic"));
  assert.equal(daemon.routes.length, routeCount);

  const inherited = Object.create(authority) as typeof authority;
  await assert.rejects(engine.remove(inherited, call()), { code: "invalid-authority" });
  assert.equal(daemon.routes.length, routeCount);

  const hostilePolicy = { ...policy(root) };
  Object.defineProperty(hostilePolicy, "socketPath", {
    enumerable: true,
    get() {throw new Error("secret policy accessor diagnostic");},
  });
  assert.throws(() => new NodeUnixSocketDockerEngine({ client: daemon.client, policy: hostilePolicy }), error =>
    error instanceof DockerEngineError && error.code === "invalid-create-request" &&
    !error.message.includes("secret policy accessor diagnostic"));
});

test("engine call snapshots preserve native AbortSignal state across later expandos and cancellation", () => {
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "addEventListener", {
    configurable: true,
    value() {throw new Error("shadowed signal listener");},
  });
  const snapshot = snapshotDockerEngineCall({ deadlineEpochMs: Date.now() + 10_000, signal: controller.signal });
  Object.defineProperty(controller.signal, "aborted", { configurable: true, value: true, writable: true });
  assert.equal(snapshot.signal.aborted, false);
  Object.defineProperty(controller.signal, "aborted", { configurable: true, value: false, writable: true });
  controller.abort();
  assert.equal(snapshot.signal.aborted, true);
  assert.equal(Object.isExtensible(snapshot.signal), false);
  assert.throws(() => Object.defineProperty(snapshot.signal, "aborted", { value: false }), TypeError);
});

test("lost create reconciliation refuses every policy-adjacent foreign specification", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const transforms = createSpecificationMutations(root);
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

test("an oversized create response reconciles a create that may already be committed", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  daemon.oversizeNextCreate = true;
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root, "9".repeat(64)), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.ok(daemon.routes.includes(`GET /v1.47/containers/ar-turn-${"9".repeat(64)}/json`));
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
  const createFence = new FakeDockerEngine(policy(root));
  const expectedIdentity = await createFence.identity(call());
  createFence.restartDaemon("raced-before-create");
  await assert.rejects(createFence.create(createInput(root, "7".repeat(64)), call(), expectedIdentity), {
    code: "daemon-identity-changed",
  });
  assert.equal(createFence.events.some(event => event.startsWith("create:")), false);
});

test("ambiguous and 304 mutation acknowledgements require exact postconditions and 409 diagnostics are operation-specific", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  await engine.attachCustody(authority, call());
  daemon.mutationPlan = { body: { Unexpected: true }, effect: true, statusCode: 204 };
  await assert.rejects(engine.start(authority, call()), { code: "start-acknowledgement-unknown" });
  assert.ok(daemon.routes.filter(route => route === `GET /v1.47/containers/${CONTAINER}/json`).length >= 2);
  await assert.rejects(engine.start(authority, call()), { code: "protocol-violation" });
  const successful = syntheticDaemon();
  const successfulEngine = new NodeUnixSocketDockerEngine({client: successful.client, policy: policy(root)});
  const successfulAuthority = await successfulEngine.create(createInput(root, "9".repeat(64)), call());
  await successfulEngine.attachCustody(successfulAuthority, call());
  successful.mutationPlan = { effect: true, statusCode: 304 };
  await successfulEngine.start(successfulAuthority, call());
  successful.mutationPlan = { effect: false, statusCode: 304 };
  await assert.rejects(successfulEngine.stop(successfulAuthority, call()), { code: "mutation-acknowledgement-unknown" });
  successful.mutationPlan = { effect: true, failure: "disconnect", statusCode: 204 };
  await successfulEngine.stop(successfulAuthority, call());
  successful.mutationPlan = { effect: false, statusCode: 409 };
  await assert.rejects(successfulEngine.remove(successfulAuthority, call()), { code: "request-rejected", statusCode: 409 });
  const duplicate = syntheticDaemon();
  const duplicateEngine = new NodeUnixSocketDockerEngine({ client: duplicate.client, policy: policy(root) });
  await duplicateEngine.create(createInput(root), call());
  duplicate.mutationPlan = { effect: false, statusCode: 409 };
  await assert.rejects(duplicateEngine.create(createInput(root, "4".repeat(64)), call()), {
    code: "resource-already-exists",
    statusCode: 409,
  });
});

test("attach invalidation fences start at the synchronous transport-write seam", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  for (const mode of ["close", "error", "abort"] as const) {
    await t.test(mode, async () => {
      const daemon = syntheticDaemon();
      const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
      const authority = await engine.create(createInput(root, createHash("sha256").update(mode).digest("hex")), call());
      const controller = new AbortController();
      const channel = await engine.attachCustody(authority, {
        deadlineEpochMs: Date.now() + 10_000,
        signal: controller.signal,
      });
      const barrier = daemon.pauseNextMutationWrite("before");
      const starting = engine.start(authority, call());
      await barrier.reached;
      if (mode === "close") {await channel.close();}
      if (mode === "error") {daemon.failHijack();}
      if (mode === "abort") {controller.abort();}
      await new Promise<void>(resolve => {setImmediate(resolve);});
      barrier.release();
      await assert.rejects(starting, {code: mode === "abort" ? "aborted" : "daemon-disconnected"});
      const observation = await engine.inspect(authority, call());
      assert.equal(observation.existence, "present");
      if (observation.existence === "present") {assert.equal(observation.state.status, "created");}
      await channel.close();
      controller.abort();
      assert.equal(daemon.hijackCloseCount, 1);
      await assert.rejects(engine.attachCustody(authority, call()), {code: "protocol-violation"});
    });
  }
});

test("hijack loss after start bytes is acknowledgement-unknown and removal retires the generation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
  const authority = await engine.create(createInput(root), call());
  const channel = await engine.attachCustody(authority, call());
  const barrier = daemon.pauseNextMutationWrite("after");
  const starting = engine.start(authority, call());
  await barrier.reached;
  await channel.close();
  barrier.release();
  await assert.rejects(starting, {code: "start-acknowledgement-unknown"});
  assert.equal(daemon.hijackCloseCount, 1);
  await engine.stop(authority, call());
  await engine.remove(authority, call());

  const replacement = await engine.create(createInput(root, "8".repeat(64)), call());
  const replacementChannel = await engine.attachCustody(replacement, call());
  await channel.close();
  await replacementChannel.write(Buffer.from("replacement-generation"));
  await replacementChannel.close();
  assert.equal(daemon.hijackCloseCount, 2);
});

test("error and abort after the start write never return clean started success", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  for (const mode of ["error", "abort"] as const) {
    await t.test(mode, async () => {
      const daemon = syntheticDaemon();
      const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
      const authority = await engine.create(createInput(
        root,
        createHash("sha256").update(`after-${mode}`).digest("hex"),
      ), call());
      const controller = new AbortController();
      await engine.attachCustody(authority, {deadlineEpochMs: Date.now() + 10_000, signal: controller.signal});
      const barrier = daemon.pauseNextMutationWrite("after");
      const starting = engine.start(authority, call());
      await barrier.reached;
      if (mode === "error") {daemon.failHijack();} else {controller.abort();}
      await new Promise<void>(resolve => {setImmediate(resolve);});
      barrier.release();
      await assert.rejects(starting, {code: "start-acknowledgement-unknown"});
      assert.equal(daemon.hijackCloseCount, 1);
    });
  }
});

test("log EOF is incomplete while running and wait requires an exact terminal observation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  daemon.logLeavesRunning = true;
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  await engine.attachCustody(authority, call());
  await engine.start(authority, call());
  await assert.rejects(drain(engine.logs(authority, call())), { code: "terminal-observation-unknown" });
  await assert.rejects(engine.wait(authority, call()), { code: "terminal-observation-unknown" });
  await engine.stop(authority, call());
  assert.equal((await engine.wait(authority, call())).existence, "present");
});

test("inspection state decoding enforces bounded values, Docker timestamps, and the status truth table", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const transforms: Array<(state: Record<string, unknown>) => void> = [
    state => {state.Pid = -1;},
    state => {state.ExitCode = 256;},
    state => {state.StartedAt = "not-a-docker-timestamp";},
    state => {state.FinishedAt = "2026-02-30T00:00:00Z";},
    state => {state.Status = "running"; state.Running = false;},
    state => {state.Status = "running"; state.Running = true; state.Pid = 0; state.StartedAt = "2026-01-01T00:00:00Z";},
    state => {state.Status = "paused"; state.Running = true; state.Paused = false; state.Pid = 42; state.StartedAt = "2026-01-01T00:00:00Z";},
    state => {state.Status = "exited"; state.Dead = false; state.Pid = 42; state.StartedAt = "2026-01-01T00:00:00Z"; state.FinishedAt = "2026-01-01T00:00:01Z";},
    state => {state.Status = "dead"; state.Dead = false; state.StartedAt = "2026-01-01T00:00:00Z"; state.FinishedAt = "2026-01-01T00:00:01Z";},
    state => {state.Status = "exited"; state.StartedAt = "2026-01-01T00:00:02Z"; state.FinishedAt = "2026-01-01T00:00:01Z";},
  ];
  for (const [index, transform] of transforms.entries()) {
    const daemon = syntheticDaemon();
    daemon.inspectTransform = value => {transform(value.State as Record<string, unknown>);};
    const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
    await assert.rejects(engine.create(
      createInput(root, createHash("sha256").update(`state-${index}`).digest("hex")),
      call(),
    ), { code: "malformed-response" });
  }
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
    daemonPid: 17,
    daemonStartTicks: "300",
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
    code: process.platform === "linux" ? "endpoint-custody-lost" : "unsupported-platform",
  });
  const alias = join(root, "alias.sock");
  await symlink(socketPath, alias);
  await assert.rejects(new BoundedUnixHttpClient({ ...endpointPolicy, socketPath: alias }).endpointIdentity(call()), {
    code: process.platform === "linux" ? "endpoint-custody-lost" : "unsupported-platform",
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
      "Content-Type", "application/json", "content-type", "application/json", "Content-Length", "2",
    ])),
    async () => observed,
    syntheticPeerConnector,
  );
  await assert.rejects(duplicateHeaders.buffered({ call: call(), method: "GET", path: "/fixed" }), {
    code: "protocol-violation",
  });
  const framedClient = (body: Uint8Array, headers: readonly string[]) => new BoundedUnixHttpClient(
    endpointPolicy,
    responseFactory(incoming(body, headers)),
    async () => observed,
    syntheticPeerConnector,
  );
  await assert.rejects(framedClient(Buffer.from("{}"), [
    "Content-Type", "application/json",
  ]).buffered({ call: call(), method: "GET", path: "/fixed" }), { code: "protocol-violation" });
  await assert.rejects(framedClient(Buffer.from("{}"), [
    "Content-Type", "application/json", "Transfer-Encoding", "gzip",
  ]).buffered({ call: call(), method: "GET", path: "/fixed" }), { code: "protocol-violation" });
  await assert.rejects(framedClient(Buffer.from("{}"), [
    "Content-Type", "application/json", "Content-Length", "2", "Transfer-Encoding", "chunked",
  ]).buffered({ call: call(), method: "GET", path: "/fixed" }), { code: "protocol-violation" });
  await assert.rejects(framedClient(Buffer.from("{}"), [
    "Content-Type", "application/json", "Content-Length", "3",
  ]).buffered({ call: call(), method: "GET", path: "/fixed" }), { code: "protocol-violation" });
  assert.equal((await framedClient(Buffer.from("{}"), [
    "Content-Type", "application/json", "Transfer-Encoding", "chunked",
  ]).buffered({ call: call(), method: "GET", path: "/fixed" })).body.byteLength, 2);
});

test("Unix transport holds a pinned endpoint and authenticates the daemon generation before request bytes", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const socketPath = join(root, "authenticated.sock");
  const events: string[] = [];
  const observation: DockerEndpointObservation = {
    canonicalSocketPath: socketPath,
    ctimeNs: 3n,
    daemonBootGeneration: "pid=17;start=300;socket=400",
    daemonCustodyToken: "pid-file-custody-v1",
    daemonPid: 17,
    daemonStartTicks: "300",
    device: 1n,
    gid: 42n,
    hostBootId: "12345678-1234-4123-8123-123456789abc",
    inode: 2n,
    mode: 0o600,
    socket: true,
    symbolicLink: false,
    uid: 41n,
  };
  const response = incoming(Buffer.from("{}"));
  const requestFactory = (options: RequestOptions): ClientRequest => {
    events.push("request-created");
    return responseFactory(response)(options);
  };
  const peerConnector = async (_policy: unknown, custody: { readonly token: string }, _call: unknown, observe: () => Promise<{ readonly token: string }>) => {
    assert.equal((await observe()).token, custody.token);
    events.push("peer-authenticated");
    const socket = new Socket();
    return { release: async () => {socket.destroy();}, socket };
  };
  const client = new BoundedUnixHttpClient({
    daemonPidFileMode: 0o600,
    daemonPidFileOwnerGid: 42,
    daemonPidFileOwnerUid: 41,
    daemonPidFilePath: join(root, "docker.pid"),
    socketMode: 0o600,
    socketOwnerGid: 42,
    socketOwnerUid: 41,
    socketPath,
  }, requestFactory, async () => observation, peerConnector);
  const result = await client.buffered({ call: call(), method: "GET", path: "/v1.47/info" });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(events, ["peer-authenticated", "request-created"]);
});

test("production Unix peer binding reaches only the descriptor-held daemon socket", async t => {
  await verifyProductionUnixPeerBinding(t, disposable, policy, call);
});

test("descriptor-held Unix peer binding is typed unsupported off Linux", () => {
  assert.throws(() => {assertDockerUnixPeerPlatformSupported("darwin");}, { code: "unsupported-platform" });
});

test("Fake parity covers canonical mounts, exact adoption, ambiguous effects, endpoint custody, and terminal logs", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const fake = new FakeDockerEngine(policy(root));
  fake.enqueueCreateOutcome("lost-acknowledgement");
  const authority = await fake.create(createInput(root), call());
  fake.enqueueCreateOutcome("malformed-response");
  await fake.create(createInput(root, "7".repeat(64)), call());
  await fake.attachCustody(authority, call());
  await fake.start(authority, call());
  let waitSettled = false;
  const waiting = fake.wait(authority, call()).then(observation => {waitSettled = true; return observation;});
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(waitSettled, false);
  fake.setLogs(authority, [{ bytes: Buffer.from("running-eof"), stream: "stdout" }]);
  await assert.rejects(drain(fake.logs(authority, call())), { code: "terminal-observation-unknown" });
  fake.enqueueMutationOutcome("stop", { acknowledgement: "304", effect: "not-applied" });
  await assert.rejects(fake.stop(authority, call()), { code: "mutation-acknowledgement-unknown" });
  fake.enqueueMutationOutcome("stop", { acknowledgement: "lost", effect: "applied" });
  await fake.stop(authority, call());
  assert.equal((await waiting).existence, "present");
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
  const disconnectedCreate = new FakeDockerEngine(policy(root));
  disconnectedCreate.enqueueCreateOutcome("daemon-disconnect");
  await assert.rejects(disconnectedCreate.create(createInput(root, "3".repeat(64)), call()), {
    code: "create-acknowledgement-unknown",
  });
  assert.ok(DockerEngineError.prototype instanceof Error);
});

test("multiplex parser preserves frames and refuses malformed, oversized, and truncated bytes", async () => {
  const valid = Buffer.concat([multiplex(1, Buffer.from("a")), multiplex(2, Buffer.from("bc"))]);
  const observed: DockerLogFrame[] = [];
  for await (const frame of parseDockerMultiplexedStream(chunks(valid), 8, 32)) {observed.push(frame);}
  assert.deepEqual(observed.map(frame => [frame.stream, Buffer.from(frame.bytes).toString()]), [
    ["stdout", "a"], ["stderr", "bc"],
  ]);
  await assert.rejects(drain(parseDockerMultiplexedStream(chunks(valid.subarray(0, 8)), 8, 16)), {
    code: "stream-truncated",
  });
  await assert.rejects(drain(parseDockerMultiplexedStream(chunks(multiplex(1, Buffer.alloc(9))), 8, 16)), {
    code: "stream-frame-too-large",
  });
  await assert.rejects(drain(parseDockerMultiplexedStream(chunks(multiplex(1, Buffer.from("x"))), 8, 8)), {
    code: "stream-too-large",
  });
  const emptyFrames = Buffer.concat([multiplex(1, Buffer.alloc(0)), multiplex(1, Buffer.alloc(0)), multiplex(2, Buffer.alloc(0))]);
  await assert.rejects(drain(parseDockerMultiplexedStream(chunks(emptyFrames), 8, 64, 2)), {
    code: "stream-too-large",
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
