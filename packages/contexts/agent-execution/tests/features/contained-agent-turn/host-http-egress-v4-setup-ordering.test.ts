import assert from "node:assert/strict";
import test from "node:test";
import {V4Fixture, subject} from "../../fixtures/host-http-egress-v4-fixture.ts";
import {v4Decode} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {v4Replay} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import type {HostHttpEgressV4Intent, HostHttpEgressV4Observed}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";

/** The V4 ledger is the ordering authority for post-claim resource setup: the
 * operation network is allocated first, the listener binds its gateway, the
 * container joins the existing network, the route is installed against the
 * running container, and only then may an inbound exchange open. */
const SETUP = ["network_intent", "network_allocated", "listener_intent", "listener_allocated",
  "container_attached", "route_intent", "route_installed", "inbound_intent"] as const;
type SetupKind = typeof SETUP[number];
const isIntent = (kind: SetupKind): kind is SetupKind & HostHttpEgressV4Intent => kind.endsWith("_intent");

const record = async (f: V4Fixture, kind: SetupKind): Promise<unknown> =>
  isIntent(kind) ? f.intent(kind) : f.observe(kind as HostHttpEgressV4Observed);

const run = async (order: readonly SetupKind[]): Promise<V4Fixture> => {
  const f = new V4Fixture();
  await f.open();
  for (const kind of order) {await record(f, kind);}
  return f;
};

test("the canonical post-claim setup order is the one the V4 ledger accepts", async () => {
  const f = await run(SETUP);
  assert.deepEqual(v4Decode(f.storage.journal!).map(entry => entry.event.kind), ["opened", ...SETUP]);
  const ledger = v4Replay(v4Decode(f.storage.journal!), subject);
  assert.equal(ledger.network.phase, 2);
  assert.equal(ledger.listener.phase, 2);
  assert.equal(ledger.route.phase, 2);
  assert.notEqual(ledger.container, null);
  assert.equal(ledger.exchange?.number, 1);
  assert.equal(ledger.reconcileRequired, false);
});

for (const [left, right] of SETUP.flatMap((_kind, index) =>
  SETUP.slice(index + 1).map((_other, offset) => [index, index + 1 + offset] as const))) {
  test(`swapping ${SETUP[left]} with ${SETUP[right]} is refused by the V4 ledger`, async () => {
    const order = [...SETUP];
    [order[left], order[right]] = [order[right]!, order[left]!];
    await assert.rejects(run(order));
  });
}

test("an inbound exchange cannot open before the route is installed", async () => {
  const withoutRoute = SETUP.filter(kind => !kind.startsWith("route_"));
  await assert.rejects(run(withoutRoute));
});

test("endpoint release runs listener before network", async () => {
  const forward = await run(SETUP);
  await forward.intent("sockets_close"); await forward.observe("sockets_closed");
  await forward.intent("cutoff"); await forward.observe("cutoff_observed");
  await forward.observe("container_absent");
  // The reverse of allocation: the listener is released while the network still
  // exists, never the other way round.
  await assert.rejects(forward.intent("network_release"));

  const reverse = await run(SETUP);
  await reverse.intent("sockets_close"); await reverse.observe("sockets_closed");
  await reverse.intent("cutoff"); await reverse.observe("cutoff_observed");
  await reverse.observe("container_absent");
  await reverse.intent("listener_release"); await reverse.observe("listener_absent");
  await reverse.intent("network_release"); await reverse.observe("network_absent");
  const ledger = v4Replay(v4Decode(reverse.storage.journal!), subject);
  assert.equal(ledger.listener.phase, 4);
  assert.equal(ledger.network.phase, 4);
});
