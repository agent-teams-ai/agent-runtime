// Independent nft 1.0.9 listing fixtures from the existing exclusive-route tests.
// Simulates namespace tables only; it is not firewall or kernel qualification.
import assert from "node:assert/strict";
const NFT_1_0_9_PERMIT = `{"nftables":[
  {"metainfo":{"version":"1.0.9","release_name":"Old Doc Yak","json_schema_version":1}},
  {"table":{"family":"inet","name":"ar_provider_route_v1","handle":21}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"input","handle":1,
    "type":"filter","hook":"input","prio":300,"policy":"drop"}},
  {"rule":{"family":"inet","table":"ar_provider_route_v1","chain":"input","handle":5,"expr":[
    {"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"saddr"}},"right":"@broker"}},
    {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"sport"}},"right":18443}},
    {"match":{"op":"==","left":{"ct":{"key":"state"}},"right":"established"}}, {"accept":null}]}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"output","handle":2,
    "type":"filter","hook":"output","prio":300,"policy":"drop"}},
  {"rule":{"family":"inet","table":"ar_provider_route_v1","chain":"output","handle":4,"expr":[
    {"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"daddr"}},"right":"@broker"}},
    {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":18443}}, {"accept":null}]}},
  {"chain":{"family":"inet","table":"ar_provider_route_v1","name":"forward","handle":3,
    "type":"filter","hook":"forward","prio":300,"policy":"drop"}},
  {"set":{"family":"inet","table":"ar_provider_route_v1","name":"broker","type":"ipv4_addr","handle":6,
    "flags":["timeout"],"elem":[{"elem":{"val":"172.30.0.1","timeout":8,"expires":7}}]}}
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
const persistentKernel = (options: {now: () => number}) => {
  let transactions = 0;
  let present = false;
  let ruleCounts: Record<string, number> = {input: 0, output: 0};
  let timeoutSeconds = 8; let insertedAt = 10;
  const rules = (): any[] => ruleCounts.input === 0 && ruleCounts.output === 0 ? listing(false).nftables :
    listing().nftables.flatMap((entry: any) => entry.rule
      ? Array.from({length: ruleCounts[entry.rule.chain]}, () => structuredClone(entry)) : [entry]);
  const kernel = {
      transact(value: string) {
        transactions += 1;
        const batch = JSON.parse(value).nftables;
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
            const kind = object.chain ? "chain" : object.set ? "set" : "rule";
            const expected = listing().nftables.find((entry: any) => entry[kind] &&
              (kind === "chain" ? entry.chain.name === object.chain.name : kind === "set" || entry.rule.chain === object.rule.chain));
            const expectedBody = withoutHandle(expected[kind]);
            if (kind === "set") {
              timeoutSeconds = object.set.elem[0].elem.timeout;
              insertedAt = options.now();
              expectedBody.elem[0].elem.timeout = timeoutSeconds;
              delete expectedBody.elem[0].elem.expires;
            }
            assert.deepEqual(object[kind], expectedBody);
            if (object.rule) {nextCounts[object.rule.chain] += 1;}
          }
        }
        present = nextPresent; ruleCounts = nextCounts;
      },
      readRules() {
        assert.equal(present, true);
        const value = {nftables: rules()};
        const set = value.nftables.find((entry: any) => entry.set)?.set;
        if (set) {
          const remaining = timeoutSeconds * 1000 - ((options.now()) - insertedAt);
          if (remaining <= 0) {delete set.elem;} else {
            set.elem[0].elem.timeout = timeoutSeconds;
            set.elem[0].elem.expires = Math.floor(remaining / 1000);
          }
        }
        return value;
      },
    };
  return {kernel, counts: () => ({transactions}), rules};
};

export {persistentKernel};
