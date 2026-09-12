import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LINUX_EXCLUSIVE_ROUTE_POLICY_REVISION, LINUX_EXCLUSIVE_ROUTE_TABLE,
  linuxExclusiveRouteReadback, linuxExclusiveRouteRules, linuxExclusiveRouteTransaction } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-exclusive-route-policy.js";
import { parseStrictJson } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/serialization/strict-json.js";

// Exact externally supplied native capture; never execute its characterization
// script here. Only table identity is mapped when testing the production recipe.
const captureBytes = readFileSync(new URL("./support/linux-kernel-timeout-capture.json", import.meta.url));
const capture = JSON.parse(captureBytes.toString());
const endpoint = {address: "10.203.61.1", port: 43129};
const window = {timeoutSeconds: 4, beforeMs: 100, afterMs: 100, cutoffMs: 5100};
const listing = (after = false): any => {
  const value = structuredClone(after ? capture.after : capture.before);
  for (const entry of value.nftables) {
    if (entry.table) {entry.table.name = LINUX_EXCLUSIVE_ROUTE_TABLE;}
    else if (!entry.metainfo) {Object.values(entry).forEach((body: any) => {body.table = LINUX_EXCLUSIVE_ROUTE_TABLE;});}
  }
  return value;
};
const membership = (value: any): any => value.nftables.find((entry: any) => entry.set).set;
const element = (value: any): any => membership(value).elem[0].elem;
const rule = (value: any, chain = "output"): any => value.nftables.find((entry: any) => entry.rule?.chain === chain).rule;

test("exact captured nft 1.0.9 JSON is pinned; only its disposable table identity needs mapping", () => {
  assert.equal(createHash("sha256").update(captureBytes).digest("hex"),
    "2443c18d59bf46900876c97f29b6ed2c44ccad038fd73b353492cb4148f1d98b");
  assert.equal(capture.kernel, "6.8.0-138-generic");
  assert.equal(capture.nftSha256, "3f1c21553e62716ef1abfcf31f51ff94eb73ff4234a6653bac754a42f936d1c7");
  assert.equal(capture.actualHostImplementationTested, false);
  assert.equal(capture.providerInvoked, false); assert.equal(capture.credentialsUsed, false);
  assert.equal(capture.externalNetwork, false); assert.equal(capture.installerState, "T (stopped)");
  assert.equal(linuxExclusiveRouteReadback(capture.before, endpoint, window), undefined);
  const value = listing();
  assert.deepEqual(element(value), {val: endpoint.address, timeout: 4, expires: 3});
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, window), 3100);
  assert.equal(linuxExclusiveRouteReadback(listing(true), endpoint, {...window, beforeMs: 6100, afterMs: 6100}), undefined);
  assert.equal(linuxExclusiveRouteReadback(listing(true), endpoint, window), undefined);
  // Expired live recipe is not an acknowledged deny-only replacement.
  assert.equal(linuxExclusiveRouteReadback(listing(true), endpoint, false), undefined);
});

test("closed V2 commands have one finite membership shared by both directions, no packet refresh", () => {
  assert.equal(LINUX_EXCLUSIVE_ROUTE_POLICY_REVISION, "linux-x64-exclusive-http-route/v2");
  assert.equal(LINUX_EXCLUSIVE_ROUTE_TABLE, "ar_provider_route_v1");
  const transaction = JSON.parse(linuxExclusiveRouteTransaction(endpoint, false, 4));
  assert.deepEqual(transaction.nftables[0], {create: {table: {family: "inet", name: LINUX_EXCLUSIVE_ROUTE_TABLE}}});
  const objects = transaction.nftables.map((command: any) => command.create ?? command.add);
  const native = listing().nftables.filter((entry: any) => !entry.metainfo).map((entry: any) => {
    const [kind, value] = Object.entries(entry)[0]! as [string, any];
    const {handle: _handle, ...body} = value;
    if (kind === "set") {delete body.elem[0].elem.expires;}
    return {[kind]: body};
  });
  // Native listing groups chains/rules differently. Every actual policy object
  // must nevertheless match, including exact expression order and set syntax.
  assert.deepEqual(objects.toSorted((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    native.toSorted((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.equal(objects.filter((entry: any) => entry.set).length, 1);
  for (const hook of ["input", "output", "forward"]) {
    assert.equal(objects.find((entry: any) => entry.chain?.name === hook).chain.policy, "drop");
  }
  for (const entry of objects.filter((candidate: any) => candidate.rule)) {
    assert.equal(entry.rule.expr[0].match.right, "@broker");
    assert.equal(entry.rule.expr.at(-1).accept, null);
  }
  assert.doesNotMatch(JSON.stringify(transaction), /"(?:update|dynamic|counter|ct count|expires)"/u);
  const deny = JSON.parse(linuxExclusiveRouteTransaction(endpoint, true, false));
  assert.deepEqual(deny.nftables[0], {delete: {table: {family: "inet", name: LINUX_EXCLUSIVE_ROUTE_TABLE}}});
  assert.equal(deny.nftables.some((entry: any) => entry.add?.set || entry.add?.rule), false);
  assert.equal(linuxExclusiveRouteReadback({nftables: deny.nftables.slice(1).map((entry: any) => entry.create ?? entry.add)}, endpoint, false), 0);
  // Legacy unbounded V1 cannot become live via a compatibility branch.
  const legacy = listing(); legacy.nftables = legacy.nftables.filter((entry: any) => !entry.set);
  for (const entry of legacy.nftables) {if (entry.rule) {entry.rule.expr[0].match.right = endpoint.address;}}
  assert.equal(linuxExclusiveRouteReadback(legacy, endpoint, window), undefined);
});

test("quantized expires uses an upper bound and accounts for the whole read observation window", () => {
  const value = listing();
  // E=3 denotes [3,4) seconds, so 3100 is not an upper bound at t=100.
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, cutoffMs: 3100}), undefined);
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, cutoffMs: 4099.999}), undefined);
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, cutoffMs: 4100}), 3100);
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, afterMs: 1100}), 3100);
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, afterMs: 1100.001}), undefined);
  // A stale snapshot can look populated after the actual element expired.
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, afterMs: 3100, cutoffMs: 8100}), undefined);
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, afterMs: 4101, cutoffMs: 9100}), undefined);
  element(value).expires = 1;
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, afterMs: 1099.999}), 1100);
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, afterMs: 1100}), undefined);
  element(value).expires = 4;
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, window), 4100);
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, afterMs: 100.001}), undefined);
});

test("countdown cannot extend the fixed install ceiling or survive its expiration", () => {
  const value = listing();
  for (const now of [2100, 4100, 5100, 6100]) {
    assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, beforeMs: now, afterMs: now}), undefined);
  }
  element(value).expires = 1;
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, beforeMs: 3100, afterMs: 3100}), 4100);
  // A refreshed/reinserted element with the same exact timeout has more remaining
  // authority than this original installation permits, despite matching identity.
  element(value).expires = 3;
  assert.equal(linuxExclusiveRouteReadback(value, endpoint, {...window, beforeMs: 3100, afterMs: 3100}), undefined);
});

test("closed set grammar rejects all extra identity, expiry, timeout and mutable-policy data", () => {
  const mutations: ((value: any) => void)[] = [
    value => {membership(value).type = "ipv6_addr";},
    value => {membership(value).name = "other";},
    value => {membership(value).family = "ip";},
    value => {membership(value).table = "other";},
    value => {membership(value).flags = [];},
    value => {membership(value).flags = ["timeout", "timeout"];},
    value => {membership(value).flags = ["timeout", "dynamic"];},
    value => {membership(value).flags = ["timeout", "constant"];},
    value => {membership(value).timeout = 4;},
    value => {membership(value).gc_interval = 1;},
    value => {membership(value).policy = "performance";},
    value => {membership(value).size = 1;},
    value => {membership(value).comment = "extra";},
    value => {membership(value).elem.push(structuredClone(membership(value).elem[0]));},
    value => {membership(value).elem = [];},
    value => {delete membership(value).elem;},
    value => {membership(value).elem = [endpoint.address];},
    value => {membership(value).elem[0].extra = 1;},
    value => {element(value).val = "10.203.61.2";},
    value => {element(value).comment = "mutable";},
    value => {element(value).counter = {packets: 0, bytes: 0};},
    value => {element(value).handle = 3;},
    value => {delete element(value).timeout;},
    value => {delete element(value).expires;},
    value => {membership(value).handle = 0;},
    value => {membership(value).handle = 1.5;},
    value => {rule(value).expr[0].match.right = "@other";},
    value => {rule(value, "input").expr.splice(0, 1);},
    value => {rule(value).expr.push({update: {set: "broker"}});},
    value => {value.nftables.push({element: {family: "inet", table: LINUX_EXCLUSIVE_ROUTE_TABLE, name: "broker"}});},
    value => {value.nftables.push({counter: {name: "extra"}});},
    value => {value.nftables.push({map: {name: "extra"}});},
  ];
  for (const field of ["timeout", "expires"]) {
    for (const invalid of [0, -1, 5, 4000, 3.5, "4s", "4", null, true, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      mutations.push(value => {element(value)[field] = invalid;});
    }
  }
  for (let index = 0; index < listing().nftables.length; index += 1) {
    if (index > 0) {mutations.push(value => {value.nftables.splice(index, 1);});}
    mutations.push(value => {value.nftables.push(structuredClone(value.nftables[index]));});
  }
  for (const mutate of mutations) {
    const value = listing(); mutate(value);
    assert.equal(linuxExclusiveRouteReadback(value, endpoint, window), undefined, String(mutate));
  }
  // Duplicate JSON keys fail at the native boundary before policy comparison.
  const raw = JSON.stringify(listing());
  for (const key of ["timeout", "expires", "flags", "name"]) {
    const duplicate = raw.replace(new RegExp(`"${key}":`), `"${key}":null,"${key}":`);
    assert.throws(() => parseStrictJson(Buffer.from(duplicate)));
  }
});

test("invalid control windows and numeric timeout ceilings fail closed", () => {
  for (const field of ["beforeMs", "afterMs", "cutoffMs"] as const) {
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(linuxExclusiveRouteReadback(listing(), endpoint, {...window, [field]: value}), undefined);
    }
  }
  assert.equal(linuxExclusiveRouteReadback(listing(), endpoint, {...window, afterMs: 99}), undefined);
  for (const timeout of [0, -1, 1, 119, 120, 4000, NaN, Infinity, 2.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => linuxExclusiveRouteRules(endpoint, timeout));
  }
});
