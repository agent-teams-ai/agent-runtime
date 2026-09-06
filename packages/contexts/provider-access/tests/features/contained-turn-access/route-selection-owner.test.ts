import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../../dist/features/contained-turn-access/domain/dispatch-consumption.js";
import { routeSelectionDigest, snapshotRouteSelectionFacts } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/route-selection-data.js";
import { createHash } from "node:crypto";
import { harness, selection } from "./route-selection-fixture.ts";

const facts = (input = selection()) => snapshotRouteSelectionFacts({binding: input.binding, recipe: input.recipe, descriptor: input.descriptor});

test("all four explicit PA recipes endorse full detached native descriptors", async () => {
  for (const recipe of ["codex-chatgpt", "codex-api", "claude-oauth", "claude-api"] as const) {
    const h = await harness(selection(recipe)); const owner = h.owner();
    assert.equal(h.connects(), 0);
    assert.equal(await owner.readCurrent(), undefined);
    assert.equal(h.state.rows.length, 0, "current read never endorses");
    const current = await owner.control.endorse(1);
    assert.equal(current.recipe, recipe); assert.equal(current.routeGeneration, "1");
    assert.notEqual(current.routeAuthorityDigest, current.binding.credentialBindingDigest);
    assert.deepEqual(await owner.readCurrent(), current);
    assert.equal(Object.isFrozen(current.descriptor.exactValues), true);
    owner.dispose();
  }
});

test("two owners serialize identical endorsements and a reconstructed owner reads durable facts", async () => {
  const h = await harness(); const a = h.owner(); const b = h.owner();
  const results = await Promise.all([a.control.endorse(1), b.control.endorse(1)]);
  assert.deepEqual(results[0], results[1]); assert.equal(h.state.rows.length, 1);
  a.dispose(); b.dispose();
  const restarted = h.owner(); assert.deepEqual(await restarted.readCurrent(), results[0]); restarted.dispose();
  assert.equal(h.calls.filter(call => call.sql.startsWith("INSERT INTO provider_access.route_selection(")).length, 1);
});

test("competing descriptors at the same revision have exactly one winner", async () => {
  const h = await harness();
  const changed = {...h.input, descriptor: {...h.input.descriptor, exactValues: {...h.input.descriptor.exactValues, version: "0.153.5"}}};
  const a = h.owner(); const b = h.owner(changed);
  const outcomes = await Promise.allSettled([a.control.endorse(1), b.control.endorse(1)]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(h.state.rows.length, 1); a.dispose(); b.dispose();
});

test("new revisions need the exact current PA head; generic credential replacement remains accepted", async () => {
  const h = await harness(); const old = h.owner(); const store = h.store();
  await old.control.endorse(1);
  const changed = {...h.input.binding, credentialGeneration: 2, credentialBindingDigest: "credential:digest:2"};
  assert.equal(await store.replaceBinding(changed, 1), 2);
  assert.equal(await old.readCurrent(), undefined);
  const sameRevision = h.owner({...h.input, binding: changed});
  await assert.rejects(sameRevision.control.endorse(2), /conflicts/u);
  const newInput = {...h.input, binding: {...changed, bindingRevision: 2}};
  const next = h.owner(newInput);
  await assert.rejects(next.control.endorse(2), /not current/u);
  assert.equal(await store.replaceBinding(newInput.binding, 2), 3);
  await assert.rejects(next.control.endorse(2), /not current/u);
  assert.equal((await next.control.endorse(3)).routeGeneration, "2");
  assert.equal(await store.replaceBinding(h.input.binding, 3), 4, "Generic rollback contract is unchanged");
  assert.equal(await old.readCurrent(), undefined);
  await assert.rejects(old.control.endorse(4), /conflicts/u);
  old.dispose(); sameRevision.dispose(); next.dispose(); store.dispose();
});

test("any head replacement invalidates attachment, including same-data ABA", async () => {
  const h = await harness(); const owner = h.owner(); const store = h.store();
  await owner.control.endorse(1);
  await store.replaceBinding({...h.input.binding, revocation: "revoked"}, 1);
  assert.equal(await owner.readCurrent(), undefined);
  await store.replaceBinding(h.input.binding, 2);
  assert.equal(await owner.readCurrent(), undefined);
  await assert.rejects(owner.control.endorse(3)); owner.dispose(); store.dispose();
});

test("current binding identity, credential facts, revocation and availability are checked in full", async () => {
  const h = await harness(); const owner = h.owner(); await owner.control.endorse(1);
  const mutations = {tenantId: "foreign", projectId: "foreign", provider: "claude", scopeDigest: "foreign", accessRef: "foreign",
    providerAccountRef: "foreign", providerRouteRef: "foreign", credentialBindingRef: "foreign", credentialBindingDigest: "foreign",
    credentialGeneration: 2, bindingRevision: 2, availability: "unavailable", revocation: "revoked"};
  for (const [key, value] of Object.entries(mutations)) {
    h.state.binding = {...h.input.binding, [key]: value};
    assert.equal(await owner.readCurrent(), undefined, key);
    await assert.rejects(owner.control.endorse(1), undefined, key);
  }
  h.state.binding = null; assert.equal(await owner.readCurrent(), undefined); owner.dispose();
});

test("stored endorsement columns and every stored fact are validated, never trusted by digest alone", async () => {
  const h = await harness(); const owner = h.owner(); await owner.control.endorse(1);
  const original = structuredClone(h.state.rows[0]!);
  const saved = original.endorsement as Record<string, unknown>;
  for (const [key, value] of Object.entries(h.input.binding)) {
    const bad = typeof value === "number" ? value + 1 : "foreign";
    h.state.rows[0] = {...original, endorsement: {...saved, binding: {...h.input.binding, [key]: bad}}};
    assert.equal(await owner.readCurrent(), undefined, key);
  }
  for (const field of ["recipe", "descriptor", "routeGeneration", "routeAuthorityDigest"]) {
    h.state.rows[0] = {...original, endorsement: {...saved, [field]: "foreign"}};
    assert.equal(await owner.readCurrent(), undefined, field);
  }
  for (const change of [{binding_revision: "0"}, {binding_revision: "2"}, {head_version: "2"}, {head_version: "9007199254740992"}]) {
    h.state.rows[0] = {...original, ...change}; assert.equal(await owner.readCurrent(), undefined);
  }
  h.state.rows[0] = original; assert.ok(await owner.readCurrent()); owner.dispose();
});

test("invalid descriptor associations and closed header shapes fail before database access", async () => {
  const h = await harness();
  const bad = [{id: "foreign"}, {provider: "claude"}, {credentialMode: "api-key"}, {originHost: "evil.example"},
    {originPort: 80}, {upstreamMethod: "GET"}, {upstreamPath: "/v1/responses"}, {credentialFieldNames: ["cookie"]},
    {forwardedRequestHeaderNames: ["content-type", "authorization"]}, {forwardedRequestHeaderNames: ["content-type", "host"]},
    {forwardedRequestHeaderNames: ["content-type", "content-type"]}, {requiredHeaderNames: ["missing"]},
    {exactValues: {"content-type": "text/plain"}}, {exactValues: {"content-type": "application/json", version: "bad\r\nvalue"}}, {extra: true}];
  for (const change of bad) {assert.throws(() => h.owner({...h.input, descriptor: {...h.input.descriptor, ...change}} as never));}
  for (const recipe of ["foreign", "claude-api", "codex-api"]) {assert.throws(() => h.owner({...h.input, recipe} as never));}
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => h.owner({...h.input, binding: {...h.input.binding, bindingRevision: revision}}));
  }
  assert.equal(h.connects(), 0);
});

test("mutation, accessors and proxies cannot redirect construction or invoke user traps", async () => {
  const h = await harness(); const owner = h.owner();
  Object.assign(h.input.binding, {providerRouteRef: "mutated"});
  Object.assign(h.input.descriptor.exactValues, {version: "mutated"});
  const current = await owner.control.endorse(1);
  assert.equal(current.binding.providerRouteRef, "route:1"); assert.equal(current.descriptor.exactValues.version, "0.153.4");
  let effects = 0;
  const proxy = new Proxy({}, {get() {effects++; throw new Error("trap");}, ownKeys() {effects++; throw new Error("trap");},
    getPrototypeOf() {effects++; throw new Error("trap");}});
  for (const input of [proxy, {...selection(), descriptor: proxy}, {...selection(), binding: proxy},
    {...selection(), descriptor: {...selection().descriptor, exactValues: proxy}}]) {
    assert.throws(() => h.owner(input as never));
  }
  const accessor = {...selection()}; Object.defineProperty(accessor, "recipe", {get() {effects++; return "codex-api";}});
  assert.throws(() => h.owner(accessor));
  const nested = {...selection().descriptor}; Object.defineProperty(nested, "originHost", {get() {effects++; return "evil.example";}});
  assert.throws(() => h.owner({...selection(), descriptor: nested}));
  const timeoutAccessor = {}; Object.defineProperty(timeoutAccessor, "transactionMs", {get() {effects++; return 1;}});
  assert.throws(() => h.owner(selection(), timeoutAccessor)); assert.throws(() => h.owner(selection(), proxy));
  assert.equal(effects, 0); owner.dispose();
});

test("canonical SHA256 preimage covers all profile and binding fields with PA domain separation", async () => {
  const base = facts(); const digest = await routeSelectionDigest(base);
  const preimage = canonicalJson({purpose: "provider-access.contained-turn.route-selection/v1", ...base});
  assert.equal(digest, `sha256:${createHash("sha256").update(preimage).digest("hex")}`);
  for (const field of Object.keys(base.descriptor)) {
    const changed = {...base, descriptor: {...base.descriptor, [field]: ["different", field]}};
    assert.notEqual(await routeSelectionDigest(changed as never), digest, field);
  }
  for (const field of Object.keys(base.binding)) {
    assert.notEqual(await routeSelectionDigest({...base, binding: {...base.binding, [field]: "different"}} as never), digest, field);
  }
  assert.notEqual(await routeSelectionDigest({...base, recipe: "codex-api"}), digest);
  for (const recipe of ["codex-chatgpt", "codex-api", "claude-oauth", "claude-api"] as const) {
    const selected = facts(selection(recipe)); const original = await routeSelectionDigest(selected);
    for (const name of Object.keys(selected.descriptor.exactValues)) {
      assert.notEqual(await routeSelectionDigest({...selected, descriptor: {...selected.descriptor,
        exactValues: {...selected.descriptor.exactValues, [name]: "changed"}}}), original, `${recipe}:${name}`);
    }
  }
  const reversed = Object.fromEntries(Object.entries(base.descriptor).reverse());
  assert.equal(await routeSelectionDigest({...base, descriptor: reversed} as never), digest);
});

test("private persistence revalidates the full endorsement before trusting a composition caller", async () => {
  const h = await harness(); const owner = h.owner(); const current = await owner.control.endorse(1);
  const store = h.store();
  for (const change of [{routeGeneration: "2"}, {routeAuthorityDigest: "sha256:forged"},
    {descriptor: {...current.descriptor, originHost: "evil.example"}}]) {
    await assert.rejects(store.routeSelection.endorse({...current, ...change}, 1, () => {}));
  }
  assert.equal(h.state.rows.length, 1); owner.dispose(); store.dispose();
});
