import assert from "node:assert/strict";
import { test } from "node:test";

// Observe the captured cleanup intrinsic, including buffers never dispatched.
// Restore the global before running tests; only Host byte cleanup retains it.
const intrinsicFill = Uint8Array.prototype.fill;
const decoder = new TextDecoder();
let clears: Array<{bytes: Uint8Array; before: string}> = [];
Object.defineProperty(Uint8Array.prototype, "fill", {configurable: true, writable: true,
  value: function(this: Uint8Array, value: number): Uint8Array {
    if (value === 0) {clears.push({bytes: this, before: decoder.decode(this)});}
    return Reflect.apply(intrinsicFill, this, [value]);
  }});
const {createStrictHttpEgressBroker} = await import(
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js");
const {createEgressFixture, SECRET_MARKER} = await import("./http-egress-test-fixture.ts");
Object.defineProperty(Uint8Array.prototype, "fill", {configurable: true, writable: true, value: intrinsicFill});

for (const scenario of ["success", "observe", "projection", "provisional", "final", "before-dispatch",
  "after-dispatch", "cancel-before", "cancel-after", "unknown", "close-throws", "record-throws", "clock-throws"] as const) {
  test(`prepared custody clears wire and header projection exactly once: ${scenario}`, async () => {
    clears = [];
    const abort = new AbortController();
    const fixture = createEgressFixture({signal: abort.signal,
      ...(scenario === "observe" ? {firstObserveDenied: true} : {}),
      ...(scenario === "provisional" ? {provisional: "timeout" as const} : {}),
      ...(scenario === "final" ? {final: "timeout" as const} : {}),
      ...(scenario === "after-dispatch" ? {dispatch: "throw" as const} : {}),
      ...(scenario === "cancel-after" ? {abortOnDispatch: abort} : {}),
      ...(scenario === "unknown" ? {dispatch: {status: "failed" as const, acceptedRequestBytes: "unknown" as const,
        acknowledgement: "lost" as const}} : {}),
      ...(scenario === "close-throws" ? {upstreamCloseThrows: true} : {}),
      ...(scenario === "record-throws" ? {evidence: "throw" as const} : {}),
    });
    let retainedConsume: (() => Uint8Array | undefined) | undefined;
    let retainedWire: Uint8Array | undefined;
    let journalCalls = 0;
    const ports = {...fixture.ports,
      journal: {consume: (...args: Parameters<typeof fixture.ports.journal.consume>) => {
        journalCalls += 1; return fixture.ports.journal.consume(...args);
      }},
      evidence: {...fixture.ports.evidence, digest: (parts: readonly Uint8Array[]) => {
        if (scenario === "projection" && parts.some(part => decoder.decode(part) === `Bearer ${SECRET_MARKER}`)) {
          throw new Error("synthetic credential projection failure");
        }
        return fixture.ports.evidence.digest(parts);
      }},
      runtimeSecurity: {...fixture.ports.runtimeSecurity, authorizeFirstApplicationByte: async (
        input: Parameters<typeof fixture.ports.runtimeSecurity.authorizeFirstApplicationByte>[0]) => {
        const result = await fixture.ports.runtimeSecurity.authorizeFirstApplicationByte(input);
        if (scenario === "cancel-before") {abort.abort();}
        return result;
      }},
      transport: {beginOpen: (input: Parameters<typeof fixture.ports.transport.beginOpen>[0]) => {
        const attempt = fixture.ports.transport.beginOpen(input);
        return {...attempt, ready: async () => {
          const session = await attempt.ready();
          return {...session, dispatch: async (consume: () => Uint8Array | undefined, signal?: AbortSignal) => {
            retainedConsume = consume;
            if (scenario === "before-dispatch") {throw new Error("synthetic pre-dispatch failure");}
            return session.dispatch(() => {
              retainedWire = consume();
              assert.ok(retainedWire);
              assert.equal(consume(), undefined, "second dispatch handoff must fail");
              return retainedWire;
            }, signal);
          }};
        }};
      }},
      clock: {...fixture.ports.clock, within: <T>(deadline: number, action: () => Promise<T>, signal?: AbortSignal) => {
        if (scenario === "clock-throws" && fixture.observations.order.includes("final")) {
          throw new Error("synthetic synchronous settlement clock failure");
        }
        return fixture.ports.clock.within(deadline, action, signal);
      }},
    };
    const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
    const wire = clears.find(entry => entry.before.startsWith("POST /fixed-provider-route HTTP/1.1\r\n"));
    const projection = clears.find(entry => entry.before.startsWith("\u0000\u0000\u0000")
      && entry.before.includes(SECRET_MARKER));
    for (const entry of [wire, projection]) {
      assert.ok(entry, "the serialized wire and projection must both be cleared, even before dispatch");
      assert.equal(clears.filter(clear => clear.bytes === entry.bytes).length, 1);
      assert.ok(entry.bytes.every(byte => byte === 0));
    }
    assert.equal(retainedConsume?.(), undefined, "late dispatch must fail");
    if (retainedWire) {assert.equal(retainedWire, wire.bytes);}
    assert.ok(fixture.observations.opens <= 1);
    assert.ok(fixture.observations.dispatches <= 1);
    assert.ok(journalCalls <= 1);
    assert.equal(receipt.outcome, scenario === "success" ? "completed"
      : ["after-dispatch", "cancel-after", "unknown", "close-throws", "record-throws", "clock-throws"].includes(scenario)
        ? "reconcile_required" : scenario === "cancel-before" ? "cancelled" : "denied");
    if (scenario === "success") {
      assert.equal(receipt.firstByteState, "sent");
      assert.equal(receipt.finalAuthorizationReceiptDigest, "final-receipt-digest");
      assert.equal(receipt.upstreamRequestBytes, wire.bytes.byteLength);
    }
    const serializedEvidence = JSON.stringify([fixture.observations.provisionalInputs,
      fixture.observations.finalAuthorizationInputs, fixture.observations.receipts]);
    assert.equal(serializedEvidence.includes(SECRET_MARKER), false);
    assert.equal(serializedEvidence.includes("wireBytes"), false);
    assert.equal(serializedEvidence.includes("credentialValueSpans"), false);
  });
}

for (const disposition of ["success", "throw", "callback-error", "cancel"] as const) {
  test(`Node TLS borrows prepared custody without a second zeroization owner: ${disposition}`, async () => {
    const {createPreparedHttpRequestV1} = await import(
      "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/prepared-http-request-v1.js");
    const {createHttpDispatchBoundary} = await import(
      "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-dispatch-boundary.js");
    const {NodeTlsHttpEgressTransport} = await import(
      "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-tls-http-egress-transport.js");
    const {SyntheticOwnedTlsSocket, syntheticConnector, utf8} = await import("./node-tls-http-egress-transport-test-helper.ts");
    const {SYNTHETIC_LOOPBACK_CA} = await import("../../fixtures/http-egress-tls/synthetic-loopback-certificates.ts");
    const socket = new SyntheticOwnedTlsSocket(disposition === "success" ? {}
      : {write: disposition === "cancel" ? "wait" : disposition});
    const transport = new NodeTlsHttpEgressTransport({certificateAuthorities: [SYNTHETIC_LOOPBACK_CA],
      connectTimeoutMs: 100, responseIdleTimeoutMs: 100, closeTimeoutMs: 100}, syntheticConnector(socket));
    const attempt = transport.beginOpen({originHost: "provider.test", originPort: 443,
      selectedAddress: "127.0.0.1", sni: "provider.test", alpn: "http/1.1"});
    const pending = createPreparedHttpRequestV1({methodBytes: utf8("POST"), targetBytes: utf8("/invoke"),
      hostBytes: utf8("provider.test"), presentationFields: [], credentialHeaderNameAllowlist: ["authorization"],
      credentialFields: [{name: "authorization", valueBytes: utf8("Bearer synthetic")}], bodyBytes: utf8("{}")});
    const custody = pending.consume();
    assert.ok(custody);
    assert.equal(pending.consume(), undefined);
    const boundary = createHttpDispatchBoundary(custody, () => true);
    const controller = new AbortController();
    clears = [];
    try {
      const session = await attempt.ready();
      const dispatched = session.dispatch(boundary.consume, controller.signal);
      if (disposition === "cancel") {controller.abort();}
      const result = await dispatched.finally(boundary.seal);
      assert.equal(result.status, disposition === "success" ? "response" : "failed");
      let secondConsume = false;
      assert.equal((await session.dispatch(() => {secondConsume = true; return custody.wireBytes;})).status, "failed");
      assert.equal(secondConsume, false);
      assert.equal(boundary.consume(), undefined);
    } finally {
      boundary.seal(); custody.dispose(); pending.dispose(); await attempt.close();
    }
    for (const bytes of [custody.wireBytes, custody.headerProjectionBytes]) {
      assert.ok(bytes.every(byte => byte === 0));
      assert.equal(clears.filter(clear => clear.bytes === bytes).length, 1);
    }
    assert.equal(socket.writes.length, 1);
  });
}
