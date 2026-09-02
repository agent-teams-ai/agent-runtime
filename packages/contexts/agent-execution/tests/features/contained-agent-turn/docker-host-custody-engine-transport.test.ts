import assert from "node:assert/strict";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import type { ClientRequest, RequestOptions } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import {
  DOCKER_LOG_MAX_STREAM_BYTES,
  DockerEngineError,
  FakeDockerEngine,
  parseDockerMultiplexedStream,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { BoundedUnixHttpClient } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import { assertDockerUnixPeerPlatformSupported } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-unix-peer.js";
import type { DockerEndpointObservation } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import type { DockerLogFrame } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import {
  call,
  createInput,
  disposable,
  policy,
} from "../../fixtures/docker-engine-test-fixture.ts";
import { verifyProductionUnixPeerBinding } from "../../fixtures/docker-unix-peer-binding.ts";
import {
  drain,
  incoming,
  multiplex,
  responseFactory,
  syntheticPeerConnector,
} from "./docker-engine-transport-test-fixture.ts";

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes.slice(0, 3);
  yield bytes.slice(3);
}

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
