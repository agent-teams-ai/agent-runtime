import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";

import {
  BoundedUnixHttpClient,
  type DockerEndpointObservation,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import { createDockerCustodyChannel } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-custody-channel.js";
import { FakeDockerEngine } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { call as engineCall, createInput, disposable, policy } from "./fixtures/docker-engine-test-fixture.ts";

const call = (signal = new AbortController().signal, milliseconds = 2_000) => ({
  deadlineEpochMs: Date.now() + milliseconds,
  signal,
});

const multiplex = (stream: 1 | 2, payload: Uint8Array): Buffer => {
  const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
};

const fixture = async (serve: (socket: Socket, request: Buffer) => void) => {
  const root = await mkdtemp(join(tmpdir(), "ar-docker-attach-"));
  const socketPath = join(root, "engine.sock");
  const server = createServer(socket => {
    socket.on("error", () => {});
    let request = Buffer.alloc(0);
    socket.on("data", chunk => {
      request = Buffer.concat([request, chunk]);
      const boundary = request.indexOf("\r\n\r\n");
      if (boundary >= 0) {
        socket.removeAllListeners("data");
        const headers = request.subarray(0, boundary + 4);
        const extra = request.subarray(boundary + 4);
        if (extra.byteLength > 0) {socket.unshift(extra);}
        serve(socket, headers);
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  const observation: DockerEndpointObservation = {
    canonicalSocketPath: socketPath, ctimeNs: 1n, daemonBootGeneration: "daemon-generation",
    daemonCustodyToken: "daemon-token", daemonPid: process.pid, daemonStartTicks: "1", device: 1n,
    gid: 42n, hostBootId: "12345678-1234-4123-8123-123456789abc", inode: 2n, mode: 0o600,
    socket: true, symbolicLink: false, uid: 41n,
  };
  const connector = async () => {
    const socket = createConnection(socketPath);
    await once(socket, "connect");
    return {release: async () => {socket.destroy();}, socket};
  };
  const client = new BoundedUnixHttpClient({
    daemonPidFileMode: 0o600, daemonPidFileOwnerGid: 42, daemonPidFileOwnerUid: 41,
    daemonPidFilePath: join(root, "docker.pid"), socketMode: 0o600, socketOwnerGid: 42,
    socketOwnerUid: 41, socketPath,
  }, undefined, async () => observation, connector);
  return {
    client,
    close: async () => {server.close(); await once(server, "close"); await rm(root, {force: true, recursive: true});},
  };
};

const upgrade = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n";

test("the exact owner-bound container is attached after create and before start", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const engine = new FakeDockerEngine(policy(root));
  const authority = await engine.create(createInput(root), engineCall());
  const channel = await engine.attachCustody(authority, engineCall());
  await assert.rejects(engine.attachCustody(authority, engineCall()), {code: "protocol-violation"});
  await engine.start(authority, engineCall());
  assert.deepEqual(engine.events.filter(event => /^(?:create|attach|start):/u.test(event)), [
    "create:acknowledged", "attach:id", "start:id",
  ]);
  await channel.close();
  await assert.rejects(engine.attachCustody(authority, engineCall()), {code: "protocol-violation"});
});

test("v1.47 pre-start attach survives fragmented upgrade and coalesced Docker frames", async () => {
  let request = "";
  let input = Buffer.alloc(0);
  const current = await fixture((socket, headers) => {
    request = headers.toString("ascii");
    socket.on("data", chunk => {input = Buffer.concat([input, chunk]); socket.end();});
    const frames = Buffer.concat([multiplex(1, Buffer.from("one")), multiplex(1, Buffer.from("two"))]);
    socket.write(upgrade.slice(0, 17));
    socket.write(Buffer.concat([Buffer.from(upgrade.slice(17)), frames.subarray(0, 5)]));
    socket.write(frames.subarray(5));
  });
  try {
    const raw = await current.client.hijack({
      call: call(), path: "/v1.47/containers/owner-bound-id/attach?stream=1&stdin=1&stdout=1&stderr=1",
    });
    const channel = createDockerCustodyChannel(raw);
    await channel.write(Buffer.from("typed-control"));
    const output: string[] = [];
    for await (const bytes of channel.output) {output.push(Buffer.from(bytes).toString());}
    assert.deepEqual(output, ["one", "two"]);
    assert.match(request, /^POST \/v1\.47\/containers\/owner-bound-id\/attach\?stream=1&stdin=1&stdout=1&stderr=1 HTTP\/1\.1\r\n/u);
    assert.match(request.toLowerCase(), /connection: upgrade\r\n/u);
    assert.equal(input.toString(), "typed-control");
  } finally {await current.close();}
});

test("attach rejects malformed status, stderr, oversized frames, abort, and deadline", async t => {
  const cases = [
    {name: "status", response: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", code: "protocol-violation"},
    {name: "stderr", response: Buffer.concat([Buffer.from(upgrade), multiplex(2, Buffer.from("anomaly"))]), code: "protocol-violation"},
    {name: "oversized", response: (() => {const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(65_537, 4); return Buffer.concat([Buffer.from(upgrade), header]);})(), code: "stream-frame-too-large"},
  ] as const;
  for (const item of cases) {
    await t.test(item.name, async () => {
      const current = await fixture(socket => {socket.end(item.response);});
      try {
        const opened = current.client.hijack({call: call(), path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1"});
        if (item.name === "status") {await assert.rejects(opened, {code: item.code}); return;}
        const channel = createDockerCustodyChannel(await opened);
        await assert.rejects(async () => {for await (const bytes of channel.output) {void bytes;}}, {code: item.code});
      } finally {await current.close();}
    });
  }
  for (const mode of ["abort", "deadline"] as const) {
    await t.test(mode, async () => {
      const current = await fixture(socket => {socket.write(upgrade);});
      const controller = new AbortController();
      try {
        const channel = createDockerCustodyChannel(await current.client.hijack({
          call: call(controller.signal, mode === "deadline" ? 20 : 2_000),
          path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1",
        }));
        const draining = (async () => {for await (const bytes of channel.output) {void bytes;}})();
        if (mode === "abort") {controller.abort();}
        await assert.rejects(draining, {code: mode === "abort" ? "aborted" : "deadline-exceeded"});
      } finally {await current.close();}
    });
  }
});
