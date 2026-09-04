import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { getEventListeners } from "node:events";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import {
  NodeTlsHttpEgressError,
  NodeTlsHttpEgressTransport,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-tls-http-egress-transport.js";
import { canonicalLiteralAddress, createBinding, fixTrust } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-tls-http-egress-transport-support.js";
import {
  SYNTHETIC_LOOPBACK_CA,
  SYNTHETIC_LOOPBACK_SERVER_CERTIFICATE,
  SYNTHETIC_OTHER_CA,
  SYNTHETIC_WRONG_SAN_SERVER_CERTIFICATE,
  SYNTHETIC_WRONG_SAN_SERVER_KEY,
} from "../../fixtures/http-egress-tls/synthetic-loopback-certificates.ts";
import {
  collect,
  startLoopbackTlsServer,
  startStalledTcpServer,
  SyntheticOwnedTlsSocket,
  syntheticConnector,
  utf8,
} from "./node-tls-http-egress-transport-test-helper.ts";

const target = (port: number, overrides: Record<string, unknown> = {}) => ({
  originHost: "provider.test",
  originPort: port,
  selectedAddress: "127.0.0.1",
  sni: "provider.test",
  alpn: "http/1.1" as const,
  ...overrides,
});

const transport = (ca: string | Uint8Array = SYNTHETIC_LOOPBACK_CA, overrides: Record<string, number> = {}) =>
  new NodeTlsHttpEgressTransport({
    certificateAuthorities: [ca],
    connectTimeoutMs: overrides.connectTimeoutMs ?? 1_000,
    responseIdleTimeoutMs: overrides.responseIdleTimeoutMs ?? 1_000,
    closeTimeoutMs: overrides.closeTimeoutMs ?? 100,
  });

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const injectedTransport = (
  socket: SyntheticOwnedTlsSocket,
  mutate?: Parameters<typeof syntheticConnector>[1],
): NodeTlsHttpEgressTransport => new NodeTlsHttpEgressTransport({
  certificateAuthorities: [SYNTHETIC_LOOPBACK_CA],
  connectTimeoutMs: 100,
  responseIdleTimeoutMs: 100,
  closeTimeoutMs: 20,
}, syntheticConnector(socket, mutate));

const expectClosed = async (attempt: ReturnType<NodeTlsHttpEgressTransport["beginOpen"]>): Promise<void> => {
  const first = attempt.close();
  assert.equal(attempt.close(), first);
  const receipt = await first;
  assert.equal(receipt.state, "closed");
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/u);
};

describe("NodeTlsHttpEgressTransport real synthetic loopback TLS", () => {
  test("binds a valid policy SHA-256 stable across equal bindings", () => {
    const selectedAddress = canonicalLiteralAddress("127.0.0.1");
    assert.ok(selectedAddress);
    const input = {
      trust: fixTrust([SYNTHETIC_LOOPBACK_CA]),
      selectedAddress,
      expectedPort: 443,
      remoteAddress: "127.0.0.1",
      remotePort: 443,
      protocol: "TLSv1.3",
      alpn: "http/1.1",
      servername: "provider.test",
      expectedSni: "provider.test",
      certificate: new X509Certificate(SYNTHETIC_LOOPBACK_SERVER_CERTIFICATE),
      authorized: true,
      identityChecked: true,
      sessionReused: false,
    };
    const binding = createBinding(input);
    assert.match(binding.tlsPolicyDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(createBinding({ ...input }).tlsPolicyDigest, binding.tlsPolicyDigest);
    const policy = (authorities: (string | Uint8Array)[]) => createBinding({
      ...input, trust: fixTrust(authorities),
    }).tlsPolicyDigest;
    const combined = policy([SYNTHETIC_LOOPBACK_CA, SYNTHETIC_OTHER_CA]);
    assert.notEqual(combined, binding.tlsPolicyDigest);
    assert.notEqual(policy([SYNTHETIC_OTHER_CA]), binding.tlsPolicyDigest);
    assert.equal(policy([SYNTHETIC_OTHER_CA, SYNTHETIC_LOOPBACK_CA]), combined);
    assert.equal(policy([SYNTHETIC_LOOPBACK_CA, SYNTHETIC_OTHER_CA, SYNTHETIC_LOOPBACK_CA]), combined);
    assert.equal(policy([`${SYNTHETIC_OTHER_CA}\n${SYNTHETIC_LOOPBACK_CA}`]), combined);
    assert.equal(policy([Buffer.from(SYNTHETIC_LOOPBACK_CA.replaceAll("\n", "\r\n"))]), binding.tlsPolicyDigest);
    assert.match(combined, /^sha256:[0-9a-f]{64}$/u);
    const encoded = JSON.stringify(binding);
    assert.ok(!encoded.includes("CERTIFICATE"));
    assert.ok(!encoded.includes(new X509Certificate(SYNTHETIC_LOOPBACK_CA).raw.toString("base64")));
  });

  test("fingerprints the immutable canonical set of effective trust anchors", () => {
    const bytes = Buffer.from(SYNTHETIC_LOOPBACK_CA);
    const fixed = fixTrust([bytes, SYNTHETIC_OTHER_CA]);
    bytes.fill(0);
    const fingerprints = [SYNTHETIC_LOOPBACK_CA, SYNTHETIC_OTHER_CA]
      .map(pem => sha256(new X509Certificate(pem).raw)).sort();
    assert.equal(fixed.trustAnchorDigest,
      `sha256:${sha256(`agent-runtime.node-tls-trust-anchors/v1\n${fingerprints.join("\n")}\n`)}`);
    assert.match(fixed.trustAnchorDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(Object.isFrozen(fixed));
  });

  test("rejects malformed trust entries and bundles without exposing certificate bytes", () => {
    const malformed = "-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----";
    for (const authorities of [[], [""], ["garbage"], [malformed],
      [SYNTHETIC_LOOPBACK_CA, malformed], [`${SYNTHETIC_LOOPBACK_CA}\n${malformed}`],
      [`${SYNTHETIC_LOOPBACK_CA}\ntrailing-garbage`],
      [SYNTHETIC_LOOPBACK_CA.replace("-----END CERTIFICATE-----", "")],
      [new X509Certificate(SYNTHETIC_LOOPBACK_CA).raw], [new Uint8Array([255])]]) {
      assert.throws(() => fixTrust(authorities), (error: unknown) => {
        assert.ok(error instanceof NodeTlsHttpEgressError);
        assert.equal(error.code, "invalid_configuration");
        assert.equal(error.message, "node TLS HTTP egress: invalid_configuration");
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });

  test("dials the supplied literal without DNS and binds CA, SAN, SNI, ALPN, peer, TLS and digests", async () => {
    const server = await startLoopbackTlsServer({
      response: [utf8("HTTP/1.1 200 OK\r\n"), utf8("Content-Length: 2\r\n\r\n"), utf8("o"), utf8("k")],
    });
    try {
      const attempt = transport().beginOpen(target(server.port));
      const session = await attempt.ready();
      assert.deepEqual(server.observedSni(), ["provider.test"]);
      assert.equal(session.binding.peerAddress, "127.0.0.1");
      assert.equal(session.binding.peerPort, server.port);
      assert.match(session.binding.tlsProtocol, /^TLSv1\.[23]$/u);
      assert.equal(session.binding.alpn, "http/1.1");
      assert.equal(session.binding.requestedSni, "provider.test");
      assert.equal(session.binding.observedSni, "provider.test");

      const certificate = new X509Certificate(SYNTHETIC_LOOPBACK_SERVER_CERTIFICATE);
      const spki = certificate.publicKey.export({ type: "spki", format: "der" });
      assert.equal(session.binding.certificateDigest, `sha256:${sha256(certificate.raw)}`);
      assert.equal(session.binding.spkiDigest, `sha256:${sha256(spki)}`);
      assert.equal(Object.isFrozen(session.binding), true);

      const request = utf8("GET /synthetic HTTP/1.1\r\nHost: provider.test\r\n\r\n");
      const requestLength = request.byteLength;
      const dispatch = await session.dispatch(() => request);
      assert.equal(dispatch.status, "response");
      assert.equal(dispatch.acceptedRequestBytes, requestLength);
      assert.equal(dispatch.acknowledgement, "acknowledged");
      if (dispatch.status !== "response") {throw new Error("unreachable");}
      assert.equal(new TextDecoder().decode(await collect(dispatch.response)), "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      assert.equal(request.byteLength, requestLength);
      assert.equal(new TextDecoder().decode(request), "GET /synthetic HTTP/1.1\r\nHost: provider.test\r\n\r\n");
      request.fill(0); // The dispatch boundary owns cleanup, not the borrowing transport.
      assert.equal(new TextDecoder().decode(server.received()), "GET /synthetic HTTP/1.1\r\nHost: provider.test\r\n\r\n");
      await expectClosed(attempt);
      assert.equal(server.connections(), 1);
    } finally {
      await server.close();
    }
  });

  test("binds the configured CA set to real TLS sessions independently of the peer certificate", async () => {
    const server = await startLoopbackTlsServer();
    const bindings = [];
    try {
      for (const certificateAuthorities of [
        [SYNTHETIC_LOOPBACK_CA],
        [SYNTHETIC_LOOPBACK_CA, SYNTHETIC_OTHER_CA],
        [SYNTHETIC_OTHER_CA, SYNTHETIC_LOOPBACK_CA, SYNTHETIC_OTHER_CA],
      ]) {
        const attempt = new NodeTlsHttpEgressTransport({ certificateAuthorities }).beginOpen(target(server.port));
        try {bindings.push((await attempt.ready()).binding);}
        finally {await expectClosed(attempt);}
      }
      assert.notEqual(bindings[0].tlsPolicyDigest, bindings[1].tlsPolicyDigest);
      assert.equal(bindings[1].tlsPolicyDigest, bindings[2].tlsPolicyDigest);
      for (const binding of bindings) {
        assert.equal(binding.certificateDigest, bindings[0].certificateDigest);
        assert.match(binding.tlsPolicyDigest, /^sha256:[0-9a-f]{64}$/u);
        assert.ok(!JSON.stringify(binding).includes("CERTIFICATE"));
      }
    } finally {await server.close();}
  });

  test("snapshots constructor-owned trust bytes", async () => {
    const server = await startLoopbackTlsServer();
    try {
      const mutableCa = Buffer.from(SYNTHETIC_LOOPBACK_CA);
      const fixedTransport = transport(mutableCa);
      mutableCa.fill(0);
      const attempt = fixedTransport.beginOpen(target(server.port));
      await attempt.ready();
      await expectClosed(attempt);
    } finally {await server.close();}
  });

  test("uses intrinsic trust lengths and copies despite hostile own byteLength and length properties", async () => {
    const server = await startLoopbackTlsServer();
    try {
      const mutableCa = Buffer.from(SYNTHETIC_LOOPBACK_CA);
      const mutableCaAlias = new Uint8Array(mutableCa.buffer, mutableCa.byteOffset, mutableCa.byteLength);
      let hostileLengthRead = false;
      Object.defineProperties(mutableCa, {
        byteLength: { get: () => {hostileLengthRead = true; throw new Error("hostile byteLength");} },
        length: { get: () => {hostileLengthRead = true; throw new Error("hostile length");} },
      });
      const fixedTransport = transport(mutableCa);
      mutableCaAlias.fill(0);
      assert.equal(hostileLengthRead, false);
      const attempt = fixedTransport.beginOpen(target(server.port));
      await attempt.ready();
      await expectClosed(attempt);
    } finally {await server.close();}
  });

  test("enforces the exact aggregate one MiB trust bound and canonicalizes adversarial traversal", () => {
    const paddedCa = SYNTHETIC_LOOPBACK_CA.padEnd(1_048_576, " ");
    assert.doesNotThrow(() => {transport(paddedCa);});
    assert.throws(
      () => new NodeTlsHttpEgressTransport({certificateAuthorities: [paddedCa, SYNTHETIC_LOOPBACK_CA]}),
      (error: unknown) => error instanceof NodeTlsHttpEgressError && error.code === "invalid_configuration",
    );

    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(Buffer, "byteLength");
    if (byteLengthDescriptor?.value === undefined) {throw new Error("Buffer.byteLength descriptor unavailable");}
    let oversizedMeasurements = 0;
    Object.defineProperty(Buffer, "byteLength", {
      ...byteLengthDescriptor,
      value: (...args: Parameters<typeof Buffer.byteLength>) => {
        oversizedMeasurements += 1;
        return Reflect.apply(byteLengthDescriptor.value as typeof Buffer.byteLength, Buffer, args);
      },
    });
    try {
      assert.throws(
        () => transport("x".repeat(1_048_577)),
        (error: unknown) => error instanceof NodeTlsHttpEgressError && error.code === "invalid_configuration",
      );
    } finally {Object.defineProperty(Buffer, "byteLength", byteLengthDescriptor);}
    assert.equal(oversizedMeasurements, 0);

    const hostileAuthorities = [SYNTHETIC_LOOPBACK_CA];
    Object.defineProperty(hostileAuthorities, "0", {get: () => {throw new Error("hostile authority getter");}});
    assert.throws(
      () => new NodeTlsHttpEgressTransport({certificateAuthorities: hostileAuthorities}),
      (error: unknown) => error instanceof NodeTlsHttpEgressError && error.code === "invalid_configuration",
    );

    let hostileLengthRead = false;
    const hostileArrayLike = Object.defineProperties({}, {
      byteLength: {get: () => {hostileLengthRead = true; throw new Error("hostile byteLength");}},
      length: {get: () => {hostileLengthRead = true; throw new Error("hostile length");}},
    });
    assert.throws(
      () => new NodeTlsHttpEgressTransport({certificateAuthorities: [hostileArrayLike as Uint8Array]}),
      (error: unknown) => error instanceof NodeTlsHttpEgressError && error.code === "invalid_configuration",
    );
    assert.equal(hostileLengthRead, false);
  });

  for (const scenario of [
    { name: "wrong CA chain", ca: SYNTHETIC_OTHER_CA, server: {} },
    { name: "wrong hostname SAN", ca: SYNTHETIC_LOOPBACK_CA,
      server: { key: SYNTHETIC_WRONG_SAN_SERVER_KEY, cert: SYNTHETIC_WRONG_SAN_SERVER_CERTIFICATE } },
    { name: "missing HTTP/1.1 ALPN", ca: SYNTHETIC_LOOPBACK_CA, server: { alpn: ["h2"] } },
    { name: "protocol below TLS 1.2", ca: SYNTHETIC_LOOPBACK_CA,
      server: { minVersion: "TLSv1.1" as const, maxVersion: "TLSv1.1" as const } },
  ]) {
    test(`rejects ${scenario.name} and closes its sole socket`, async () => {
      const server = await startLoopbackTlsServer(scenario.server);
      try {
        const attempt = transport(scenario.ca).beginOpen(target(server.port));
        await assert.rejects(attempt.ready(), NodeTlsHttpEgressError);
        await expectClosed(attempt);
        assert.ok(server.connections() <= 1);
      } finally {await server.close();}
    });
  }

  test("preserves response backpressure without accumulating an adapter-side response", async () => {
    const server = await startLoopbackTlsServer({ floodBytes: 8 * 1_024 * 1_024 });
    try {
      const attempt = transport().beginOpen(target(server.port));
      const session = await attempt.ready();
      const dispatch = await session.dispatch(() => utf8("GET / HTTP/1.1\r\nHost: provider.test\r\n\r\n"));
      assert.equal(dispatch.status, "response");
      await new Promise(resolve => {setTimeout(resolve, 25);});
      assert.equal(server.backpressured(), true);
      if (dispatch.status === "response") {assert.equal((await collect(dispatch.response)).byteLength, 8 * 1_024 * 1_024);}
      await expectClosed(attempt);
    } finally {await server.close();}
  });

  test("maps a kernel reset after authority consumption to unknown bytes and acknowledgement loss", async () => {
    const server = await startLoopbackTlsServer({ resetOnData: true });
    try {
      const attempt = transport().beginOpen(target(server.port));
      const session = await attempt.ready();
      const dispatch = await session.dispatch(() => utf8("request bytes"));
      assert.deepEqual(dispatch, { status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" });
      await expectClosed(attempt);
      assert.equal(server.connections(), 1);
    } finally {await server.close();}
  });

  test("times out a response only after consumption and remains conservative", async () => {
    const server = await startLoopbackTlsServer({ stallOnData: true });
    try {
      const attempt = transport(SYNTHETIC_LOOPBACK_CA, { responseIdleTimeoutMs: 30 }).beginOpen(target(server.port));
      const session = await attempt.ready();
      const dispatch = await session.dispatch(() => utf8("request bytes"));
      assert.deepEqual(dispatch, { status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" });
      await expectClosed(attempt);
    } finally {await server.close();}
  });

  test("disables TLS 1.2 renegotiation so an attempted renegotiation is an error, not a new handshake", async () => {
    const server = await startLoopbackTlsServer({
      minVersion: "TLSv1.2", maxVersion: "TLSv1.2", renegotiateOnData: true,
    });
    try {
      const attempt = transport(SYNTHETIC_LOOPBACK_CA, { responseIdleTimeoutMs: 250 }).beginOpen(target(server.port));
      const session = await attempt.ready();
      assert.equal(session.binding.tlsProtocol, "TLSv1.2");
      const dispatch = await session.dispatch(() => utf8("request bytes"));
      assert.deepEqual(dispatch, { status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" });
      await expectClosed(attempt);
    } finally {await server.close();}
  });
});

describe("NodeTlsHttpEgressTransport validation, closure and dispatch races", () => {
  for (const [name, overrides] of [
    ["DNS selected address", { selectedAddress: "localhost" }],
    ["scoped IPv6 selected address", { selectedAddress: "fe80::1%lo" }],
    ["zero port", { originPort: 0 }],
    ["literal SNI", { sni: "127.0.0.1", originHost: "127.0.0.1" }],
  ] as const) {
    test(`rejects ${name} before creating a socket`, () => {
      let connections = 0;
      const candidate = new NodeTlsHttpEgressTransport(
        { certificateAuthorities: [SYNTHETIC_LOOPBACK_CA] },
        () => {connections += 1; return new SyntheticOwnedTlsSocket();},
      );
      assert.throws(() => candidate.beginOpen(target(443, overrides)), NodeTlsHttpEgressError);
      assert.equal(connections, 0);
    });
  }

  test("canonicalizes equivalent IPv6 spellings while keeping IPv4 and IPv6 distinct", () => {
    assert.deepEqual(canonicalLiteralAddress("0:0:0:0:0:0:0:1"), { address: "::1", family: 6 });
    assert.deepEqual(canonicalLiteralAddress("127.0.0.1"), { address: "127.0.0.1", family: 4 });
    assert.notDeepEqual(canonicalLiteralAddress("::ffff:127.0.0.1"), canonicalLiteralAddress("127.0.0.1"));
  });

  test("close before a stalled handshake owns the connecting socket and ready cannot become usable", async () => {
    const server = await startStalledTcpServer();
    try {
      const attempt = transport().beginOpen(target(server.port));
      const ready = attempt.ready();
      await expectClosed(attempt);
      await assert.rejects(ready, NodeTlsHttpEgressError);
      assert.ok(server.accepted() <= 1);
    } finally {await server.close();}
  });

  test("a stalled handshake times out and closure is actual", async () => {
    const server = await startStalledTcpServer();
    try {
      const attempt = transport(SYNTHETIC_LOOPBACK_CA, { connectTimeoutMs: 25 }).beginOpen(target(server.port));
      await assert.rejects(attempt.ready(), (error: unknown) =>
        error instanceof NodeTlsHttpEgressError && (error.code === "connect_timeout" || error.code === "connect_failed"));
      await expectClosed(attempt);
      assert.equal(server.accepted(), 1);
    } finally {await server.close();}
  });

  test("undefined authorization denies without bytes and a second dispatch never consumes", async () => {
    const server = await startLoopbackTlsServer({ stallOnData: true });
    try {
      const attempt = transport().beginOpen(target(server.port));
      const session = await attempt.ready();
      let calls = 0;
      assert.deepEqual(await session.dispatch(() => {calls += 1;}),
        { status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged" });
      assert.deepEqual(await session.dispatch(() => {calls += 1; return utf8("forbidden");}),
        { status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged" });
      assert.equal(calls, 1);
      assert.equal(server.received().byteLength, 0);
      await expectClosed(attempt);
    } finally {await server.close();}
  });

  test("abort before dispatch denies without invoking the consumer", async () => {
    const server = await startLoopbackTlsServer();
    try {
      const attempt = transport().beginOpen(target(server.port));
      const session = await attempt.ready();
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      assert.deepEqual(await session.dispatch(() => {calls += 1; return utf8("forbidden");}, controller.signal),
        { status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged" });
      assert.equal(calls, 0);
      await expectClosed(attempt);
    } finally {await server.close();}
  });

  test("close after readiness makes dispatch unavailable and creates no replacement connection", async () => {
    const server = await startLoopbackTlsServer();
    try {
      const attempt = transport().beginOpen(target(server.port));
      const session = await attempt.ready();
      await expectClosed(attempt);
      let called = false;
      assert.deepEqual(await session.dispatch(() => {called = true; return utf8("forbidden");}),
        { status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged" });
      assert.equal(called, false);
      await new Promise(resolve => {setTimeout(resolve, 5);});
      assert.equal(server.connections(), 1);
    } finally {await server.close();}
  });
});

describe("NodeTlsHttpEgressTransport deterministic synthetic fault injection", () => {
  test("response abort listeners exist only during pending socket reads", async () => {
    for (const finish of ["close", "abort-pending", "abort-suspended"] as const) {
      const socket = new SyntheticOwnedTlsSocket();
      const stream = new Readable({ read() {} });
      socket.iterator = (options?: Readonly<{ destroyOnReturn?: boolean }>) => {
        assert.deepEqual(options, { destroyOnReturn: false });
        return stream.iterator(options);
      };
      const destroy = socket.destroy.bind(socket);
      socket.destroy = error => {stream.destroy(error); return destroy(error);};
      const attempt = injectedTransport(socket).beginOpen(target(443));
      try {
        const session = await attempt.ready();
        const controller = new AbortController();
        const listeners = () => getEventListeners(controller.signal, "abort").length;
        const dispatch = await session.dispatch(() => utf8("request"), controller.signal);
        assert.equal(dispatch.status, "response");
        if (dispatch.status !== "response") {throw new Error("unreachable");}
        const response = dispatch.response[Symbol.asyncIterator]();
        assert.equal(listeners(), 0);
        for (const part of ["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n", "ok"]) {
          const pending = response.next();
          assert.equal(listeners(), 1);
          stream.push(utf8(part));
          assert.deepEqual(await pending, { done: false, value: Buffer.from(part) });
          assert.equal(listeners(), 0, "cleanup must precede yield, without EOF or iterator return");
          assert.equal(socket.destroyed, false);
          assert.equal(stream.destroyed, false);
        }
        if (finish !== "close") {
          if (finish === "abort-suspended") {
            controller.abort();
            assert.equal(socket.destroyed, false);
          }
          const pending = response.next();
          if (finish === "abort-pending") {
            assert.equal(listeners(), 1);
            controller.abort();
          }
          await assert.rejects(pending, (error: unknown) =>
            error instanceof NodeTlsHttpEgressError && error.code === "connect_failed");
          assert.equal(listeners(), 0);
          assert.equal(socket.destroyed, true);
        }
        await expectClosed(attempt);
        assert.equal(socket.destroyed, true);
        assert.equal(stream.destroyed, true);
        assert.equal(listeners(), 0);
      } finally {await attempt.close();}
    }
  });

  test("consume and socket.write occur in the same synchronous stack in that exact order", async () => {
    const socket = new SyntheticOwnedTlsSocket();
    const order: string[] = [];
    const originalWrite = socket.write.bind(socket);
    socket.write = (bytes, callback) => {order.push("write"); return originalWrite(bytes, callback);};
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const session = await attempt.ready();
    let consumerReturned = false;
    const dispatchPromise = session.dispatch(() => {
      order.push("consume");
      consumerReturned = true;
      return utf8("owned bytes");
    });
    assert.equal(consumerReturned, true);
    assert.deepEqual(order, ["consume", "write"]);
    assert.equal((await dispatchPromise).status, "response");
    assert.equal(socket.renegotiationDisabled, true);
    await expectClosed(attempt);
  });

  for (const write of ["throw", "callback-error"] as const) {
    test(`a synthetic ${write} after consumption can never claim zero accepted bytes`, async () => {
      const socket = new SyntheticOwnedTlsSocket({ write });
      const attempt = injectedTransport(socket).beginOpen(target(443));
      const session = await attempt.ready();
      const bytes = utf8("owned bytes");
      assert.deepEqual(await session.dispatch(() => bytes),
        { status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" });
      assert.equal(new TextDecoder().decode(bytes), "owned bytes");
      bytes.fill(0);
      await expectClosed(attempt);
    });
  }

  test("early readability waits for write completion before acknowledging the response", async () => {
    const socket = new SyntheticOwnedTlsSocket({ write: "wait" });
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const session = await attempt.ready();
    const bytes = utf8("secret");
    const dispatchPromise = session.dispatch(() => bytes);
    socket.exposeReadable();
    const state = await Promise.race([
      dispatchPromise.then(() => "settled" as const),
      new Promise<"pending">(resolve => {setImmediate(() => {resolve("pending");});}),
    ]);
    assert.equal(state, "pending");
    assert.equal(new TextDecoder().decode(bytes), "secret", "the socket still borrows the request before its callback");

    socket.completePendingWrite();
    const dispatch = await dispatchPromise;
    assert.equal(dispatch.status, "response");
    assert.equal(dispatch.acceptedRequestBytes, 6);
    assert.equal(new TextDecoder().decode(bytes), "secret");
    bytes.fill(0);
    await expectClosed(attempt);
  });

  test("early readability followed by a write callback error is unknown and lost", async () => {
    const socket = new SyntheticOwnedTlsSocket({ write: "wait" });
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const session = await attempt.ready();
    const bytes = utf8("secret");
    const dispatchPromise = session.dispatch(() => bytes);
    socket.exposeReadable();
    socket.completePendingWrite(new Error("synthetic delayed failure"));

    assert.deepEqual(await dispatchPromise,
      { status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" });
    assert.equal(new TextDecoder().decode(bytes), "secret");
    bytes.fill(0);
    await expectClosed(attempt);
  });

  test("early readability and a successful callback cannot escape when write then throws", async () => {
    const socket = new SyntheticOwnedTlsSocket({ write: "callback-then-throw" });
    socket.readableLength = 1;
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const session = await attempt.ready();
    const bytes = utf8("secret");

    assert.deepEqual(await session.dispatch(() => bytes),
      { status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" });
    assert.equal(new TextDecoder().decode(bytes), "secret");
    bytes.fill(0);
    await expectClosed(attempt);
  });

  for (const disposition of ["abort", "error", "timeout", "socket-close", "attempt-close"] as const) {
    test(`${disposition} while the write callback is pending cannot resurrect success`, async () => {
      const socket = new SyntheticOwnedTlsSocket({ write: "wait", completeWriteOnDestroy: true });
      const attempt = injectedTransport(socket).beginOpen(target(443));
      const session = await attempt.ready();
      const bytes = utf8("secret");
      const controller = new AbortController();
      const dispatchPromise = session.dispatch(() => bytes, controller.signal);
      socket.exposeReadable();
      const closePromise = disposition === "attempt-close" ? attempt.close() : undefined;
      if (disposition === "abort") {controller.abort();}
      if (disposition === "error") {socket.emit("error", new Error("synthetic failure"));}
      if (disposition === "timeout") {socket.emit("timeout");}
      if (disposition === "socket-close") {socket.closed = true; socket.emit("close");}

      assert.deepEqual(await dispatchPromise,
        { status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost" });
      if (closePromise !== undefined) {assert.equal((await closePromise).state, "closed");}
      await new Promise<void>(resolve => {setImmediate(resolve);});
      assert.equal(new TextDecoder().decode(bytes), "secret", "the boundary retains zeroization ownership");
      bytes.fill(0);
      await expectClosed(attempt);
    });
  }

  test("intrinsic length ignores own byteLength and transport leaves cleanup to custody", async () => {
    const socket = new SyntheticOwnedTlsSocket();
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const session = await attempt.ready();
    const bytes = utf8("secret");
    Object.defineProperties(bytes, {
      byteLength: { value: 999 },
      fill: { value: () => bytes },
    });

    const dispatch = await session.dispatch(() => bytes);
    assert.equal(dispatch.status, "response");
    assert.equal(dispatch.acceptedRequestBytes, 6);
    assert.deepEqual(socket.writes, [utf8("secret")]);
    assert.deepEqual([...bytes], [...utf8("secret")]);
    Uint8Array.prototype.fill.call(bytes, 0);
    await expectClosed(attempt);
  });

  test("invalid and detached authorized values never write or rely on instance cleanup hooks", async () => {
    const invalidSocket = new SyntheticOwnedTlsSocket();
    const invalidAttempt = injectedTransport(invalidSocket).beginOpen(target(443));
    const invalidSession = await invalidAttempt.ready();
    let hostileFillCalled = false;
    const invalid = { byteLength: 12, fill: () => {hostileFillCalled = true;} };
    assert.deepEqual(await invalidSession.dispatch(() => invalid as unknown as Uint8Array),
      { status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged" });
    assert.equal(hostileFillCalled, false);
    assert.equal(invalidSocket.writes.length, 0);
    await expectClosed(invalidAttempt);

    const detachedSocket = new SyntheticOwnedTlsSocket();
    const detachedAttempt = injectedTransport(detachedSocket).beginOpen(target(443));
    const detachedSession = await detachedAttempt.ready();
    const detached = new Uint8Array(6);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    assert.deepEqual(await detachedSession.dispatch(() => detached),
      { status: "failed", acceptedRequestBytes: 0, acknowledgement: "acknowledged" });
    assert.equal(detachedSocket.writes.length, 0);
    await expectClosed(detachedAttempt);
  });

  test("rejects a supplied-peer versus actual-peer mismatch", async () => {
    const socket = new SyntheticOwnedTlsSocket({ remoteAddress: "127.0.0.2", remotePort: 443 });
    const attempt = injectedTransport(socket).beginOpen(target(443));
    await assert.rejects(attempt.ready(), (error: unknown) =>
      error instanceof NodeTlsHttpEgressError && error.code === "peer_mismatch");
    await expectClosed(attempt);
  });

  test("close wins over a late secure-connect event and no session escapes", async () => {
    const socket = new SyntheticOwnedTlsSocket();
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const ready = attempt.ready();
    const closure = attempt.close();
    assert.equal((await closure).state, "closed");
    await assert.rejects(ready, NodeTlsHttpEgressError);
    assert.equal(socket.writes.length, 0);
  });

  test("reports unknown when a synthetic kernel adapter cannot prove actual closure", async () => {
    const socket = new SyntheticOwnedTlsSocket({ closeOnDestroy: false });
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const closure = await attempt.close();
    assert.equal(closure.state, "unknown");
    assert.match(closure.receiptDigest, /^[a-f0-9]{64}$/u);
    assert.equal(attempt.close(), attempt.close());
  });

  test("canonical errors and closure evidence do not leak peer, raw path, socket error or request bytes", async () => {
    const socket = new SyntheticOwnedTlsSocket({ write: "throw" });
    const attempt = injectedTransport(socket).beginOpen(target(443));
    const session = await attempt.ready();
    const dispatch = await session.dispatch(() => utf8("GET /private-path secret-marker"));
    const closure = await attempt.close();
    const evidence = JSON.stringify({ dispatch, closure });
    assert.doesNotMatch(evidence, /private-path|secret-marker|127\.0\.0\.1|synthetic write/u);
  });
});
