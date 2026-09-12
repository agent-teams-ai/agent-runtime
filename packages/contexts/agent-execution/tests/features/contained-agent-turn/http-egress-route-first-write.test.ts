import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrictHttpEgressBroker } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import type { HttpEgressBrokerPorts } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createEgressFixture, type FixtureOptions } from "./http-egress-test-fixture.ts";

type FirstWrite = NonNullable<HttpEgressBrokerPorts["routeFirstWrite"]>;
const REQUEST = "request-egress-1";

/** Structural stand-in for an installed exclusive route lease. It installs no
 * kernel rule; it only reproduces the authority the real lease exposes: one
 * reservation per requestId, refused on repeat, and a one-shot consumption. */
const lease = (options: Readonly<{consume?: () => boolean; reserveThrows?: boolean}> = {}) => {
  const order: string[] = []; const reserved = new Set<string>(); let consumes = 0;
  const port: FirstWrite = {
    reserve(requestId: string) {
      order.push(`reserve:${requestId}`);
      if (options.reserveThrows === true || reserved.has(requestId)) {
        throw new TypeError("exact route first-write authority unavailable");
      }
      reserved.add(requestId);
      let used = false;
      return {consume: () => {
        if (used) {return false;}
        used = true; consumes += 1; order.push("route-consume");
        return options.consume === undefined || options.consume();
      }};
    },
  };
  return {port, order, get consumes() {return consumes;}};
};

const execute = async (routeFirstWrite?: FirstWrite, order?: string[], options: FixtureOptions = {}) => {
  const fixture = createEgressFixture(options);
  const journal = Object.freeze({consume: (key: never, fingerprint: never) => {
    order?.push("journal-consume"); return fixture.ports.journal.consume(key, fingerprint);}});
  const ports = Object.freeze({...fixture.ports, journal,
    ...(routeFirstWrite === undefined ? {} : {routeFirstWrite})}) as HttpEgressBrokerPorts;
  return {fixture, receipt: await createStrictHttpEgressBroker(ports).execute(fixture.operation)};
};

test("a refused route lease consumption emits no application byte at all", async () => {
  const route = lease({consume: () => false});
  const {fixture, receipt} = await execute(route.port, route.order);
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.anomalyCode, "final_denied");
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(receipt.upstreamRequestBytes, 0);
  assert.deepEqual(fixture.observations.dispatchedRequests, []);
  assert.deepEqual(fixture.observations.outboundWrites, []);
  // The durable grant consumption is spent first: a route refusal after it can
  // only reduce authority, never let a second attempt reuse the same grant.
  assert.deepEqual(route.order, [`reserve:${REQUEST}`, "journal-consume", "route-consume"]);
  assert.equal(route.consumes, 1);
});

test("the route lease is consumed exactly once on a completed attempt", async () => {
  const route = lease();
  const {fixture, receipt} = await execute(route.port, route.order);
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.firstByteState, "sent");
  assert.equal(fixture.observations.dispatchedRequests.length, 1);
  assert.equal(route.consumes, 1);
  assert.deepEqual(route.order, [`reserve:${REQUEST}`, "journal-consume", "route-consume"]);
});

test("a lease that refuses the reservation denies before the journal or the wire", async () => {
  const route = lease({reserveThrows: true});
  const {fixture, receipt} = await execute(route.port, route.order);
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.anomalyCode, "final_denied");
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(fixture.observations.dispatches, 0);
  // The opened upstream attempt is still closed and recorded, not abandoned.
  assert.equal(fixture.observations.closes, 1);
  assert.equal(fixture.observations.receipts.length, 1);
  assert.deepEqual(route.order, [`reserve:${REQUEST}`]);
  assert.equal(route.consumes, 0);
});

test("a repeated requestId is refused by the lease and never reaches the journal", async () => {
  const route = lease();
  assert.equal((await execute(route.port, route.order)).receipt.outcome, "completed");
  const replay = await execute(route.port, route.order);
  assert.equal(replay.receipt.outcome, "denied");
  assert.equal(replay.receipt.anomalyCode, "final_denied");
  assert.equal(replay.fixture.observations.dispatches, 0);
  assert.equal(route.consumes, 1);
  assert.deepEqual(route.order, [`reserve:${REQUEST}`, "journal-consume", "route-consume", `reserve:${REQUEST}`]);
});

test("no microtask separates the consumed route lease from the emitted bytes", async () => {
  const marks: string[] = [];
  const fixture = createEgressFixture();
  const routeFirstWrite: FirstWrite = {reserve: () => ({consume: () => {
    marks.push("route-consume"); queueMicrotask(() => marks.push("microtask")); return true;}})};
  // The transport observes the handoff exactly where the production attempt
  // borrows the bytes: between consumption and the socket write there is no
  // await, so a deferred microtask cannot run in between.
  const base = fixture.ports.transport;
  const transport = Object.freeze({beginOpen: (input: Parameters<typeof base.beginOpen>[0]) => {
    const attempt = base.beginOpen(input);
    return Object.freeze({close: () => attempt.close(), ready: async () => {
      const session = await attempt.ready();
      return Object.freeze({get binding() {return session.binding;},
        dispatch: (consume: () => Uint8Array | undefined, signal?: AbortSignal) => session.dispatch(() => {
          const wire = consume(); marks.push(wire === undefined ? "no-bytes" : "socket-write"); return wire;}, signal)});
    }});
  }});
  const ports = Object.freeze({...fixture.ports, transport, routeFirstWrite}) as HttpEgressBrokerPorts;
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.deepEqual(marks.slice(0, 2), ["route-consume", "socket-write"]);
  assert.ok(marks.indexOf("microtask") > marks.indexOf("socket-write"));
});

test("a session without a route owner keeps its established dispatch behavior", async () => {
  const {fixture, receipt} = await execute();
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.firstByteState, "sent");
  assert.equal(fixture.observations.dispatchedRequests.length, 1);
});
