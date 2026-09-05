import assert from "node:assert/strict";
import {test} from "node:test";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {normalizeHttpResolverEvidence} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-resolver-evidence.js";
import {createEgressFixture} from "./http-egress-test-fixture.ts";

const entry = () => ({family: "ipv4", address: "93.184.216.34", classification: "public"});
const observation = (addresses: unknown = [entry()]) => ({resolverIdentity: "resolver-1",
  resolverEpoch: "resolver-epoch-1", resolutionCount: 1, selectedAddress: "93.184.216.34", addresses});
const denied = async (raw: unknown) => {
  const fixture = createEgressFixture();
  const receipt = await createStrictHttpEgressBroker({...fixture.ports,
    resolver: {resolve: async () => raw as never}}).execute(fixture.operation);
  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.anomalyCode, "resolution_denied");
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(fixture.observations.opens, 0);
  assert.equal(fixture.observations.dispatches, 0);
  assert.equal(fixture.observations.finalAuthorizationInputs.length, 0);
};

for (const field of ["family", "classification"] as const) {
  for (const value of [undefined, null, 4, {}, "", "PUBLIC", "private", "ipv6"]) {
    test(`rejects malformed ${field}: ${JSON.stringify(value)}`, async () => {
      await denied(observation([{...entry(), [field]: value}]));
    });
  }
}
test("rejects the wrong family for IPv6", async () => {
  await denied({...observation([{...entry(), address: "2606:2800:220:1:248:1893:25c8:1946"}]),
    selectedAddress: "2606:2800:220:1:248:1893:25c8:1946"});
});

test("rejects malformed records, array shapes, addresses, and counts", async () => {
  for (const value of [null, undefined, 1, "93.184.216.34", [], {},
    {address: "93.184.216.34"}, {...entry(), extra: true}, {...entry(), address: {}},
    {...entry(), address: "127.0.0.1"}, Object.create(entry()),
    Object.defineProperty(entry(), "family", {enumerable: false})]) {await denied(observation([value]));}
  for (const addresses of [null, {}, [], Object.assign([], {length: 1}), Object.assign([], {0: entry(), 2: entry(), length: 3}),
    Object.assign([entry()], {extra: true}), Array(33).fill(entry())]) {await denied(observation(addresses));}
  for (const resolutionCount of [0, 2, "1", undefined]) {await denied({...observation(), resolutionCount});}
});

test("never invokes resolver, array, or entry getters", async () => {
  let reads = 0;
  const accessor = {enumerable: true, get: () => {reads += 1; throw new Error("getter invoked");}};
  for (const field of Object.keys(observation())) {
    await denied(Object.defineProperty(observation(), field, accessor));
  }
  for (const field of Object.keys(entry())) {
    await denied(observation([Object.defineProperty(entry(), field, accessor)]));
  }
  await denied(observation(Object.defineProperty([entry()], "0", accessor)));
  await denied(observation(Object.defineProperty([entry()], "map", accessor)));
  assert.equal(reads, 0);
});

test("rejects proxies and revoked proxies without invoking traps", async () => {
  let traps = 0;
  const handler = {
    get: () => {traps += 1; throw new Error("get trap");},
    getPrototypeOf: () => {traps += 1; throw new Error("prototype trap");},
    ownKeys: () => {traps += 1; throw new Error("keys trap");},
    getOwnPropertyDescriptor: () => {traps += 1; throw new Error("descriptor trap");},
  };
  // The outer proxy's `then` is read by Promise resolution before the broker receives it.
  await denied(new Proxy(observation(), {...handler, get: (_target, key) => key === "then" ? undefined : handler.get()}));
  await denied(observation(new Proxy([entry()], handler)));
  await denied(observation([new Proxy(entry(), handler)]));
  for (const value of [[entry()], entry()]) {
    const proxy = Proxy.revocable(value, handler); proxy.revoke();
    await denied(observation(Array.isArray(value) ? proxy.proxy : [proxy.proxy]));
  }
  assert.equal(traps, 0);
});

for (const field of ["resolverIdentity", "resolverEpoch"] as const) {
  test(`requires bounded primitive ${field}`, async () => {
    for (const value of [undefined, null, 1, {}, "", "x".repeat(513), "bad\nidentity", "bad\u0000epoch", "\ud800"]) {
      await denied({...observation(), [field]: value});
    }
  });
}

test("rejects extra keys, symbols, inherited records, and non-enumerable fields", async () => {
  for (const raw of [null, undefined, [], {}, Object.create(observation()),
    Object.assign(Object.create(null), observation()), {...observation(), extra: true},
    {...observation(), [Symbol("extra")]: true}]) {await denied(raw);}
  for (const field of Object.keys(observation())) {
    await denied(Object.defineProperty(observation(), field, {enumerable: false}));
    const missing = {...observation()} as Record<string, unknown>; delete missing[field]; await denied(missing);
  }
  await denied(observation([{...entry(), [Symbol("extra")]: true}]));
  await denied(observation(Object.assign([entry()], {[Symbol("extra")]: true})));
  await denied(observation(Object.defineProperty([entry()], "0", {enumerable: false})));
  await denied(observation(Object.setPrototypeOf([entry()], null)));
});

test("never invokes iterators or coercion hooks", async () => {
  let calls = 0;
  const hostile = () => {calls += 1; throw new Error("hostile hook");};
  const coercible = {[Symbol.toPrimitive]: hostile, toString: hostile, valueOf: hostile};
  for (const field of Object.keys(observation())) {await denied({...observation(), [field]: coercible});}
  for (const field of Object.keys(entry())) {await denied(observation([{...entry(), [field]: coercible}]));}
  await denied(observation({[Symbol.iterator]: hostile}));
  await denied(observation(Object.assign([entry()], {[Symbol.iterator]: hostile})));
  await denied(observation(Object.defineProperty([entry()], Symbol.iterator, {get: hostile})));
  await denied(observation(Object.assign([entry()], {map: hostile})));
  assert.equal(calls, 0);
});

test("rejects unbounded, malformed, nonpublic, duplicate, and unselected addresses", async () => {
  for (const address of ["", "x".repeat(65), "\ud800", "093.184.216.34", "93.184.216.256", "127.0.0.1",
    "10.0.0.1", "169.254.169.254", "::1", "2002:7f00:1::", "2001:db8::1", "2606:4700::1111%eth0"]) {
    await denied({...observation([{...entry(), family: address.includes(":") ? "ipv6" : "ipv4", address}]),
      selectedAddress: address});
  }
  await denied({...observation(), selectedAddress: "93.184.216.35"});
  await denied(observation([entry(), entry()]));
  await denied(observation(Object.assign([], {length: 0xffff_ffff})));
});

test("snapshots canonical immutable evidence before opening transport", async () => {
  const fixture = createEgressFixture();
  const raw = observation([entry(), {family: "ipv6", address: "2606:4700:0000:0000:0000:0000:0000:ABCD", classification: "public"}]);
  const rawAddresses = raw.addresses as ReturnType<typeof entry>[];
  let resolutions = 0;
  const receipt = await createStrictHttpEgressBroker({...fixture.ports,
    resolver: {resolve: async () => {resolutions += 1; return raw as never;}},
    transport: {beginOpen: input => {
      assert.equal(input.selectedAddress, "93.184.216.34");
      raw.resolverIdentity = "mutated"; raw.resolverEpoch = "mutated"; raw.selectedAddress = "127.0.0.1";
      rawAddresses[0].address = "127.0.0.1"; rawAddresses.splice(1);
      return fixture.ports.transport.beginOpen(input);
    }},
  }).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal(resolutions, 1);
  assert.equal(fixture.observations.opens, 1);
  assert.equal(fixture.observations.dispatches, 1);
  const resolver = fixture.observations.finalAuthorizationInputs[0].resolver;
  assert.deepEqual(resolver, {resolverIdentity: "resolver-1", resolverEpoch: "resolver-epoch-1", resolutionCount: 1,
    addresses: [{family: "ipv6", address: "2606:4700::abcd", classification: "public"}, entry()]});
  assert.ok(Object.isFrozen(resolver)); assert.ok(Object.isFrozen(resolver.addresses));
  assert.ok(resolver.addresses.every(Object.isFrozen));
  assert.notEqual(resolver.addresses, rawAddresses);
});

test("accepts maximum bounded identity, epoch, and address count", async () => {
  const fixture = createEgressFixture();
  const raw = {...observation(Array.from({length: 32}, (_, index) => ({...entry(), address: `93.184.216.${index + 34}`}))),
    resolverIdentity: "r".repeat(512), resolverEpoch: "e".repeat(512)};
  const receipt = await createStrictHttpEgressBroker({...fixture.ports,
    resolver: {resolve: async () => raw as never}}).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal(fixture.observations.finalAuthorizationInputs[0].resolver.addresses.length, 32);
});

test("rejects outer proxies without inspection, including revoked proxies", () => {
  let traps = 0;
  const hostile = () => {traps += 1; throw new Error("proxy trap");};
  const proxy = Proxy.revocable(observation(), {get: hostile, getPrototypeOf: hostile,
    ownKeys: hostile, getOwnPropertyDescriptor: hostile});
  // Test the observation boundary directly: native Promise resolution reads `then` upstream.
  assert.equal(normalizeHttpResolverEvidence(proxy.proxy), undefined);
  proxy.revoke();
  assert.equal(normalizeHttpResolverEvidence(proxy.proxy), undefined);
  assert.equal(traps, 0);
});

test("pins the canonical selected IPv6 address and binds it to final authority", async () => {
  const canonical = "2606:4700::abcd";
  const fixture = createEgressFixture({selectedAddress: canonical, binding: {peerAddress: canonical}});
  const address = "2606:4700:0000:0000:0000:0000:0000:ABCD";
  const raw = {...observation([{family: "ipv6", address, classification: "public"}]), selectedAddress: address};
  const receipt = await createStrictHttpEgressBroker({...fixture.ports,
    resolver: {resolve: async () => raw as never},
    transport: {beginOpen: input => {assert.equal(input.selectedAddress, canonical);
      return fixture.ports.transport.beginOpen(input);}},
  }).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  const input = fixture.observations.finalAuthorizationInputs[0];
  assert.deepEqual(input.resolver.addresses, [{family: "ipv6", address: canonical, classification: "public"}]);
  assert.equal(input.pinnedDestination.address, canonical);
});
