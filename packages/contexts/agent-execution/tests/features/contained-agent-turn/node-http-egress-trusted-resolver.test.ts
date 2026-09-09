import assert from "node:assert/strict";
import {test} from "node:test";
import {NodeHttpEgressTrustedResolver} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-http-egress-trusted-resolver.js";
import type {HttpEgressClock} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";

const options = {resolverIdentity: "node-dns", resolverEpoch: "boot-1", timeoutMs: 100};
const absent = () => Promise.reject(Object.assign(new Error("absent"), {code: "ENODATA"}));
const fixture = (v4: () => Promise<readonly string[]> = async () => ["8.8.8.8"],
  v6: () => Promise<readonly string[]> = async () => ["2606:4700:4700::1111"],
  within?: HttpEgressClock["within"]) => {
  const state = {created: 0, cancelled: 0, calls: [] as string[], now: 0, deadline: 0};
  const clock: HttpEgressClock = {now: () => state.now, within: within ?? (async (deadline, operation) => {
    state.deadline = deadline; return operation();
  })};
  const resolver = new NodeHttpEgressTrustedResolver(options, clock, timeout => {
    assert.equal(timeout, 100); state.created++;
    return {resolve4: host => {state.calls.push(`4:${host}`); return v4();},
      resolve6: host => {state.calls.push(`6:${host}`); return v6();}, cancel: () => {state.cancelled++;}};
  });
  return {resolver, state};
};

test("construction is inert; each call observes both families freshly and freezes canonical evidence", async () => {
  const {resolver, state} = fixture();
  assert.equal(state.created, 0);
  for (let index = 0; index < 2; index++) {
    const result = await resolver.resolve("api.example.com");
    assert.deepEqual(result, {resolverIdentity: "node-dns", resolverEpoch: "boot-1", resolutionCount: 1,
      selectedAddress: "2606:4700:4700:0000:0000:0000:0000:1111", addresses: [
        {address: "2606:4700:4700:0000:0000:0000:0000:1111", family: "ipv6", classification: "public"},
        {address: "8.8.8.8", family: "ipv4", classification: "public"}]});
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.addresses) && Object.isFrozen(result.addresses[0]));
  }
  assert.equal(state.created, 2); assert.equal(state.cancelled, 2); assert.equal(state.deadline, 100);
  assert.deepEqual(state.calls, ["4:api.example.com", "6:api.example.com", "4:api.example.com", "6:api.example.com"]);
});

test("only explicit ENODATA allows a single family", async () => {
  assert.equal((await fixture(undefined, absent).resolver.resolve("example.com")).selectedAddress, "8.8.8.8");
  assert.equal((await fixture(absent).resolver.resolve("example.com")).addresses.length, 1);
  await assert.rejects(fixture(absent, absent).resolver.resolve("example.com"));
});

for (const values of [[], ["8.8.8.8", "127.0.0.1"], ["10.0.0.1"], ["bad"], ["::ffff:8.8.8.8"],
  ["2606:4700::1"], ["8.8.8.8", "8.8.8.8"], Array(33).fill("8.8.8.8"), Array(1)]) {
  test(`rejects complete invalid IPv4 results ${JSON.stringify(values)}`, async () => {
    const {resolver, state} = fixture(async () => values);
    await assert.rejects(resolver.resolve("example.com")); assert.equal(state.cancelled, 1);
    assert.equal(state.calls.length, 2);
  });
}
for (const code of ["ETIMEOUT", "ENOTFOUND", "ESERVFAIL", "ECANCELLED"]) {
  test(`rejects partial observations on ${code} without fallback`, async () => {
    const {resolver, state} = fixture(undefined, () => Promise.reject(Object.assign(new Error("synthetic DNS failure"), {code})));
    await assert.rejects(resolver.resolve("example.com")); assert.equal(state.created, 1);
    assert.equal(state.calls.length, 2); assert.equal(state.cancelled, 1);
  });
}
test("rejects private IPv6, combined overflow and canonical duplicates", async () => {
  for (const v6 of [["fc00::1"], ["2606:4700::1", "2606:4700:0:0:0:0:0:1"]]) {
    await assert.rejects(fixture(undefined, async () => v6).resolver.resolve("example.com"));
  }
  const v4 = Array.from({length: 32}, (_, index) => `8.8.8.${index + 1}`);
  await assert.rejects(fixture(async () => v4).resolver.resolve("example.com"));
});
test("does not execute backend result accessors", async () => {
  let reads = 0;
  const values = Object.defineProperty([], "0", {get() {reads++; return "8.8.8.8";}});
  await assert.rejects(fixture(async () => values).resolver.resolve("example.com"));
  assert.equal(reads, 0);
});
test("invalid hosts and clocks cause no DNS IO", async () => {
  const {resolver, state} = fixture();
  for (const host of ["", "EXAMPLE.com", "example.com.", "127.0.0.1", "https://example.com", "a b"]) {
    await assert.rejects(resolver.resolve(host));
  }
  state.now = Number.NaN; await assert.rejects(resolver.resolve("example.com"));
  assert.equal(state.created, 0);
});
test("deadline rejection cancels pending DNS and late completion cannot return evidence", async () => {
  let finish!: (addresses: string[]) => void;
  const {resolver, state} = fixture(() => new Promise(resolve => {finish = resolve;}), absent,
    async (_deadline, operation) => {void operation().catch(() => {}); throw new Error("deadline");});
  await assert.rejects(resolver.resolve("example.com"), /deadline/);
  assert.equal(state.cancelled, 1); finish(["8.8.8.8"]);
});
test("completion at deadline or clock rollback fails closed", async () => {
  for (const now of [100, -1]) {
    const {resolver, state} = fixture(async () => {state.now = now; return ["8.8.8.8"];}, absent);
    await assert.rejects(resolver.resolve("example.com")); assert.equal(state.cancelled, 1);
  }
});
test("does not publish a partial family while the other is pending", async () => {
  let finish!: (addresses: string[]) => void;
  let published = false;
  const {resolver} = fixture(undefined, () => new Promise(resolve => {finish = resolve;}));
  const pending = resolver.resolve("example.com").then(value => {published = true; return value;});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(published, false);
  finish(["2606:4700::1"]);
  assert.equal((await pending).addresses.length, 2);
});
test("invalid configuration is rejected before backend construction", () => {
  let created = 0;
  const clock: HttpEgressClock = {now: () => 0, within: async (_deadline, operation) => operation()};
  for (const invalid of [{timeoutMs: 0}, {timeoutMs: 30_001}, {timeoutMs: 1.5},
    {resolverIdentity: ""}, {resolverEpoch: "\n"}]) {
    assert.throws(() => new NodeHttpEgressTrustedResolver({...options, ...invalid}, clock,
      () => {created++; throw new Error("unexpected backend");}));
  }
  assert.equal(created, 0);
});
