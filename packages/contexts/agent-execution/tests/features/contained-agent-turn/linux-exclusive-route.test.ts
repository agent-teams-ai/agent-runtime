import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { linuxExclusiveRouteRules, linuxExclusiveRouteRulesMatch, linuxExclusiveRouteSeccomp } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-exclusive-route-policy.js";
import { installLinuxExclusiveRoute, type LinuxExclusiveRouteBinding } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-exclusive-route-owner.js";
import { openNodeLinuxExclusiveRoute } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/node-linux-exclusive-route.js";

const endpoint = {address: "172.30.0.1", port: 18443};
const binding: LinuxExclusiveRouteBinding = {
  tenantId: "tenant:test", projectId: "project:test", scopeDigest: "scope:test", operationId: "operation:test",
  attemptId: "attempt:test", custodyId: "custody:test", sourceRevision: "f80683e31aa329c4a1eb3347efa45eb93b452f32",
  binaryRevision: "@openai/codex:0.150.1+linux-x64", hostBootId: "boot:test", executionGenerationId: "generation:test",
  adapterRevision: "adapter:test", capabilityManifestRevision: "manifest:test", authorityVectorDigest: "authority:test",
  providerAccountRef: "account:test", accessRef: "access:test", bindingRevision: 3, credentialBindingRef: "credential:test",
  providerRouteRef: "route:test", routeRevision: "revision:1", credentialBindingDigest: "pa-opaque-binding:test",
  credentialGeneration: 7,
};

type SyscallRule = {names: string[]; action: string; errnoRet?: number;
  args?: {index: number; value: number; valueTwo?: number; op: string}[]};
const syscallAllowed = (name: string, args: number[]): boolean => {
  const policy = JSON.parse(linuxExclusiveRouteSeccomp().json) as {syscalls: SyscallRule[]};
  return policy.syscalls.some(rule => rule.action === "SCMP_ACT_ALLOW" && rule.names.includes(name) &&
    (rule.args ?? []).every(arg => arg.op === "SCMP_CMP_EQ" ? args[arg.index] === arg.value :
      arg.op === "SCMP_CMP_MASKED_EQ" && ((args[arg.index] ?? 0) & arg.value) === arg.valueTwo));
};

test("synthetic syscall matrix excludes namespace, alternate socket, and io_uring bypasses", () => {
  const policy = JSON.parse(linuxExclusiveRouteSeccomp().json);
  assert.equal(policy.defaultAction, "SCMP_ACT_ERRNO");
  assert.deepEqual(policy.architectures, ["SCMP_ARCH_X86_64"]);
  for (const protocol of [0, 6]) {
    for (const flags of [0, 0x800, 0x80000, 0x80800]) {
      assert.equal(syscallAllowed("socket", [2, 1 | flags, protocol]), true);
    }
  }
  for (const args of [[10, 1, 6], [2, 2, 17], [2, 3, 0], [1, 1, 0], [16, 3, 0], [17, 3, 0], [2, 1, 17]]) {
    assert.equal(syscallAllowed("socket", args), false, JSON.stringify(args));
  }
  assert.equal(syscallAllowed("socketpair", [1, 1, 0]), true);
  for (const args of [[1, 2, 0], [1, 5, 0], [30, 1, 0], [2, 1, 0], [10, 1, 0]]) {
    assert.equal(syscallAllowed("socketpair", args), false, JSON.stringify(args));
  }
  assert.equal(syscallAllowed("clone", [0x3d0f00]), true); // ordinary pthread flags
  for (const flag of [0x80, 0x20000, 0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000, 0x40000000]) {
    assert.equal(syscallAllowed("clone", [flag | 17]), false);
  }
  for (const syscall of ["unshare", "setns", "mount", "umount2", "pivot_root", "chroot", "bpf",
    "ptrace", "pidfd_getfd", "process_vm_writev", "io_uring_setup", "io_uring_register", "io_uring_enter", "clone3"]) {
    assert.equal(syscallAllowed(syscall, []), false, syscall);
  }
  assert.equal(policy.syscalls.find((rule: SyscallRule) => rule.names.includes("clone3")).errnoRet, 38);
});

type Packet = {family: string; protocol: string; source: string; destination: string; sourcePort: number;
  destinationPort: number; state: string};
const packetAllowed = (hook: string, packet: Packet): boolean => {
  const entries = linuxExclusiveRouteRules(endpoint, true) as {rule?: {chain: string; expr: any[]}}[];
  const field = (left: any): unknown => {
    if (left.meta) {return left.meta.key === "nfproto" ? packet.family : packet.protocol;}
    if (left.ct) {return packet.state;}
    return ({saddr: packet.source, daddr: packet.destination, sport: packet.sourcePort,
      dport: packet.destinationPort} as Record<string, unknown>)[left.payload.field];
  };
  return entries.some(entry => entry.rule?.chain === hook && entry.rule.expr.every(expr =>
    expr.accept === null || (expr.match?.op === "==" && field(expr.match.left) === expr.match.right)));
};

test("synthetic packet matrix admits only the exact broker TCP endpoint and established replies", () => {
  const outbound: Packet = {family: "ipv4", protocol: "tcp", source: "172.30.0.2", destination: endpoint.address,
    sourcePort: 32000, destinationPort: endpoint.port, state: "new"};
  assert.equal(packetAllowed("output", outbound), true);
  for (const mutation of [{destination: "8.8.8.8"}, {destination: "172.30.0.3"}, {destination: "127.0.0.11"},
    {family: "ipv6", destination: "2001:4860:4860::8888"}, {protocol: "udp"}, {destinationPort: 53},
    {protocol: "udp", destinationPort: 53}, {protocol: "udp", destinationPort: 443}, {destinationPort: 2375},
    {destination: "127.0.0.1", destinationPort: 8080}]) {
    assert.equal(packetAllowed("output", {...outbound, ...mutation}), false, JSON.stringify(mutation));
  }
  assert.equal(packetAllowed("forward", outbound), false);
  const reply = {...outbound, source: endpoint.address, sourcePort: endpoint.port, destination: "172.30.0.2",
    destinationPort: 32000, state: "established"};
  assert.equal(packetAllowed("input", reply), true);
  assert.equal(packetAllowed("input", {...reply, state: "new"}), false);
  assert.equal(packetAllowed("input", {...reply, source: "172.30.0.3"}), false);
});

// Independently authored listing fixtures pinned to nftables 1.0.9 (Old Doc
// Yak), libnftables JSON schema 1 (libnftables-json(5), 2023-10-11). These are
// synthetic schema fixtures, not a live capture or platform qualification.
// Keep literal listing bytes independent of the transaction builder: nft lists
// input and its rules before output, even when output rules were added first.
const NFT_1_0_9_PERMIT = `{"nftables":[
  {"metainfo":{"version":"1.0.9","release_name":"Old Doc Yak","json_schema_version":1}},
  {"table":{"family":"inet","name":"ar_provider_route_v1","handle":21}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"input","handle":1,
    "type":"filter","hook":"input","prio":300,"policy":"drop"}},
  {"rule":{"family":"inet","table":"ar_provider_route_v1","chain":"input","handle":5,"expr":[
    {"match":{"op":"==","left":{"meta":{"key":"nfproto"}},"right":"ipv4"}},
    {"match":{"op":"==","left":{"meta":{"key":"l4proto"}},"right":"tcp"}},
    {"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"saddr"}},"right":"172.30.0.1"}},
    {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"sport"}},"right":18443}},
    {"match":{"op":"==","left":{"ct":{"key":"state"}},"right":"established"}}, {"accept":null}]}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"output","handle":2,
    "type":"filter","hook":"output","prio":300,"policy":"drop"}},
  {"rule":{"family":"inet","table":"ar_provider_route_v1","chain":"output","handle":4,"expr":[
    {"match":{"op":"==","left":{"meta":{"key":"nfproto"}},"right":"ipv4"}},
    {"match":{"op":"==","left":{"meta":{"key":"l4proto"}},"right":"tcp"}},
    {"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"daddr"}},"right":"172.30.0.1"}},
    {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":18443}}, {"accept":null}]}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"forward","handle":3,
    "type":"filter","hook":"forward","prio":300,"policy":"drop"}}
]}`;
const NFT_1_0_9_DENY = `{"nftables":[
  {"metainfo":{"version":"1.0.9","release_name":"Old Doc Yak","json_schema_version":1}},
  {"table":{"family":"inet","name":"ar_provider_route_v1","handle":22}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"input","handle":1,
    "type":"filter","hook":"input","prio":300,"policy":"drop"}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"output","handle":2,
    "type":"filter","hook":"output","prio":300,"policy":"drop"}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"forward","handle":3,
    "type":"filter","hook":"forward","prio":300,"policy":"drop"}}
]}`;
const listing = (permit = true): any => JSON.parse(permit ? NFT_1_0_9_PERMIT : NFT_1_0_9_DENY);
const withoutHandle = ({handle: _handle, ...body}: any): any => body;

// Persistent synthetic namespace state, shared across owner/AttemptId lifetimes.
// Models add's idempotence, create's exclusivity, and atomic batch failure.
// Readback always uses the independent listing fixtures, never command entries.
const persistentKernel = (options: {readFailure?: number; transactionFailure?: number; removed?: boolean;
  removeFailure?: boolean; releaseFailure?: boolean; mutateRead?: (value: any) => void;
  preexisting?: "deny" | "permit"} = {}) => {
  let transactions = 0; let reads = 0; let releases = 0; let removals = 0;
  let present = options.preexisting !== undefined;
  let ruleCounts: Record<string, number> = {input: options.preexisting === "permit" ? 1 : 0,
    output: options.preexisting === "permit" ? 1 : 0};
  const batches: any[] = [];
  const rules = (): any[] => ruleCounts.input === 0 && ruleCounts.output === 0 ? listing(false).nftables :
    listing().nftables.flatMap((entry: any) => entry.rule
      ? Array.from({length: ruleCounts[entry.rule.chain]}, () => structuredClone(entry)) : [entry]);
  const kernel = {
      transact(value) {
        transactions += 1;
        const batch = JSON.parse(value).nftables; batches.push(batch);
        let nextPresent = present; let nextCounts = {...ruleCounts};
        for (const command of batch) {
          const verb = Object.keys(command)[0]!; const object = command[verb];
          assert.equal(Object.keys(command).length, 1);
          if (object.table) {
            assert.deepEqual(object.table, {family: "inet", name: "ar_provider_route_v1"});
            if (verb === "delete") {
              assert.equal(nextPresent, true); nextPresent = false; nextCounts = {input: 0, output: 0};
            } else {
              assert.ok(verb === "add" || verb === "create");
              if (verb === "create" && nextPresent) {throw new Error("EEXIST: table already exists");}
              nextPresent = true;
            }
          } else {
            assert.equal(verb, "add"); assert.equal(nextPresent, true);
            const kind = object.chain ? "chain" : "rule";
            const expected = listing().nftables.find((entry: any) => entry[kind] &&
              (kind === "chain" ? entry.chain.name === object.chain.name : entry.rule.chain === object.rule.chain));
            assert.deepEqual(object[kind], withoutHandle(expected[kind]));
            if (object.rule) {nextCounts[object.rule.chain] += 1;}
          }
        }
        present = nextPresent; ruleCounts = nextCounts;
        if (options.transactionFailure === transactions) {throw new Error("synthetic acknowledgement loss");}
      },
      readRules() {
        reads += 1;
        if (options.readFailure === reads) {throw new Error("synthetic observation loss");}
        assert.equal(present, true);
        const value = {nftables: rules()};
        options.mutateRead?.(value); return value;
      },
      async containerRemoved() {removals += 1; if (options.removeFailure) {throw new Error("synthetic engine failure");}
        return options.removed ?? true;},
      releaseNamespace() {releases += 1; if (options.releaseFailure) {throw new Error("synthetic close failure");}},
    };
  return {kernel, batches, counts: () => ({transactions, reads, releases, removals}), rules};
};
const fixture = (options: Parameters<typeof persistentKernel>[0] = {}) => {
  let time = 10; const state = persistentKernel(options);
  const owner = installLinuxExclusiveRoute({binding, endpoint, lifetimeMs: 10_000,
    monotonicNow: () => time, kernel: state.kernel});
  return {...state, owner, advance: (value: number) => {time = value;}};
};

test("nft 1.0.9 listings compare chain identities independently of transaction order", () => {
  for (const permit of [false, true]) {
    const value = listing(permit);
    assert.equal(linuxExclusiveRouteRulesMatch(value, endpoint, permit), true);
    // Whole chain groups can be enumerated differently without changing policy.
    if (permit) {value.nftables = [value.nftables[0], value.nftables[1], value.nftables[6],
      value.nftables[4], value.nftables[5], value.nftables[2], value.nftables[3]];}
    else {value.nftables = [value.nftables[0], value.nftables[1], ...value.nftables.slice(2).toReversed()];}
    assert.equal(linuxExclusiveRouteRulesMatch(value, endpoint, permit), true);
    assert.equal(linuxExclusiveRouteRulesMatch(value, endpoint, !permit), false);
  }
});

test("listing validation rejects extra, missing, misidentified, reordered and weakened policy", () => {
  const mutations: ((value: any) => void)[] = [
    value => {value.extra = true;}, value => {value.nftables[0].metainfo.json_schema_version = 2;},
    value => {value.nftables.push(value.nftables[0]);}, value => {value.nftables[1].table.name = "other";},
    value => {value.nftables[1].table.family = "ip";}, value => {value.nftables[1].table.flags = ["dormant"];},
    value => {value.nftables[2].chain.policy = "accept";}, value => {value.nftables[2].chain.hook = "output";},
    value => {value.nftables[2].chain.name = "other";}, value => {value.nftables[2].chain.table = "other";},
    value => {value.nftables[2].chain.family = "ip";}, value => {value.nftables[2].chain.prio = 0;},
    value => {value.nftables[3].rule.chain = "output";}, value => {value.nftables[3].rule.table = "other";},
    value => {value.nftables[3].rule.family = "ip";}, value => {value.nftables[3].rule.expr.reverse();},
    value => {value.nftables[3].rule.expr.splice(2, 1);}, value => {value.nftables[3].rule.expr[4].match.right = "new";},
    value => {value.nftables[5].rule.expr[2].match.right = "172.30.0.3";},
    value => {value.nftables[5].rule.expr[3].match.right = 443;},
    value => {value.nftables[5].rule.expr[3].match.op = "!=";},
    value => {value.nftables.push({set: {family: "inet", table: "ar_provider_route_v1", name: "extra"}});},
    value => {value.nftables[1].table.handle = -1;}, value => {value.nftables.push(...Array.from({length: 17}, () => ({})));},
  ];
  // Missing/duplicated tables, chains and rules must all be rejected.
  for (let index = 1; index < listing().nftables.length; index += 1) {
    mutations.push(value => {value.nftables.splice(index, 1);}, value => {value.nftables.push(value.nftables[index]);});
  }
  for (const mutate of mutations) {
    const changed = listing(); mutate(changed);
    assert.equal(linuxExclusiveRouteRulesMatch(changed, endpoint, true), false, String(mutate));
  }
  // There is one permit rule per chain. Extra accept rules fail in either order;
  // moving the final verdict before its predicates also fails above.
  for (const index of [3, 4]) {
    const changed = listing(); const extra = structuredClone(changed.nftables[3]);
    extra.rule.expr = [{accept: null}]; changed.nftables.splice(index, 0, extra);
    assert.equal(linuxExclusiveRouteRulesMatch(changed, endpoint, true), false);
  }
  assert.throws(() => fixture({mutateRead: value => {value.nftables[2].chain.policy = "accept";}}), /kernel exclusive/u);
});

test("one-use byte authority binds every scope, revision, route and generation field", () => {
  const f = fixture();
  assert.deepEqual(f.counts(), {transactions: 1, reads: 1, releases: 0, removals: 0});
  for (const key of Object.keys(binding) as (keyof LinuxExclusiveRouteBinding)[]) {
    const changed = {...binding, [key]: typeof binding[key] === "number" ? binding[key] + 1 : `${binding[key]}-different`};
    assert.throws(() => f.owner.reserveFirstWrite(changed, `request:${key}`));
  }
  let gets = 0;
  assert.throws(() => f.owner.reserveFirstWrite(new Proxy(binding, {get() {gets += 1; throw new Error("trap");}}), "request:proxy"));
  assert.equal(gets, 0);
  const ticket = f.owner.reserveFirstWrite(binding, "request:1");
  assert.equal(ticket.consume(), true);
  assert.equal(ticket.consume(), false);
  assert.throws(() => f.owner.reserveFirstWrite(binding, "request:1"));
  const queued = f.owner.reserveFirstWrite(binding, "request:2");
  f.advance(1010);
  assert.equal(queued.consume(), false);
});

test("expiry, rollback, revocation, and kernel observation loss prevent application bytes", () => {
  for (const time of [9, 10_010, Number.NaN]) {
    const f = fixture(); const ticket = f.owner.reserveFirstWrite(binding, "request:1");
    f.advance(time); assert.equal(ticket.consume(), false);
    assert.throws(() => f.owner.reserveFirstWrite(binding, "request:2"));
  }
  const f = fixture({readFailure: 2}); const ticket = f.owner.reserveFirstWrite(binding, "request:1");
  assert.equal(ticket.consume(), false);
  assert.equal(f.rules().some(rule => rule.rule !== undefined), false);
  assert.throws(() => f.owner.reserveFirstWrite(binding, "request:2"));
  const revoked = fixture(); const pending = revoked.owner.reserveFirstWrite(binding, "request:1");
  assert.equal(revoked.owner.revoke(), "closed"); assert.equal(pending.consume(), false);
  let advance: ((time: number) => void) | undefined; let reads = 0;
  const delayed = fixture({mutateRead: () => {if (++reads === 2) {advance?.(1010);}}});
  advance = delayed.advance;
  assert.equal(delayed.owner.reserveFirstWrite(binding, "request:delayed-read").consume(), false);
});

test("observation loss and policy mismatch stay quarantined after successful deny and teardown", async () => {
  for (const failure of ["read", "policy"] as const) {
    let reads = 0;
    const f = fixture(failure === "read" ? {readFailure: 2} : {mutateRead(value) {
      if (++reads === 2) {value.nftables[2].chain.policy = "accept";}
    }});
    const first = f.owner.reserveFirstWrite(binding, "request:first");
    const queued = f.owner.reserveFirstWrite(binding, "request:queued");
    assert.equal(first.consume(), false);
    assert.equal(queued.consume(), false);
    assert.equal(f.rules().some(entry => entry.rule), false);
    assert.equal(f.counts().transactions, 2); // deny and its observation succeeded
    assert.equal(f.owner.revoke(), "quarantined");
    assert.equal(await f.owner.releaseAfterContainerRemoval(), "quarantined");
    assert.equal(f.counts().releases, 1);
    assert.equal(f.owner.revoke(), "quarantined");
    assert.equal(await f.owner.releaseAfterContainerRemoval(), "quarantined");
    assert.throws(() => f.owner.reserveFirstWrite(binding, "request:after-cleanup"));
  }
});

test("exclusive table creation rejects all existing tables and cannot revive a revoked attempt", () => {
  const state = persistentKernel();
  const install = (attemptId: string) => installLinuxExclusiveRoute({binding: {...binding, attemptId},
    endpoint, lifetimeMs: 1000, kernel: state.kernel, monotonicNow: () => 10});
  const first = install("attempt:first");
  const pending = first.reserveFirstWrite({...binding, attemptId: "attempt:first"}, "request:old");
  assert.equal(first.revoke(), "closed");
  assert.equal(pending.consume(), false);
  assert.throws(() => install("attempt:second"), /EEXIST/u);
  assert.equal(state.rules().some(entry => entry.rule), false);
  assert.throws(() => install("attempt:first"), /EEXIST/u);
  assert.equal(state.rules().some(entry => entry.rule), false);
  for (const preexisting of ["deny", "permit"] as const) {
    const existing = persistentKernel({preexisting});
    assert.throws(() => installLinuxExclusiveRoute({binding, endpoint, lifetimeMs: 1000,
      kernel: existing.kernel, monotonicNow: () => 10}), /EEXIST/u);
    assert.equal(existing.rules().some(entry => entry.rule), false);
    assert.equal(existing.batches.length, 2); // failed admission followed by deny-only replacement
    assert.deepEqual(existing.batches[0][0], {create: {table: {family: "inet", name: "ar_provider_route_v1"}}});
  }
});

test("binding shape, lease bounds and request inventory remain fail closed", () => {
  const f = fixture();
  const missing = {...binding} as any; delete missing.accessRef;
  const accessor = {...binding}; let gets = 0;
  Object.defineProperty(accessor, "accessRef", {enumerable: true, get() {gets += 1; return binding.accessRef;}});
  for (const invalid of [missing, {...binding, extra: "field"}, accessor,
    {...binding, credentialGeneration: 0}, {...binding, bindingRevision: 1.5}]) {
    assert.throws(() => f.owner.reserveFirstWrite(invalid, "request:bad-binding"));
  }
  assert.equal(gets, 0);
  for (const request of ["", "with space", "x".repeat(193)]) {
    assert.throws(() => f.owner.reserveFirstWrite(binding, request));
  }
  for (let index = 0; index < 256; index += 1) {f.owner.reserveFirstWrite(binding, `request:${index}`);}
  assert.throws(() => f.owner.reserveFirstWrite(binding, "request:over-limit"));
  for (const lifetimeMs of [0, 120_001, 1.5, Number.NaN]) {
    const state = persistentKernel();
    assert.throws(() => installLinuxExclusiveRoute({binding, endpoint, lifetimeMs,
      kernel: state.kernel, monotonicNow: () => 10}));
    assert.equal(state.counts().transactions, 0);
  }
});

test("lost installation acknowledgement attempts a deny cut while preserving the primary failure", () => {
  const transactions: any[] = []; const primary = new Error("synthetic primary failure");
  assert.throws(() => installLinuxExclusiveRoute({binding, endpoint, lifetimeMs: 1000, monotonicNow: () => 10,
    kernel: {
      transact(value) {transactions.push(JSON.parse(value)); throw transactions.length === 1 ? primary : new Error("synthetic cleanup failure");},
      readRules() {throw new Error("must not issue a lease after unknown installation");},
      containerRemoved: async () => false,
      releaseNamespace() {throw new Error("campaign still owns container cleanup");},
    }}), error => error === primary);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[1].nftables.some((command: any) => command.add?.rule !== undefined), false);
  assert.equal(transactions[1].nftables.filter((command: any) => command.add?.chain?.policy === "drop").length, 3);
  for (const failure of [{transactionFailure: 1}, {readFailure: 1}]) {
    const state = persistentKernel(failure);
    assert.throws(() => installLinuxExclusiveRoute({binding, endpoint, lifetimeMs: 1000,
      monotonicNow: () => 10, kernel: state.kernel}), /synthetic.*loss/u);
    assert.equal(state.counts().transactions, 2);
    assert.equal(linuxExclusiveRouteRulesMatch(state.kernel.readRules(), endpoint, false), true);
  }
});

test("independent teardown revokes first, verifies removal, and quarantines all unknown cleanup", async () => {
  const f = fixture();
  const results = await Promise.all([f.owner.releaseAfterContainerRemoval(), f.owner.releaseAfterContainerRemoval()]);
  assert.deepEqual(results, ["closed", "closed"]);
  assert.deepEqual(f.counts(), {transactions: 2, reads: 2, releases: 1, removals: 1});
  for (const options of [{removed: false}, {removeFailure: true}, {releaseFailure: true}, {transactionFailure: 2}, {readFailure: 2}]) {
    const failed = fixture(options);
    assert.equal(await failed.owner.releaseAfterContainerRemoval(), "quarantined");
    assert.equal(failed.counts().removals, 1);
    assert.equal(failed.counts().releases, options.removed === false || options.removeFailure ? 0 : 1);
    assert.throws(() => failed.owner.reserveFirstWrite(binding, "request:after-close"));
  }
  const options = {removed: false}; const delayed = fixture(options);
  assert.equal(await delayed.owner.releaseAfterContainerRemoval(), "quarantined");
  assert.equal(delayed.counts().releases, 0);
  options.removed = true;
  assert.equal(await delayed.owner.releaseAfterContainerRemoval(), "quarantined");
  assert.equal(delayed.counts().releases, 1);
});

// Intercept Node builtins only inside the test process. No root access, tool,
// namespace, Docker transport, or injectable production command runner is used.
const nodeFixture = (t: TestContext, options: {replaceTools?: boolean; drift?: "inode" | "device" | "pid" | "start";
  closeFailure?: boolean; hashDrift?: boolean} = {}) => {
  const state = persistentKernel(); const closed: number[] = []; const invocations: any[] = [];
  const files = new Map([["/synthetic/nsenter", Buffer.from("pinned-nsenter")], ["/synthetic/nft", Buffer.from("pinned-nft")]]);
  const descriptors = new Map<number, {path: string; bytes: Buffer}>();
  let nextFd = 40; let inspections = 0; let removed = false; let toolFailure: string | undefined;
  let hashed = false;
  const pin = (path: string) => ({path, sha256: createHash("sha256").update(files.get(path)!).digest("hex")});
  const nsenter = pin("/synthetic/nsenter"); const nft = pin("/synthetic/nft");
  const namespaceIdentity = {dev: 4, ino: 100};
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  t.mock.method(process, "geteuid", () => 0);
  t.mock.method(fs, "realpathSync", (path: string) => path);
  t.mock.method(fs, "openSync", (path: string, flags: number) => {
    const namespace = path === "/proc/321/ns/net";
    assert.equal(namespace || files.has(path), true);
    assert.equal(flags, namespace ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const fd = nextFd++; descriptors.set(fd, {path, bytes: files.get(path) ?? Buffer.alloc(0)}); return fd;
  });
  t.mock.method(fs, "fstatSync", (fd: number) => {
    const file = descriptors.get(fd); assert.ok(file);
    if (file.path === "/proc/321/ns/net") {return namespaceIdentity;}
    return {isFile: () => true, uid: 0, nlink: 1, mode: 0o100755, size: file.bytes.length,
      mtimeMs: options.hashDrift && hashed ? 2 : 1, ctimeMs: 1};
  });
  t.mock.method(fs, "readFileSync", (fd: number) => {
    assert.equal(typeof fd, "number"); hashed = true; return descriptors.get(fd)!.bytes;
  });
  t.mock.method(fs, "statSync", (path: string) => {
    if (path === "/proc/self/ns/net") {return {dev: 4, ino: 1};}
    assert.equal(path, "/proc/321/ns/net");
    return {...namespaceIdentity, ...(options.drift === "inode" ? {ino: 101} : {}),
      ...(options.drift === "device" ? {dev: 5} : {})};
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    closed.push(fd); assert.ok(descriptors.has(fd));
    if (options.closeFailure && fd === 42) {throw new Error("synthetic descriptor close failure");}
    descriptors.delete(fd);
  });
  t.mock.method(childProcess, "execFileSync", (path: string, args: string[], config: any) => {
    invocations.push({path, args, config});
    assert.equal(path, "/proc/self/fd/3");
    assert.deepEqual(args.slice(0, 3), ["--net=/proc/self/fd/5", "--", "/proc/self/fd/4"]);
    assert.deepEqual(config.stdio, ["pipe", "pipe", "pipe", 41, 42, 40]);
    assert.deepEqual(config.env, {PATH: "/usr/sbin:/usr/bin", LANG: "C", LC_ALL: "C"});
    assert.equal(config.timeout, 1000); assert.equal(config.maxBuffer, 65_536);
    assert.equal(descriptors.get(41)!.bytes.toString(), "pinned-nsenter");
    assert.equal(descriptors.get(42)!.bytes.toString(), "pinned-nft");
    if (config.input !== undefined) {
      assert.deepEqual(args.slice(3), ["-j", "-f", "-"]);
      assert.ok(Buffer.byteLength(config.input) < 65_536);
      state.kernel.transact(config.input); return Buffer.alloc(0);
    }
    assert.deepEqual(args.slice(3), ["-j", "list", "table", "inet", "ar_provider_route_v1"]);
    if (toolFailure) {const code = toolFailure; toolFailure = undefined; throw Object.assign(new Error(code), {code});}
    return Buffer.from(JSON.stringify(state.kernel.readRules()));
  });
  syncBuiltinESMExports();
  type Input = Parameters<typeof openNodeLinuxExclusiveRoute>[0];
  const authority = Object.fromEntries(["containerId", "daemonIdentitySha256", "daemonBootGenerationSha256",
    "createSpecificationSha256", "hostIdentitySha256", "hostBootGenerationSha256", "imageDigest",
    "launchFingerprintSha256", "operationNonceSha256", "ownerIdentitySha256"].map(key => [key, `synthetic:${key}`])) as unknown as Input["authority"];
  const engine: Input["engine"] = {async inspect(actual, call) {
    assert.deepEqual(actual, authority); assert.ok(call.signal instanceof AbortSignal);
    assert.ok(call.deadlineEpochMs <= Date.now() + 5000); inspections += 1;
    if (inspections === 2 && options.replaceTools) {
      files.set(nsenter.path, Buffer.from("replacement-nsenter")); files.set(nft.path, Buffer.from("replacement-nft"));
    }
    return {existence: removed ? "absent" : "present", authority,
      state: {running: true, hostPid: inspections > 1 && options.drift === "pid" ? 322 : 321,
        startedAt: inspections > 1 && options.drift === "start" ? "different" : "start:1"},
      resources: {seccompProfileSha256: linuxExclusiveRouteSeccomp().sha256}, engine: {cgroupVersion: "2"}} as any;
  }};
  return {...state, closed, invocations, descriptors,
    open: () => openNodeLinuxExclusiveRoute({authority, binding, endpoint, engine, lifetimeMs: 10_000, nsenter, nft}),
    remove: () => {removed = true;}, failNextTool: (code: string) => {toolFailure = code;}};
};
const nodeOnly = {skip: process.platform !== "linux" || process.arch !== "x64"};

test("Node route executes pinned descriptors after both tool paths are replaced", nodeOnly, async t => {
  const f = nodeFixture(t, {replaceTools: true}); const owner = await f.open();
  assert.equal(owner.reserveFirstWrite(binding, "request:pinned").consume(), true);
  assert.equal(f.invocations.length, 3);
  f.remove(); assert.equal(await owner.releaseAfterContainerRemoval(), "closed");
  assert.deepEqual(f.closed, [42, 41, 40]); assert.equal(f.descriptors.size, 0);
});

test("Node route rejects tool descriptor changes during digest verification", nodeOnly, async t => {
  const f = nodeFixture(t, {hashDrift: true});
  await assert.rejects(f.open(), /enforcement unavailable/u);
  assert.equal(f.invocations.length, 0); assert.deepEqual(f.closed, [41, 40]);
  assert.equal(f.descriptors.size, 0);
});

for (const drift of ["inode", "device", "pid", "start"] as const) {
  test(`Node route rejects namespace identity drift: ${drift}`, nodeOnly, async t => {
    const f = nodeFixture(t, {drift});
    await assert.rejects(f.open(), /enforcement unavailable/u);
    assert.equal(f.invocations.length, 0); assert.deepEqual(f.closed, [42, 41, 40]);
    assert.equal(f.descriptors.size, 0);
  });
}

for (const code of ["ETIMEDOUT", "ENOBUFS"]) {
  test(`Node route quarantines bounded tool failure ${code} despite later successful cleanup`, nodeOnly, async t => {
    const f = nodeFixture(t); const owner = await f.open();
    f.failNextTool(code);
    assert.equal(owner.reserveFirstWrite(binding, "request:tool-failure").consume(), false);
    assert.equal(f.rules().some(entry => entry.rule), false);
    assert.equal(owner.revoke(), "quarantined");
    f.remove(); assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
    assert.deepEqual(f.closed, [42, 41, 40]); assert.equal(f.descriptors.size, 0);
  });
}

test("Node route retains descriptors until removal and quarantines close failure", nodeOnly, async t => {
  const f = nodeFixture(t, {closeFailure: true}); const owner = await f.open();
  assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
  assert.deepEqual(f.closed, []);
  f.remove(); assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
  assert.deepEqual(f.closed, [42, 41, 40]); // one failure must not skip the other closes
  assert.equal(await owner.releaseAfterContainerRemoval(), "quarantined");
  assert.equal(owner.revoke(), "quarantined");
  assert.throws(() => owner.reserveFirstWrite(binding, "request:closed"));
});
