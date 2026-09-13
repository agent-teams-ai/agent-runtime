import assert from "node:assert/strict";
import test from "node:test";
import {createCredentialMaterializationRequestDigest} from "@agent-teams/provider-access/composition";
import {bindContainedTurnHttpEgressAuthorities, composeContainedTurnHttpEgressSession,
  type ContainedTurnHttpEgressBrokerPorts} from "../../../dist/composition/contained-turn-http-egress-authorities.js";
import {pairedFixture} from "../../contained-turn-http-credential-materialization-fixture.ts";
import {fixture} from "../../contained-turn-current-egress-owners.fixture.ts";

const AUTHORITIES = ["providerAccess", "materializer", "runtimeSecurity", "verifier"] as const;
/** Every remaining member of the broker session record. `identity`, `clock`,
 * `localAuthorityCut` and `journal` are replaced by the Host owners at bind
 * time; the other six are supplied by whoever owns them. Nothing here is a real
 * resolver, transport or route: this suite pins the record, not its producers. */
const PORTS = ["identity", "ids", "providerAccessSnapshot", "route", "localAuthorityCut", "journal",
  "resolver", "transport", "clock", "evidence"] as const;
const ports = (): ContainedTurnHttpEgressBrokerPorts =>
  Object.fromEntries(PORTS.map(key => [key, {port: key}])) as unknown as ContainedTurnHttpEgressBrokerPorts;

const authorities = async () => {
  const paired = pairedFixture();
  const rs = await fixture();
  const bound = bindContainedTurnHttpEgressAuthorities({
    providerAccess: paired.owner, createRequestDigest: createCredentialMaterializationRequestDigest,
    runtimeSecurity: rs.candidate,
  });
  return {bound, paired, rs};
};

test("the two outer ACLs own exactly the four broker ports they implement", async () => {
  const {bound, paired} = await authorities();
  assert.deepEqual(Object.keys(bound).toSorted(), [...AUTHORITIES, "dispose"].toSorted());
  for (const key of AUTHORITIES) {assert.equal(typeof bound[key], "object");}
  assert.ok(Object.isFrozen(bound));
  // A fresh Host authorization still flows through the real PA owner.
  const receipt = await paired.fresh();
  assert.equal(paired.outcomes.length, 1);
  assert.ok(receipt);
  // Disposal closes the newly created pairing only.
  bound.dispose();
  assert.equal(paired.disposals(), 1);
  assert.deepEqual(await bound.providerAccess.authorize(await paired.fixture.request({})), {kind: "indeterminate"});
});

test("the composed session record is exactly the broker's dependency set", async () => {
  const {bound} = await authorities();
  const session = composeContainedTurnHttpEgressSession(bound, ports());
  assert.deepEqual(Object.keys(session).toSorted(), [...PORTS, ...AUTHORITIES].toSorted());
  for (const key of AUTHORITIES) {assert.equal(session[key], bound[key]);}
  assert.ok(Object.isFrozen(session));
});

test("the optional route first-write port is carried through, and only that one", async () => {
  const {bound} = await authorities();
  const routeFirstWrite = {reserve: () => ({consume: () => true})};
  const session = composeContainedTurnHttpEgressSession(bound,
    {...ports(), routeFirstWrite} as unknown as ContainedTurnHttpEgressBrokerPorts);
  assert.deepEqual(Object.keys(session).toSorted(), [...PORTS, ...AUTHORITIES, "routeFirstWrite"].toSorted());
  assert.equal((session as {routeFirstWrite?: unknown}).routeFirstWrite, routeFirstWrite);
  // The optional member widens the accepted set by exactly one known name.
  assert.throws(() => composeContainedTurnHttpEgressSession(bound,
    {...ports(), routeFirstWrite, extra: 1} as unknown as ContainedTurnHttpEgressBrokerPorts));
  const {journal: _missing, ...incomplete} = ports();
  assert.throws(() => composeContainedTurnHttpEgressSession(bound,
    {...incomplete, routeFirstWrite} as unknown as ContainedTurnHttpEgressBrokerPorts));
});

test("a port set that is not exact fails closed before the broker sees it", async () => {
  const {bound} = await authorities();
  const {journal: _missing, ...incomplete} = ports();
  assert.throws(() => composeContainedTurnHttpEgressSession(bound, incomplete as ContainedTurnHttpEgressBrokerPorts));
  assert.throws(() => composeContainedTurnHttpEgressSession(bound,
    {...ports(), extra: 1} as unknown as ContainedTurnHttpEgressBrokerPorts));
  // An owned authority cannot be shadowed by a port supplied under its name.
  assert.throws(() => composeContainedTurnHttpEgressSession(bound,
    {...ports(), providerAccess: {}} as unknown as ContainedTurnHttpEgressBrokerPorts));
  assert.throws(() => composeContainedTurnHttpEgressSession(bound,
    new Proxy(ports(), {}) as ContainedTurnHttpEgressBrokerPorts));
  const getter = Object.defineProperties(ports() as unknown as Record<string, unknown>,
    {route: {enumerable: true, get: () => ({injected: true})}});
  assert.throws(() => composeContainedTurnHttpEgressSession(bound,
    getter as unknown as ContainedTurnHttpEgressBrokerPorts));
});

test("an incomplete authority set is refused", async () => {
  const {bound} = await authorities();
  for (const key of AUTHORITIES) {
    assert.throws(() => composeContainedTurnHttpEgressSession({...bound, [key]: undefined} as never, ports()));
  }
});
