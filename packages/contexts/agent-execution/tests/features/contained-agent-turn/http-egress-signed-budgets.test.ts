import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpEgressBrokerPorts, HttpEgressClock } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import type { HttpEgressReceipt } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-contracts.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { dispatchGrantIsCurrent } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-runtime-security-v2.js";
import { bytes, createEgressFixture, SECRET_MARKER, type FixtureOptions } from "./http-egress-test-fixture.ts";

const requestWire = `POST /fixed-provider-route HTTP/1.1\r\ncontent-type: application/json\r\nHost: provider.example\r\nauthorization: Bearer ${SECRET_MARKER}\r\nContent-Length: 2\r\n\r\n{}`;
const fixedHead = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n";

// Synthetic signed-owner decisions use the existing verifier stub. No signing key,
// provider, socket, filesystem fixture, or real clock participates in these races.
const signedFixture = (options: Readonly<{
  requestBytes?: number; responseBytes?: number; totalMilliseconds?: number;
  authorizedAt?: number; initialTime?: number; expiresAt?: number;
  fixture?: FixtureOptions;
  beforeDispatch?: (setTime: (time: number) => void) => void;
  inJournal?: (setTime: (time: number) => void) => "consumed" | "unknown";
}> = {}) => {
  let now = options.initialTime ?? 20;
  const setTime = (value: number): void => { now = value; };
  const authorizedAt = options.authorizedAt ?? 10;
  const expiresAt = options.expiresAt ?? 900;
  const fixture = createEgressFixture({ ...options.fixture,
    mutateProvisional: value => ({ ...value,
      policy: { ...value.policy, limits: {
        requestBytes: options.requestBytes ?? 1_000_000,
        responseBytes: options.responseBytes ?? 1_000_000,
        totalMilliseconds: options.totalMilliseconds ?? 500,
      } }, time: { ...value.time, controlTime: authorizedAt - 1, expiresAtControlTime: expiresAt },
    }),
    mutateGrant: value => ({ ...value, payload: { ...value.payload,
      time: { ...value.payload.time, authorizedAtControlTime: authorizedAt, expiresAtControlTime: expiresAt },
    } }),
  });
  let journalCalls = 0;
  const deadlines: number[] = [];
  const clock: HttpEgressClock = {
    now: () => now,
    within: async <T>(deadline: number, action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
      deadlines.push(deadline);
      signal?.throwIfAborted();
      if (now >= deadline) { throw new Error("synthetic deadline before action"); }
      const result = await action();
      signal?.throwIfAborted();
      if (now >= deadline) { throw new Error("synthetic deadline after action"); }
      return result;
    },
  };
  const ports: HttpEgressBrokerPorts = { ...fixture.ports, clock,
    localAuthorityCut: { read: () => ({ status: "current", authorityId: "clock-authority",
      epoch: "epoch-1", controlTime: now }) },
    journal: { consume: () => {
      journalCalls += 1; fixture.observations.order.push("journal");
      return options.inJournal?.(setTime) ?? "consumed";
    } },
    transport: { beginOpen: input => {
      const attempt = fixture.ports.transport.beginOpen(input);
      return { ...attempt, ready: async () => {
        const session = await attempt.ready();
        return { ...session, dispatch: (consume, signal) => {
          options.beforeDispatch?.(setTime);
          return session.dispatch(consume, signal);
        } };
      } };
    } },
  };
  return { ...fixture, ports, setTime, deadlines, get journalCalls() { return journalCalls; } };
};

const assertClosedWithoutBytes = (fixture: ReturnType<typeof signedFixture>, receipt: HttpEgressReceipt): void => {
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(receipt.upstreamRequestBytes, 0);
  assert.equal(receipt.upstreamResponseBytes, 0);
  assert.equal(receipt.outboundResponseBytes, 0);
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(receipt.attemptCount, 1);
  assert.equal(fixture.observations.dispatches, 0);
  assert.equal(fixture.observations.closes, 1);
  assert.equal(fixture.ports.guard.snapshot().state, "closed");
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(fixture.observations.receipts, [receipt]);
  assert.equal(JSON.stringify(receipt).includes(SECRET_MARKER), false);
};

test("cancellation after a valid final grant is recorded before journal consumption or dispatch", async () => {
  const abort = new AbortController();
  const fixture = createEgressFixture({ signal: abort.signal });
  let journalCalls = 0;
  const ports = { ...fixture.ports,
    runtimeSecurity: { ...fixture.ports.runtimeSecurity, authorizeFirstApplicationByte: async input => {
      const result = await fixture.ports.runtimeSecurity.authorizeFirstApplicationByte(input);
      assert.equal(result.status, "authorized");
      abort.abort();
      return result;
    } },
    journal: { consume: (...args) => { journalCalls += 1; return fixture.ports.journal.consume(...args); } },
  } satisfies HttpEgressBrokerPorts;
  const broker = createStrictHttpEgressBroker(ports);
  const receipt = await broker.execute(fixture.operation);
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(receipt.anomalyCode, "inbound_cancelled");
  assert.equal(receipt.finalAuthorizationReceiptDigest, "final-receipt-digest");
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(receipt.upstreamRequestBytes, 0);
  assert.equal(receipt.upstreamResponseBytes, 0);
  assert.equal(receipt.outboundResponseBytes, 0);
  assert.equal(journalCalls, 0);
  assert.equal(fixture.observations.order.includes("dispatch"), false);
  assert.deepEqual(fixture.observations.dispatchedRequests, []);
  assert.deepEqual(fixture.observations.outboundWrites, []);
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(fixture.observations.closes, 1);
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(fixture.observations.receipts, [receipt]);
  assert.equal(JSON.stringify(receipt).includes(SECRET_MARKER), false);
  assert.equal(fixture.ports.guard.snapshot().state, "closed");
  await broker.execute(fixture.operation);
  assert.equal(fixture.observations.opens, 1);
  assert.equal(journalCalls, 0);
});

for (const requestBytes of [1, 2, bytes(requestWire).byteLength - bytes(`authorization: Bearer ${SECRET_MARKER}\r\n`).byteLength,
  bytes(requestWire).byteLength - 1]) {
  test(`signed wire budget ${requestBytes} rejects the entire request before journal or emission`, async () => {
    const fixture = signedFixture({ requestBytes });
    const broker = createStrictHttpEgressBroker(fixture.ports);
    const receipt = await broker.execute(fixture.operation);
    assertClosedWithoutBytes(fixture, receipt);
    assert.equal(receipt.anomalyCode, "final_denied");
    assert.equal(fixture.journalCalls, 0);
    await broker.execute(fixture.operation);
    assert.equal(fixture.observations.opens, 1, "denial permanently seals this session");
    assert.equal(fixture.observations.renders, 1);
  });
}

test("the exact signed wire boundary includes headers, credentials, body, and framing", async () => {
  const fixture = signedFixture({ requestBytes: bytes(requestWire).byteLength });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.deepEqual(fixture.observations.dispatchedRequests, [bytes(requestWire)]);
  assert.equal(receipt.upstreamRequestBytes, bytes(requestWire).byteLength);
  assert.equal(fixture.journalCalls, 1);
  assert.equal(fixture.ports.guard.snapshot().state, "available");
});

for (const phase of ["before dispatch", "inside journal"] as const) {
  test(`signed deadline already spent ${phase} emits zero bytes`, async () => {
    const fixture = signedFixture({ totalMilliseconds: 11,
      ...(phase === "before dispatch" ? { beforeDispatch: set => set(21) }
        : { inJournal: set => { set(21); return "consumed"; } }),
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assertClosedWithoutBytes(fixture, receipt);
    assert.equal(fixture.journalCalls, phase === "before dispatch" ? 0 : 1);
  });
}

test("a one millisecond signed duration cannot be restarted at dispatch", async () => {
  const fixture = signedFixture({ totalMilliseconds: 1 });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assertClosedWithoutBytes(fixture, receipt);
  assert.equal(fixture.journalCalls, 0);
});

for (const [initialTime, authorizedAt, totalMilliseconds] of [
  [Number.MAX_SAFE_INTEGER - 5, Number.MAX_SAFE_INTEGER - 10, 20],
  [20, 10, Number.MAX_SAFE_INTEGER],
  [20, 10, 0], [20, 10, -1],
] as const) {
  test(`invalid or overflowing signed duration ${authorizedAt} + ${totalMilliseconds} cannot dispatch`, async () => {
    const fixture = signedFixture({ initialTime, authorizedAt, totalMilliseconds, expiresAt: Number.MAX_SAFE_INTEGER });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
      limits: { ...fixture.operation.limits, deadline: Number.MAX_SAFE_INTEGER, closureDeadline: Number.MAX_SAFE_INTEGER },
    });
    assertClosedWithoutBytes(fixture, receipt);
    assert.equal(fixture.journalCalls, 0);
  });
}

test("representable signed duration at the safe integer boundary remains usable", async () => {
  const fixture = signedFixture({ initialTime: Number.MAX_SAFE_INTEGER - 5,
    authorizedAt: Number.MAX_SAFE_INTEGER - 10, totalMilliseconds: 10, expiresAt: Number.MAX_SAFE_INTEGER });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
    limits: { ...fixture.operation.limits, deadline: Number.MAX_SAFE_INTEGER, closureDeadline: Number.MAX_SAFE_INTEGER },
  });
  assert.equal(receipt.outcome, "completed");
});

for (const target of [9, 19]) {
  for (const phase of ["before dispatch", "inside journal"] as const) {
    test(`regression to ${target} ${phase} rejects even a matching authority clock cut`, async () => {
      const fixture = signedFixture(phase === "before dispatch" ? { beforeDispatch: set => set(target) }
        : { inJournal: set => { set(target); return "consumed"; } });
      const broker = createStrictHttpEgressBroker(fixture.ports);
      const receipt = await broker.execute(fixture.operation);
      assertClosedWithoutBytes(fixture, receipt);
      assert.equal(receipt.anomalyCode, "provider_generation_drift");
      assert.equal(fixture.journalCalls, phase === "before dispatch" ? 0 : 1);
      fixture.setTime(30);
      await broker.execute(fixture.operation);
      assert.equal(fixture.observations.opens, 1, "clock recovery cannot reopen sealed admission");
    });
  }
}

test("journal regression is measured against the latest pre-journal observation", async () => {
  const fixture = signedFixture({ beforeDispatch: set => set(25), inJournal: set => { set(24); return "consumed"; } });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assertClosedWithoutBytes(fixture, receipt);
  assert.equal(fixture.journalCalls, 1);
});

test("a forward clock change inside the journal remains synchronous with emission", async () => {
  let microtaskRan = false;
  const fixture = signedFixture({ inJournal: set => {
    set(21);
    queueMicrotask(() => { microtaskRan = true;
      assert.equal(fixture.observations.dispatches, 1, "no asynchronous gap after consumption"); });
    return "consumed";
  } });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal(microtaskRan, true);
});

test("unknown journal consumption closes admission permanently without emitting", async () => {
  const fixture = signedFixture({ inJournal: () => "unknown" });
  const broker = createStrictHttpEgressBroker(fixture.ports);
  const receipt = await broker.execute(fixture.operation);
  assertClosedWithoutBytes(fixture, receipt);
  await broker.execute(fixture.operation);
  assert.equal(fixture.journalCalls, 1);
  assert.equal(fixture.observations.opens, 1);
});

test("the dispatch grant predicate rejects time before signed authorization", async () => {
  let checked = false;
  const fixture = createEgressFixture({ mutateGrant: grant => {
    const future = { ...grant, payload: { ...grant.payload,
      time: { ...grant.payload.time, authorizedAtControlTime: 1 } } };
    checked = true;
    assert.equal(dispatchGrantIsCurrent(fixture.ports, future), false);
    return grant;
  } });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(checked, true);
  assert.equal(receipt.outcome, "completed");
});

for (const framing of ["fixed", "chunked"] as const) {
  test(`short signed deadline bounds a ${framing} stream despite a longer caller deadline`, async () => {
    const head = framing === "fixed" ? fixedHead : "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
    async function* response(): AsyncIterable<Uint8Array> {
      yield bytes(head);
      fixture.setTime(21);
      yield bytes(framing === "fixed" ? "ok" : "2\r\nok\r\n0\r\n\r\n");
    }
    const fixture = signedFixture({ totalMilliseconds: 11, fixture: { responseSource: response() } });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "upstream_stalled");
    assert.equal(receipt.firstByteState, "sent");
    assert.equal(fixture.observations.outboundWrites.length, 1, "only the timely response head was delivered");
    assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(receipt.inboundClosure, "closed");
    assert.equal(fixture.ports.guard.snapshot().state, "closed");
    assert.equal(fixture.observations.dispatches, 1);
    assert.ok(fixture.deadlines.includes(21));
  });
}

for (const deadline of [25, 1_000]) {
  test(`dispatch, reads, and output writes use min(signed duration, caller deadline ${deadline})`, async () => {
    const fixture = signedFixture({ totalMilliseconds: 20 });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
      limits: { ...fixture.operation.limits, deadline },
    });
    assert.equal(receipt.outcome, "completed");
    const effective = Math.min(30, deadline);
    assert.ok(fixture.deadlines.filter(value => value === effective).length >= 4);
    assert.ok(fixture.deadlines.includes(1_100), "closure keeps its independent acknowledgement budget");
  });
}

test("stream duration is anchored to signed authorization, not provisional time or receipt time", async () => {
  async function* response(): AsyncIterable<Uint8Array> {
    yield bytes(fixedHead);
    fixture.setTime(29); // grant at 10 plus 20; provisional at 9 is only decision freshness
    yield bytes("ok");
  }
  const fixture = signedFixture({ totalMilliseconds: 20, expiresAt: 25, fixture: { responseSource: response() } });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed", "first-byte grant expiry is not the active stream duration");
  assert.equal(fixture.observations.outboundWrites.length, 2);
});

test("time observed during final verification cannot regress before settlement", async () => {
  const fixture = signedFixture();
  const ports = { ...fixture.ports, verifier: { ...fixture.ports.verifier, verifyGrant: grant => {
    fixture.setTime(19);
    return fixture.ports.verifier.verifyGrant(grant);
  } } } satisfies HttpEgressBrokerPorts;
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assertClosedWithoutBytes(fixture, receipt);
  assert.equal(receipt.anomalyCode, "provider_generation_drift");
  assert.equal(fixture.journalCalls, 0);
});

test("signed deadline bounds a dispatch whose acknowledgement arrives late", async () => {
  const fixture = signedFixture({ totalMilliseconds: 11 });
  const ports = { ...fixture.ports, transport: { beginOpen: input => {
    const attempt = fixture.ports.transport.beginOpen(input);
    return { ...attempt, ready: async () => {
      const session = await attempt.ready();
      return { ...session, dispatch: async (consume, signal) => {
        const result = await session.dispatch(consume, signal);
        fixture.setTime(21);
        return result;
      } };
    } };
  } } } satisfies HttpEgressBrokerPorts;
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "reconcile_required");
  assert.equal(receipt.anomalyCode, "upstream_write_failed");
  assert.equal(receipt.firstByteState, "uncertain");
  assert.equal(fixture.observations.dispatches, 1);
  assert.equal(fixture.observations.outboundWrites.length, 0);
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(fixture.ports.guard.snapshot().state, "closed");
});

test("signed deadline bounds downstream backpressure without fabricating delivery", async () => {
  const fixture = signedFixture({ totalMilliseconds: 11, fixture: { response: [fixedHead + "ok"] } });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({ ...fixture.operation,
    connection: { ...fixture.operation.connection, write: async value => {
      await fixture.operation.connection.write(value);
      fixture.setTime(21);
    } },
  });
  assert.equal(receipt.outcome, "reconcile_required");
  assert.equal(receipt.anomalyCode, "output_backpressure_failed");
  assert.equal(receipt.outboundResponseWriteUncertain, true);
  assert.equal(receipt.outboundResponseBytes, 0);
  assert.equal(fixture.observations.outboundWrites.length, 1);
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(receipt.upstreamClosure, "closed");
});

test("framed completion before signed expiry retains bounded owner closure after expiry", async () => {
  const fixture = signedFixture({ totalMilliseconds: 11, fixture: { response: [fixedHead + "ok"] } });
  const ports = { ...fixture.ports, transport: { beginOpen: input => {
    const attempt = fixture.ports.transport.beginOpen(input);
    return { ...attempt, close: async () => {
      fixture.setTime(22);
      return await attempt.close();
    } };
  } } } satisfies HttpEgressBrokerPorts;
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(fixture.observations.outboundWrites.length, 2);
  assert.equal(fixture.ports.guard.snapshot().state, "available");
});

for (const failure of ["closure", "evidence"] as const) {
  test(`a tiny signed wire denial with unknown ${failure} retains uncertainty and no retry`, async () => {
    const fixture = signedFixture({ requestBytes: 1, fixture: failure === "closure"
      ? { upstreamClosure: "unknown" } : { evidence: "unknown" } });
    const broker = createStrictHttpEgressBroker(fixture.ports);
    const receipt = await broker.execute(fixture.operation);
    assert.equal(receipt.firstByteState, "not_sent");
    assert.equal(receipt.outcome, failure === "closure" ? "reconcile_required" : "denied");
    assert.equal(receipt.anomalyCode, failure === "closure" ? "closure_unproved" : "evidence_ack_lost");
    assert.equal(fixture.observations.dispatches, 0);
    assert.equal(fixture.ports.guard.snapshot().state, "closed");
    await broker.execute(fixture.operation);
    assert.equal(fixture.observations.opens, 1);
    assert.equal(fixture.journalCalls, 0);
  });
}
