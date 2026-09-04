import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HttpEgressClock,
  HttpEgressTransportSession,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes, createEgressFixture, defaultRoute } from "./http-egress-test-fixture.ts";

const deferred = <T>() => {
  return Promise.withResolvers<T>();
};

const openInput = Object.freeze({
  originHost: defaultRoute.originHost,
  originPort: defaultRoute.originPort,
  selectedAddress: "93.184.216.34",
  sni: defaultRoute.sni,
  alpn: defaultRoute.alpn,
});

const abortableClock = (base: HttpEgressClock): HttpEgressClock => Object.freeze({
  now: base.now,
  within: async <T>(_deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const pending = operation();
    if (signal === undefined) {return await pending;}
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener("abort", aborted);
        reject(new Error("synthetic abort"));
      };
      signal.addEventListener("abort", aborted, { once: true });
      pending.then(
        value => {signal.removeEventListener("abort", aborted); resolve(value); return true;},
        error => {signal.removeEventListener("abort", aborted); reject(error); return false;},
      );
    });
  },
});

test("an immediately failed owned open is closed once without retry", async () => {
  const fixture = createEgressFixture({ openThrows: true });
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.anomalyCode, "transport_open_failed");
  assert.equal(receipt.attemptCount, 1);
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(fixture.observations.opens, 1);
  assert.equal(fixture.observations.closes, 1);
  assert.equal(fixture.observations.dispatches, 0);
});

for (const drift of ["cancelled", "deadline", "invalid-clock"] as const) {
  test(`does not begin a transport when ${drift} wins after resolution`, async () => {
    const controller = new AbortController();
    const fixture = createEgressFixture({ signal: controller.signal });
    let resolved = false;
    const resolver = { resolve: async (host: string) => {
      const result = await fixture.ports.resolver.resolve(host);
      resolved = true;
      if (drift === "cancelled") {controller.abort();}
      return result;
    } };
    const clock = { ...fixture.ports.clock, now: () => {
      if (!resolved || drift === "cancelled") {return fixture.ports.clock.now();}
      return drift === "deadline" ? fixture.operation.limits.deadline : Number.NaN;
    } };
    const receipt = await createStrictHttpEgressBroker({ ...fixture.ports, resolver, clock }).execute(fixture.operation);
    assert.equal(receipt.outcome, drift === "cancelled" ? "cancelled" : "denied");
    assert.equal(receipt.attemptCount, 0);
    assert.equal(receipt.upstreamClosure, "not_opened");
    assert.equal(fixture.observations.opens, 0);
    assert.equal(fixture.observations.dispatches, 0);
  });
}

test("a timed-out open remains owned when readiness completes late", async () => {
  const readyGate = deferred<void>();
  const fixture = createEgressFixture({ openReady: readyGate.promise });
  let readyPromise: Promise<HttpEgressTransportSession> | undefined;
  const transport = { beginOpen: (input: typeof openInput) => {
    const attempt = fixture.ports.transport.beginOpen(input);
    return { ...attempt, ready: () => {
      readyPromise = attempt.ready();
      return readyPromise;
    } };
  } };
  const clock: HttpEgressClock = {
    ...fixture.ports.clock,
    within: async <T>(_deadline: number, operation: () => Promise<T>): Promise<T> => {
      const pending = operation();
      if ((pending as unknown) === readyPromise) {
        void pending.catch(() => {});
        throw new Error("synthetic deadline");
      }
      return await pending;
    },
  };
  const receipt = await createStrictHttpEgressBroker({ ...fixture.ports, transport, clock }).execute(fixture.operation);
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(fixture.observations.opens, 1);
  assert.equal(fixture.observations.closes, 1);
  assert.equal(fixture.observations.dispatches, 0);
  readyGate.resolve();
  if (readyPromise === undefined) {throw new Error("synthetic readiness was not requested");}
  await assert.rejects(readyPromise, /closed before ready/);
  assert.equal(fixture.observations.closes, 1);
});

test("a cancelled pending open closes once and rejects late readiness", async () => {
  const controller = new AbortController();
  const readyGate = deferred<void>();
  const fixture = createEgressFixture({ openReady: readyGate.promise, signal: controller.signal });
  let readyPromise: Promise<HttpEgressTransportSession> | undefined;
  const transport = { beginOpen: (input: typeof openInput) => {
    const attempt = fixture.ports.transport.beginOpen(input);
    return { ...attempt, ready: () => {
      readyPromise = attempt.ready();
      return readyPromise;
    } };
  } };
  const execution = createStrictHttpEgressBroker({
    ...fixture.ports, transport, clock: abortableClock(fixture.ports.clock),
  }).execute(fixture.operation);
  while (fixture.observations.opens === 0) {await Promise.resolve();}
  controller.abort();
  const receipt = await execution;
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(receipt.anomalyCode, "inbound_cancelled");
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(fixture.observations.opens, 1);
  assert.equal(fixture.observations.closes, 1);
  readyGate.resolve();
  if (readyPromise === undefined) {throw new Error("synthetic readiness was not requested");}
  await assert.rejects(readyPromise, /closed before ready/);
  assert.equal(fixture.observations.dispatches, 0);
});

test("closing an attempt before readiness is idempotent and fences readiness", async () => {
  const readyGate = deferred<void>();
  const fixture = createEgressFixture({ openReady: readyGate.promise });
  const attempt = fixture.ports.transport.beginOpen(openInput);
  const readiness = attempt.ready();
  const firstClose = attempt.close();
  const secondClose = attempt.close();
  assert.equal(firstClose, secondClose);
  assert.equal((await firstClose).state, "closed");
  readyGate.resolve();
  await assert.rejects(readiness, /closed before ready/);
  assert.equal(fixture.observations.opens, 1);
  assert.equal(fixture.observations.closes, 1);
});

for (const closeFailure of ["throws", "hangs"] as const) {
  test(`unproved owned-open closure (${closeFailure}) requires reconciliation`, async () => {
    const fixture = createEgressFixture({
      openThrows: true,
      upstreamCloseThrows: closeFailure === "throws",
      upstreamCloseNever: closeFailure === "hangs",
    });
    let closePromise: Promise<Readonly<{ state: "closed" | "unknown"; receiptDigest: string }>> | undefined;
    const transport = { beginOpen: (input: typeof openInput) => {
      const attempt = fixture.ports.transport.beginOpen(input);
      return { ...attempt, close: () => {
        closePromise = attempt.close();
        return closePromise;
      } };
    } };
    const clock: HttpEgressClock = {
      ...fixture.ports.clock,
      within: async <T>(_deadline: number, operation: () => Promise<T>): Promise<T> => {
        const pending = operation();
        if (closeFailure === "hangs" && (pending as unknown) === closePromise) {
          throw new Error("synthetic closure deadline");
        }
        return await pending;
      },
    };
    const receipt = await createStrictHttpEgressBroker({ ...fixture.ports, transport, clock }).execute(fixture.operation);
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "closure_unproved");
    assert.equal(receipt.upstreamClosure, "unknown");
    assert.notEqual(receipt.upstreamClosure, "not_opened");
    assert.equal(fixture.observations.opens, 1);
    assert.equal(fixture.observations.closes, 1);
    assert.equal(fixture.observations.dispatches, 0);
  });
}

test("cancellation at readiness handoff closes and prevents late byte consumption", async () => {
  const controller = new AbortController();
  const fixture = createEgressFixture({ signal: controller.signal });
  let staleSession: HttpEgressTransportSession | undefined;
  const transport = { beginOpen: (input: typeof openInput) => {
    const attempt = fixture.ports.transport.beginOpen(input);
    return { ...attempt, ready: async () => {
      staleSession = await attempt.ready();
      controller.abort();
      return staleSession;
    } };
  } };
  const receipt = await createStrictHttpEgressBroker({ ...fixture.ports, transport }).execute(fixture.operation);
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(receipt.upstreamClosure, "closed");
  assert.equal(fixture.observations.opens, 1);
  assert.equal(fixture.observations.closes, 1);
  assert.equal(fixture.observations.dispatches, 0);
  let consumed = false;
  const late = await (staleSession as HttpEgressTransportSession).dispatch(() => {
    consumed = true;
    return bytes("must-not-dispatch");
  });
  assert.equal(late.status, "failed");
  assert.equal(consumed, false);
  assert.equal(fixture.observations.closes, 1);
});

test("authorization bytes completing after lifecycle timeout are zeroed", async () => {
  const renderGate = deferred<void>();
  const fixture = createEgressFixture();
  const lateAuthorization = bytes("Bearer late-secret-material");
  let renderPromise: Promise<readonly Readonly<{name: string; valueBytes: Uint8Array}>[]> | undefined;
  const materializer = { render: () => {
    renderPromise = renderGate.promise.then(() => [Object.freeze({name: "authorization", valueBytes: lateAuthorization})]);
    return renderPromise;
  } };
  const clock: HttpEgressClock = {
    ...fixture.ports.clock,
    within: async <T>(_deadline: number, operation: () => Promise<T>): Promise<T> => {
      const pending = operation();
      if ((pending as unknown) === renderPromise) {throw new Error("synthetic credential deadline");}
      return await pending;
    },
  };
  const receipt = await createStrictHttpEgressBroker({
    ...fixture.ports, materializer, clock,
  }).execute(fixture.operation);
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.anomalyCode, "credential_render_failed");
  assert.equal(receipt.upstreamClosure, "not_opened");
  renderGate.resolve();
  if (renderPromise === undefined) {throw new Error("synthetic credential render was not requested");}
  await renderPromise;
  await Promise.resolve();
  assert.ok(lateAuthorization.every(value => value === 0));
});
