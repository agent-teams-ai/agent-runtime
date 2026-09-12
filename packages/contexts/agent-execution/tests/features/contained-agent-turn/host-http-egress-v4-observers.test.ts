import assert from "node:assert/strict";
import test from "node:test";
import {MemoryV4Storage, SyntheticV4Owner, container, subject} from "../../fixtures/host-http-egress-v4-fixture.ts";
import {createDockerHostHttpEgressObservers, joinHostHttpEgressV4Observers}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/host-http-egress-v4-observers.js";
import {createDockerRemovalObservationOwner}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-removal-observation-owner.js";
import {HostHttpEgressV4Journal}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import {v4Decode, v4Hash}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {v4Replay}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import {dockerCustodyAuthoritySha256}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal-codec.js";
import type {HostHttpEgressV4Intent, HostHttpEgressV4Observed}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";

const address = Object.freeze({address: "10.203.0.1", family: "IPv4", port: 43_129});
const engineIdentity = {
  daemonIdentitySha256: subject.attempt.daemonIdentitySha256,
  daemonBootGenerationSha256: subject.attempt.daemonBootGenerationSha256,
  hostIdentitySha256: subject.attempt.hostIdentitySha256,
  hostBootGenerationSha256: subject.attempt.hostBootGenerationSha256,
};

/** Point-in-time facts of a live Node listener recipe, in its exact shape. */
const open = Object.freeze({
  scope: "retained-node-server-and-delivered-sockets", openState: "published", listenerState: "open",
  admissionSealed: false, nativeBindPending: false, closeRequested: false, serverCloseAcknowledged: false,
  sockets: Object.freeze({observed: 0, closeEvents: 0, awaitingClose: 0, droppedWithoutSocket: 0}),
  consumerPending: false, consumerWorkPending: false, uncertainty: Object.freeze([]),
});
const sealed = {...open, admissionSealed: true};
const closed = {...sealed, listenerState: "closed", closeRequested: true, serverCloseAcknowledged: true};

class Recipe {
  public state: Record<string, unknown> = {...open};
  public reads = 0;
  public observe(): unknown {this.reads += 1; return {...this.state, sockets: {...this.state.sockets as object}};}
}

const removalOwner = (present = false) => {
  const authority = {...container};
  const engine = {async inspect() {
    return {authority, engine: engineIdentity, cgroupTree: "unobserved",
      existence: present ? "present" : "absent"};
  }} as never;
  const contain = async () => ({kind: "closed" as const, journal: {state: "closed", attemptKey: subject.attempt,
    authoritySha256: dockerCustodyAuthoritySha256(authority), checksumSha256: v4Hash("synthetic-custody-journal"),
    evidence: {status: "proved"}}});
  return createDockerRemovalObservationOwner(engine, contain as never);
};

const fixture = (removal = removalOwner()) => {
  const storage = new MemoryV4Storage();
  const network = new SyntheticV4Owner();
  const observers = createDockerHostHttpEgressObservers({subject, removal});
  const journal = new HostHttpEgressV4Journal(storage, subject,
    joinHostHttpEgressV4Observers([network.observationOwner ?? network, observers.observationOwner]));
  const recipe = new Recipe();
  let serial = 0;
  const command = (): string => {serial += 1; return `command:${v4Hash([serial, storage.journal?.length])}`;};
  const intent = async (kind: HostHttpEgressV4Intent) =>
    journal.recordIntent(command(), {kind, targetSha256: journal.target(kind)});
  const observe = async (kind: HostHttpEgressV4Observed) => journal.recordObservation(command(), network.token({
    kind, subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256, targetSha256: journal.target(kind),
    actualSha256: v4Hash([kind, serial]), evidenceSha256: v4Hash(["network-owner", kind]),
    container: kind === "container_attached" ? container : null, writeOutcome: null,
  }));
  return {storage, network, observers, journal, recipe, intent, observe, command,
    kinds: () => storage.journal === null ? [] : v4Decode(storage.journal).map(record => record.event.kind),
    state: () => v4Replay(v4Decode(storage.journal!), subject),
    async open() {
      await journal.prepare(command());
      observers.bind(journal);
    },
    async allocate() {
      await this.open();
      await intent("network_intent"); await observe("network_allocated");
      await intent("listener_intent");
      await observers.observeListener(recipe, address);
      await observe("container_attached");
    },
  };
};

const removalToken = async (owner: ReturnType<typeof removalOwner>): Promise<object> => {
  const token = await owner.containAndObserve({authority: {...container}, key: subject.attempt,
    call: {deadlineEpochMs: Date.now() + 5_000, signal: new AbortController().signal}} as never);
  assert.ok(token, "the removal owner must issue its own absence token");
  return token;
};

test("joined owners resolve exactly one member's token and nothing else", () => {
  const data = {kind: "network_allocated", subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256,
    targetSha256: v4Hash("target"), actualSha256: v4Hash("actual"), evidenceSha256: v4Hash("evidence"),
    container: null, writeOutcome: null} as never;
  const left = new SyntheticV4Owner(); const right = new SyntheticV4Owner();
  const owned = left.token(data);
  const joined = joinHostHttpEgressV4Observers([left, right]);
  assert.deepEqual(joined.readObservation(owned), left.readObservation(owned));
  assert.equal(right.readObservation(owned), undefined);
  assert.equal(joined.readObservation(Object.freeze({})), undefined);

  // Two owners claiming the same token is a conflict, never a preference.
  const shared = Object.freeze({});
  const claim = {readObservation: (token: object) => token === shared ? data : undefined};
  const rival = {readObservation: (token: object) => token === shared ? data : undefined};
  assert.equal(joinHostHttpEgressV4Observers([claim, rival]).readObservation(shared), undefined);
  assert.deepEqual(joinHostHttpEgressV4Observers([claim]).readObservation(shared), data);
});

test("the join refuses an empty, duplicated or non-owner membership", () => {
  const owner = new SyntheticV4Owner();
  assert.throws(() => joinHostHttpEgressV4Observers([]));
  assert.throws(() => joinHostHttpEgressV4Observers([owner, owner]));
  assert.throws(() => joinHostHttpEgressV4Observers([{} as never]));
  assert.throws(() => joinHostHttpEgressV4Observers(Array.from({length: 9}, () => new SyntheticV4Owner())));
});

test("the listener observation completes the canonical V4 setup order", async () => {
  const f = fixture();
  await f.allocate();
  await f.observers.recordRouteIntent();
  assert.deepEqual(f.kinds(), ["opened", "network_intent", "network_allocated", "listener_intent",
    "listener_allocated", "container_attached", "route_intent"]);
  const ledger = f.state();
  assert.equal(ledger.listener.phase, 2);
  assert.notEqual(ledger.container, null);
  assert.equal(ledger.route.phase, 1);
  assert.equal(ledger.reconcileRequired, false);
  // The recipe's own readback is what was published, not a caller assertion.
  assert.equal(f.recipe.reads, 1);
});

test("a listener that is not actually bound publishes nothing", async () => {
  for (const state of [{...open, openState: "pending"}, {...open, listenerState: "pending"},
    {...open, nativeBindPending: true}, {...open, admissionSealed: true}, {...open, closeRequested: true},
    {...open, scope: "synthetic"}, {...open, extra: 1}]) {
    const f = fixture();
    await f.open();
    await f.intent("network_intent"); await f.observe("network_allocated"); await f.intent("listener_intent");
    f.recipe.state = state;
    await assert.rejects(f.observers.observeListener(f.recipe, address));
    assert.equal(f.state().listener.phase, 1);
  }
});

test("a listener address outside the private IPv4 endpoint grammar publishes nothing", async () => {
  for (const bad of [{...address, address: "203.0.113.7"}, {...address, port: 0},
    {...address, family: "IPv6"}, {address: address.address, port: address.port}]) {
    const f = fixture();
    await f.open();
    await f.intent("network_intent"); await f.observe("network_allocated"); await f.intent("listener_intent");
    await assert.rejects(f.observers.observeListener(f.recipe, bad));
    assert.equal(f.state().listener.phase, 1);
  }
});

test("the cut-off observation requires an aborted signal and a sealed listener", async () => {
  const f = fixture();
  await f.allocate();
  const controller = new AbortController();
  await assert.rejects(f.observers.observeCutoff(controller.signal, f.recipe));
  controller.abort();
  await assert.rejects(f.observers.observeCutoff(controller.signal, f.recipe));
  assert.equal(f.state().cutoff, false);
  f.recipe.state = sealed;
  await f.observers.observeCutoff(controller.signal, f.recipe);
  const ledger = f.state();
  assert.equal(ledger.cutoff, true);
  assert.equal(ledger.cutoffObserved, true);
});

test("container absence is published only from the removal owner's own token", async () => {
  const owner = removalOwner();
  const f = fixture(owner);
  await f.allocate();
  const controller = new AbortController(); controller.abort();
  f.recipe.state = sealed;
  await f.observers.observeCutoff(controller.signal, f.recipe);
  await assert.rejects(f.observers.observeContainerAbsent(Object.freeze({})));
  const token = await removalToken(owner);
  // A structural copy of the token resolves to nothing in the removal owner.
  await assert.rejects(f.observers.observeContainerAbsent({...token}));
  assert.equal(f.state().containerAbsent, false);
  await f.observers.observeContainerAbsent(token);
  assert.equal(f.state().containerAbsent, true);
});

test("a still present container cannot be observed as absent", async () => {
  const owner = removalOwner(true);
  assert.equal(await owner.containAndObserve({authority: {...container}, key: subject.attempt,
    call: {deadlineEpochMs: Date.now() + 5_000, signal: new AbortController().signal}} as never), undefined);
});

test("the release chain reaches network absence in the reverse of allocation", async () => {
  const owner = removalOwner();
  const f = fixture(owner);
  await f.allocate();
  const controller = new AbortController(); controller.abort();
  f.recipe.state = sealed;
  await f.observers.observeCutoff(controller.signal, f.recipe);
  await f.observers.observeContainerAbsent(await removalToken(owner));
  // The listener is released while the network still exists.
  await assert.rejects(f.intent("network_release"));
  await f.intent("listener_release");
  f.recipe.state = closed;
  await f.observers.observeListenerAbsent(f.recipe);
  await f.intent("network_release");
  await f.observe("network_absent");
  const ledger = f.state();
  assert.equal(ledger.listener.phase, 4);
  assert.equal(ledger.network.phase, 4);
  assert.equal(ledger.reconcileRequired, false);
  assert.deepEqual(f.kinds().slice(-7), ["cutoff", "cutoff_observed", "container_absent",
    "listener_release", "listener_absent", "network_release", "network_absent"]);
});

test("an unacknowledged listener closure is never published as absence", async () => {
  const owner = removalOwner();
  const f = fixture(owner);
  await f.allocate();
  const controller = new AbortController(); controller.abort();
  f.recipe.state = sealed;
  await f.observers.observeCutoff(controller.signal, f.recipe);
  await f.observers.observeContainerAbsent(await removalToken(owner));
  await f.intent("listener_release");
  for (const state of [{...closed, serverCloseAcknowledged: false}, {...closed, listenerState: "unknown"},
    {...closed, uncertainty: ["socket-close-unobserved"]}]) {
    f.recipe.state = state;
    await assert.rejects(f.observers.observeListenerAbsent(f.recipe));
  }
  assert.equal(f.state().listener.phase, 3);
});

test("the ledger binding is one-use and refuses a foreign or unopened ledger", async () => {
  const f = fixture();
  await assert.rejects(f.observers.observeListener(f.recipe, address));
  await f.journal.prepare(f.command());
  f.observers.bind(f.journal);
  assert.throws(() => {f.observers.bind(f.journal);});
  assert.throws(() => {f.observers.bind({target: () => "", evidence: () => ({})} as never);});
  const other = createDockerHostHttpEgressObservers({subject, removal: removalOwner()});
  const foreign = new HostHttpEgressV4Journal(new MemoryV4Storage(), subject, new SyntheticV4Owner());
  assert.throws(() => {other.bind(foreign);}, "an unopened ledger is refused");
});

/** Structural view of the lease the Linux route owner returns after it verified
 * its own kernel readback. No route is installed anywhere in this test. */
const lease = () => Object.freeze({cutoff: Promise.resolve("closed" as const),
  reserveFirstWrite: () => ({consume: () => false}), revoke: () => "closed" as const,
  releaseAfterContainerRemoval: async () => "closed" as const});

test("the installed route is published only after a fresh acknowledged intent", async () => {
  const f = fixture();
  await f.allocate();
  const endpoint = {address: address.address, port: address.port};
  await assert.rejects(f.observers.observeRouteInstalled(lease() as never, endpoint));
  assert.equal(f.state().route.phase, 0);
  await f.observers.recordRouteIntent();
  await assert.rejects(f.observers.recordRouteIntent(), "the intent is one-use");
  await f.observers.observeRouteInstalled(lease() as never, endpoint);
  assert.equal(f.state().route.phase, 2);
  assert.deepEqual(f.kinds().slice(-2), ["route_intent", "route_installed"]);
  // Only an installed route opens an exchange.
  await f.intent("inbound_intent");
  assert.equal(f.state().exchange?.number, 1);
});

test("an incomplete or mutable route lease publishes nothing", async () => {
  for (const broken of [{...lease()}, {...lease(), revoke: undefined}, {...lease(), cutoff: "closed"},
    null, "installed"]) {
    const f = fixture();
    await f.allocate();
    await f.observers.recordRouteIntent();
    await assert.rejects(f.observers.observeRouteInstalled(broken as never,
      {address: address.address, port: address.port}));
    assert.equal(f.state().route.phase, 1);
  }
});

test("an unroutable endpoint publishes nothing", async () => {
  for (const endpoint of [{address: "10.203.0.1", port: 0}, {address: 10, port: 443}]) {
    const f = fixture();
    await f.allocate();
    await f.observers.recordRouteIntent();
    await assert.rejects(f.observers.observeRouteInstalled(lease() as never, endpoint as never));
    assert.equal(f.state().route.phase, 1);
  }
});
