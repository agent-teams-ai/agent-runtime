import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { request as httpRequest, type ClientRequest, type RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  BoundedUnixHttpClient,
  type DockerEndpointObservation,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import { openBoundedUnixHijack } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-hijack.js";
import { createDockerCustodyChannel } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-custody-channel.js";
import { DockerEngineError } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-error.js";
import { FakeDockerEngine } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { call as engineCall, createInput, disposable, policy } from "../../fixtures/docker-engine-test-fixture.ts";

const call = (signal = new AbortController().signal, milliseconds = 2_000) => ({
  deadlineEpochMs: Date.now() + milliseconds,
  signal,
});

const RELEASE_SETTLEMENT_TIMEOUT_MS = 1_000;
const scheduleRealTimeout = setTimeout;
const clearRealTimeout = clearTimeout;

const multiplex = (stream: 1 | 2, payload: Uint8Array): Buffer => {
  const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
};

const fixture = async (
  serve: (socket: Socket, request: Buffer) => void,
  options: {
    readonly beforeConnectReturn?: () => Promise<void>;
    readonly observe?: (observation: DockerEndpointObservation) => Promise<DockerEndpointObservation>;
    readonly requestFactory?: (options: RequestOptions) => ClientRequest;
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "ar-docker-attach-"));
  const socketPath = join(root, "engine.sock");
  const server = createServer(socket => {
    socket.on("error", () => {});
    let requestBytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      requestBytes = Buffer.concat([requestBytes, chunk]);
      const boundary = requestBytes.indexOf("\r\n\r\n");
      if (boundary >= 0) {
        socket.removeAllListeners("data");
        const headers = requestBytes.subarray(0, boundary + 4);
        const extra = requestBytes.subarray(boundary + 4);
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
  let exactSocket: Socket | undefined;
  let connectCount = 0;
  let releaseCount = 0;
  let settleRelease!: () => void;
  const released = new Promise<void>(resolve => {settleRelease = resolve;});
  const releaseSettled = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        released.then(() => "released" as const),
        new Promise<"timed-out">(resolve => {
          timeout = scheduleRealTimeout(() => {resolve("timed-out");}, RELEASE_SETTLEMENT_TIMEOUT_MS);
        }),
      ]);
      assert.equal(outcome, "released", "release did not settle within the bounded timeout");
    } finally {
      if (timeout !== undefined) {clearRealTimeout(timeout);}
    }
  };
  const connector = async () => {
    connectCount += 1;
    const socket = createConnection(socketPath);
    await once(socket, "connect");
    exactSocket = socket;
    await options.beforeConnectReturn?.();
    return {release: async () => {
      releaseCount += 1;
      socket.destroy();
      settleRelease();
    }, socket};
  };
  const client = new BoundedUnixHttpClient({
    daemonPidFileMode: 0o600, daemonPidFileOwnerGid: 42, daemonPidFileOwnerUid: 41,
    daemonPidFilePath: join(root, "docker.pid"), socketMode: 0o600, socketOwnerGid: 42,
    socketOwnerUid: 41, socketPath,
  }, options.requestFactory, async () => options.observe?.(observation) ?? observation, connector);
  return {
    client,
    close: async () => {
      exactSocket?.destroy();
      server.close(); await once(server, "close"); await rm(root, {force: true, recursive: true});
    },
    get connectCount() {return connectCount;},
    get exactSocket() {return exactSocket;},
    get releaseCount() {return releaseCount;},
    releaseSettled,
  };
};

const upgrade = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n";

test("the exact owner-bound container is attached after create and before start", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const engine = new FakeDockerEngine(policy(root));
  const authority = await engine.create(createInput(root), engineCall());
  await assert.rejects(engine.start(authority, engineCall()), {code: "protocol-violation"});
  const channel = await engine.attachCustody(authority, engineCall());
  await assert.rejects(engine.attachCustody(authority, engineCall()), {code: "protocol-violation"});
  await channel.write(Buffer.from("init-stdin-control"));
  assert.equal(Buffer.from(engine.custodyInput(authority)).toString(), "init-stdin-control");
  await engine.start(authority, engineCall());
  await assert.rejects(engine.start(authority, engineCall()), {code: "protocol-violation"});
  assert.deepEqual(engine.events.filter(event => /^(?:create|attach|start):/u.test(event)), [
    "create:acknowledged", "attach:id", "start:id",
  ]);
  await channel.close();
  await assert.rejects(engine.attachCustody(authority, engineCall()), {code: "protocol-violation"});
});

test("close, EOF, abort, and deadline poison the sole pre-start attach generation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  for (const mode of ["close", "input-eof", "output-eof", "abort", "deadline"] as const) {
    const engine = new FakeDockerEngine(policy(root));
    const authority = await engine.create(createInput(root, `${mode.charCodeAt(0)}`.repeat(64).slice(0, 64)), engineCall());
    const controller = new AbortController();
    const now = Date.now();
    if (mode === "deadline") {t.mock.timers.enable({apis: ["Date", "setTimeout"], now});}
    const channel = await engine.attachCustody(authority, call(controller.signal, mode === "deadline" ? 1_000 : 2_000));
    if (mode === "close") {await channel.close();}
    if (mode === "input-eof") {await channel.closeInput();}
    if (mode === "output-eof") {for await (const bytes of channel.output) {void bytes;}}
    if (mode === "abort") {controller.abort();}
    if (mode === "deadline") {t.mock.timers.tick(1_001);}
    await assert.rejects(engine.start(authority, engineCall()), {code: "protocol-violation"}, mode);
    await assert.rejects(engine.attachCustody(authority, engineCall()), {code: "protocol-violation"}, mode);
    t.mock.timers.reset();
  }
});

test("the fake shares start ambiguity and fail-closed generation semantics", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const engine = new FakeDockerEngine(policy(root));
  const authority = await engine.create(createInput(root), engineCall());
  await engine.attachCustody(authority, engineCall());
  engine.enqueueMutationOutcome("start", {acknowledgement: "lost", effect: "applied"});
  await assert.rejects(engine.start(authority, engineCall()), {code: "start-acknowledgement-unknown"});
  await assert.rejects(engine.attachCustody(authority, engineCall()), {code: "protocol-violation"});
});

test("the fake arms opening abort before its first awaited record continuation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const engine = new FakeDockerEngine(policy(root));
  const authority = await engine.create(createInput(root), engineCall());
  const controller = new AbortController();
  const opening = engine.attachCustody(authority, call(controller.signal));
  controller.abort();
  await assert.rejects(opening, {code: "aborted"});
  await assert.rejects(engine.start(authority, engineCall()), {code: "protocol-violation"});
  await assert.rejects(engine.attachCustody(authority, engineCall()), {code: "protocol-violation"});
});

test("v1.47 pre-start attach survives fragmented upgrade and coalesced Docker frames", async () => {
  let receivedRequest = "";
  let input = Buffer.alloc(0);
  const current = await fixture((socket, headers) => {
    receivedRequest = headers.toString("ascii");
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
    assert.match(receivedRequest, /^POST \/v1\.47\/containers\/owner-bound-id\/attach\?stream=1&stdin=1&stdout=1&stderr=1 HTTP\/1\.1\r\n/u);
    assert.match(receivedRequest.toLowerCase(), /connection: upgrade\r\n/u);
    assert.equal(input.toString(), "typed-control");
  } finally {await current.close();}
});

test("a validated hijack outlives the 120-second establishment cap without wall-clock waiting", async t => {
  const current = await fixture(socket => {socket.write(upgrade);});
  try {
    const now = Date.now();
    t.mock.timers.enable({apis: ["Date", "setTimeout"], now});
    const raw = await current.client.hijack({
      call: {deadlineEpochMs: now + 180_000, signal: new AbortController().signal},
      path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1",
    });
    t.mock.timers.tick(120_001);
    assert.equal(raw.input.destroyed, false);
    await raw.close();
  } finally {await current.close();}
});

test("channel writes recheck an expired deadline before an overdue timer can run", async t => {
  for (const seam of ["write", "closeInput"] as const) {
    await t.test(seam, async context => {
      let input = Buffer.alloc(0);
      const current = await fixture(socket => {
        socket.on("data", chunk => {input = Buffer.concat([input, chunk]);});
        socket.write(upgrade);
      });
      const now = Date.now();
      context.mock.timers.enable({apis: ["Date", "setTimeout"], now});
      try {
        const raw = await current.client.hijack({
          call: {deadlineEpochMs: now + 1_000, signal: new AbortController().signal},
          path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1",
        });
        const channel = createDockerCustodyChannel(raw);
        context.mock.timers.setTime(now + 1_001);
        const attempted = seam === "write" ? channel.write(Buffer.from("must-not-write")) : channel.closeInput();
        await assert.rejects(attempted, {code: "deadline-exceeded"});
        await current.releaseSettled();
        assert.equal(input.byteLength, 0);
        assert.equal(current.releaseCount, 1);
        await channel.close();
        assert.equal(current.releaseCount, 1);
      } finally {
        context.mock.timers.reset();
        await current.close();
      }
    });
  }
});

test("abort is contained between accepted upgrade and custody-channel listener installation", async () => {
  const current = await fixture(socket => {socket.write(upgrade);});
  const controller = new AbortController();
  try {
    const raw = await current.client.hijack({
      call: call(controller.signal),
      path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1",
    });
    controller.abort();
    await assert.rejects(async () => {
      for await (const bytes of raw.output) {void bytes;}
    }, {code: "aborted"});
    await raw.close();
    await raw.close();
  } finally {await current.close();}
});

test("hijack establishment fails closed while custody verification is pending", async t => {
  for (const mode of ["socket-error", "socket-close", "abort", "deadline"] as const) {
    await t.test(mode, async context => {
      let releaseVerification: (() => void) | undefined;
      let verificationReached: (() => void) | undefined;
      const reached = new Promise<void>(resolve => {verificationReached = resolve;});
      const verification = new Promise<void>(resolve => {releaseVerification = resolve;});
      let observations = 0;
      const current = await fixture(socket => {socket.write(upgrade);}, {
        observe: async observation => {
          observations += 1;
          if (observations === 2) {verificationReached?.(); await verification;}
          return observation;
        },
      });
      const controller = new AbortController();
      try {
        const now = Date.now();
        if (mode === "deadline") {context.mock.timers.enable({apis: ["Date", "setTimeout"], now});}
        const opening = current.client.hijack({
          call: {deadlineEpochMs: now + 1_000, signal: controller.signal},
          path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1",
        });
        await reached;
        if (mode === "socket-error") {
          current.exactSocket?.destroy(new DockerEngineError("endpoint-custody-lost"));
        } else if (mode === "socket-close") {
          current.exactSocket?.destroy();
        } else if (mode === "abort") {
          controller.abort();
        } else {
          context.mock.timers.tick(1_001);
        }
        await assert.rejects(opening, {
          code: mode === "socket-error" ? "endpoint-custody-lost" : mode === "abort" ? "aborted" :
            mode === "deadline" ? "deadline-exceeded" : "daemon-disconnected",
        });
        assert.equal(current.exactSocket?.destroyed, true);
        assert.equal(current.releaseCount, 1);
        releaseVerification?.();
        await new Promise<void>(resolve => {setImmediate(resolve);});
        assert.equal(current.releaseCount, 1);
      } finally {
        releaseVerification?.();
        context.mock.timers.reset();
        await current.close();
      }
    });
  }
});

test("synchronous hijack construction failures preserve typed errors and release exact resources", async t => {
  for (const seam of ["request", "end"] as const) {
    await t.test(seam, async () => {
      const cause = new DockerEngineError("protocol-violation");
      const current = await fixture(() => {assert.fail("failed construction must not write request bytes");}, {
        requestFactory: options => {
          if (seam === "request") {throw cause;}
          const operation = httpRequest(options);
          operation.end = (() => {throw cause;}) as typeof operation.end;
          return operation;
        },
      });
      try {
        let rejected: unknown;
        try {
          await current.client.hijack({call: call(), path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1"});
        } catch (error) {rejected = error;}
        assert.strictEqual(rejected, cause);
        assert.equal(current.exactSocket?.destroyed, true);
        assert.equal(current.releaseCount, 1);
      } finally {await current.close();}
    });
  }
});

test("final Unix request and hijack seams recheck abort and frozen deadlines after awaited custody and peer work", async t => {
  for (const seam of ["request", "hijack"] as const) {
    for (const awaited of ["custody", "peer"] as const) {
      for (const mode of ["abort", "deadline"] as const) {
        await t.test(`${seam}-${awaited}-${mode}`, async context => {
          let releaseWait!: () => void;
          let reached!: () => void;
          const wait = new Promise<void>(resolve => {releaseWait = resolve;});
          const atWait = new Promise<void>(resolve => {reached = resolve;});
          let observations = 0;
          let requestObserved = false;
          const current = await fixture(() => {requestObserved = true;}, {
            beforeConnectReturn: awaited === "peer" ? async () => {reached(); await wait;} : undefined,
            observe: awaited === "custody" ? async observation => {
              observations += 1;
              if (observations === 1) {reached(); await wait;}
              return observation;
            } : undefined,
          });
          const controller = new AbortController();
          const now = Date.now();
          if (mode === "deadline") {context.mock.timers.enable({apis: ["Date", "setTimeout"], now});}
          try {
            const boundedCall = {deadlineEpochMs: now + 1_000, signal: controller.signal};
            const opening = seam === "request"
              ? current.client.buffered({call: boundedCall, method: "POST", path: "/v1.47/containers/id/start"})
              : current.client.hijack({
                call: boundedCall,
                path: "/v1.47/containers/id/attach?stream=1&stdin=1&stdout=1&stderr=1",
              });
            await atWait;
            if (mode === "abort") {controller.abort();} else {context.mock.timers.tick(1_001);}
            releaseWait();
            await assert.rejects(opening, {code: mode === "abort" ? "aborted" : "deadline-exceeded"});
            if (awaited === "peer") {
              await current.releaseSettled();
            }
            assert.equal(requestObserved, false);
            assert.equal(current.connectCount, awaited === "peer" ? 1 : 0);
            assert.equal(current.releaseCount, awaited === "peer" ? 1 : 0);
          } finally {
            releaseWait();
            context.mock.timers.reset();
            await current.close();
          }
        });
      }
    }
  }
});

test("hijack end failure settles its typed cause before every throwing cleanup and releases exactly once", async () => {
  const cause = new DockerEngineError("protocol-violation");
  const cleanup = {destroy: 0, listeners: 0, release: 0, socket: 0};
  const socket = new PassThrough();
  socket.destroy = (() => {cleanup.socket += 1; throw new Error("socket cleanup");}) as typeof socket.destroy;
  const events = new EventEmitter();
  const operation = Object.assign(events, {
    destroy() {cleanup.destroy += 1; throw new Error("request cleanup");},
    end() {throw cause;},
    removeAllListeners() {cleanup.listeners += 1; throw new Error("listener cleanup");},
  }) as unknown as ClientRequest;
  let rejected: unknown;
  try {
    await openBoundedUnixHijack({
      call: call(), effectiveMs: 1_000, path: "/attach",
      release: async () => {cleanup.release += 1; throw new Error("release cleanup");},
      request: () => operation, socket, verifyCustody: async () => {},
    });
  } catch (error) {rejected = error;}
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.strictEqual(rejected, cause);
  assert.deepEqual(cleanup, {destroy: 1, listeners: 1, release: 1, socket: 1});
});

test("the real Unix transport honors abort at the final synchronous pre-write seam", async () => {
  let requestObserved = false;
  const current = await fixture(() => {requestObserved = true;});
  const controller = new AbortController();
  try {
    await assert.rejects(current.client.buffered({
      beforeWrite: () => {controller.abort();},
      call: call(controller.signal),
      method: "POST",
      path: "/v1.47/containers/id/start",
    }), {code: "aborted"});
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(requestObserved, false);
    assert.equal(current.releaseCount, 1);
    assert.equal(current.exactSocket?.destroyed, true);
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
