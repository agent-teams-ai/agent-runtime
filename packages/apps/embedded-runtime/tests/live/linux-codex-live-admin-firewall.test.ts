import {strict as assert} from "node:assert";
import {test} from "node:test";
import {createLinuxCodexLiveAdminFirewall, createFirewallCommand,
  type ExpectedOwnedNetwork, type FirewallCommand} from "./linux-codex-live-admin-firewall.ts";
import {operationNetworkLabels, operationNetworkName} from
  "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-operation-network-codec.js";

// Entirely synthetic CLI boundary: no live firewall, Docker, provider or network IO.
function fixture() {
  const hash = "a".repeat(64);
  const binding = Object.fromEntries(["daemonIdentitySha256", "daemonBootGenerationSha256", "hostIdentitySha256",
    "hostBootGenerationSha256", "operationSha256", "executionGenerationSha256", "networkHandleSha256",
    "ownerIdentitySha256", "operationNonceSha256", "launchFingerprintSha256"].map(key => [key, hash])) as ExpectedOwnedNetwork["binding"];
  const expected: ExpectedOwnedNetwork = {binding, hostEngine: {...binding} as ExpectedOwnedNetwork["hostEngine"],
    daemonId: "test-daemon", socketPath: "/run/test-docker.sock", allocation: hash, networkId: "b".repeat(64)};
  const raw = {Id: expected.networkId, Name: operationNetworkName(binding), Driver: "bridge", Scope: "local",
    Internal: true, Attachable: false, Ingress: false, EnableIPv6: false,
    Labels: {...operationNetworkLabels(binding, expected.allocation)},
    Options: {"com.docker.network.bridge.enable_icc": "false"}, Containers: {},
    IPAM: {Driver: "default", Options: null, Config: [{Subnet: "172.30.0.0/16", Gateway: "172.30.0.1"}]}};
  const link = {ifname: "br-bbbbbbbbbbbb", linkinfo: {info_kind: "bridge"},
    addr_info: [{family: "inet", local: "172.30.0.1", prefixlen: 16}]};
  const state = {rule: [] as string[], lostInsert: false, deleteFails: false, readFails: false,
    afterInsert: () => {}, afterDelete: () => {}, calls: [] as {tool: string; args: string[]}[]};
  const command: FirewallCommand = async (tool, args) => {
    state.calls.push({tool, args: [...args]});
    if (tool === "docker") {return args.includes("info") ? JSON.stringify({ID: "test-daemon"}) : JSON.stringify([raw]);}
    if (tool === "ip") {return JSON.stringify([link]);}
    if (args.includes("-S")) {
      if (state.readFails) {throw Error("unknown inspection");}
      return "-P INPUT DROP\n-A INPUT -p tcp --dport 22 -j ACCEPT\n" + (state.rule.length ? `-A INPUT ${state.rule.join(" ")}\n` : "");
    }
    if (args.includes("-I")) {
      state.rule = args.slice(args.indexOf("INPUT") + 2); state.afterInsert();
      if (state.lostInsert) {throw Error("lost insert acknowledgement");}
    } else if (args.includes("-D")) {
      assert.deepEqual(args.slice(args.indexOf("INPUT") + 1), state.rule);
      if (state.deleteFails) {throw Error("delete unknown");} state.rule = []; state.afterDelete();
    } else if (args.includes("-C")) {
      assert.deepEqual(args.slice(args.indexOf("INPUT") + 1), state.rule);
    } else {throw Error("unexpected mutation");}
    return "";
  };
  return {expected, raw, link, state, owner: createLinuxCodexLiveAdminFirewall(command),
    endpoint: {address: "172.30.0.1", port: 43123, family: "IPv4"}};
}

test("only one owned bridge, subnet, gateway /32 and actual port; exact deletion and absence", async () => {
  const f = fixture();
  await f.owner.allow(f.endpoint, f.expected);
  assert.deepEqual(f.state.rule.slice(0, 12), ["-i", "br-bbbbbbbbbbbb", "-s", "172.30.0.0/16", "-d", "172.30.0.1/32",
    "-p", "tcp", "-m", "tcp", "--dport", "43123"]);
  assert.match(f.state.rule.join(" "), /--comment ar-test-host-[\w-]+ -j ACCEPT$/u);
  await assert.rejects(f.owner.allow(f.endpoint, f.expected));
  assert.equal(await f.owner.cleanup(), "removed");
  assert.equal(await f.owner.cleanup(), "removed");
  assert.equal(f.state.calls.filter(c => c.args.includes("-D")).length, 1);
  assert.equal(f.state.calls.at(-1)?.args.includes("-S"), true);
});

test("ownership, bridge and endpoint mismatches refuse all firewall writes", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {f.raw.Labels["com.agent-runtime.http.operationSha256"] = "c".repeat(64);},
    (f: ReturnType<typeof fixture>) => {f.expected = {...f.expected, hostEngine: {...f.expected.hostEngine, hostIdentitySha256: "c".repeat(64)}};},
    (f: ReturnType<typeof fixture>) => {f.raw.Id = "c".repeat(64);},
    (f: ReturnType<typeof fixture>) => {f.link.linkinfo.info_kind = "dummy";},
    (f: ReturnType<typeof fixture>) => {f.link.addr_info[0]!.prefixlen = 24;},
    (f: ReturnType<typeof fixture>) => {f.raw.IPAM.Config[0]!.Subnet = "0.0.0.0/0";},
    (f: ReturnType<typeof fixture>) => {f.endpoint.address = "0.0.0.0";},
    (f: ReturnType<typeof fixture>) => {f.endpoint.port = 0;},
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.owner.allow(f.endpoint, f.expected));
    assert.equal(f.state.calls.some(c => c.args.includes("-I")), false);
  }
});

test("lost insert acknowledgement retains uncertain rollback and retries exact rule", async () => {
  const f = fixture(); f.state.lostInsert = true; f.state.deleteFails = true;
  await assert.rejects(f.owner.allow(f.endpoint, f.expected), /lost insert/u);
  assert.equal(await f.owner.cleanup(), "pending");
  assert.ok(f.state.rule.length);
  f.state.deleteFails = false;
  assert.equal(await f.owner.cleanup(), "removed");
  assert.deepEqual(f.state.rule, []);
});

test("unknown readback remains pending after successful delete", async () => {
  const f = fixture(); await f.owner.allow(f.endpoint, f.expected);
  f.state.afterDelete = () => {f.state.readFails = true;};
  assert.equal(await f.owner.cleanup(), "pending");
  assert.deepEqual(f.state.rule, []);
  f.state.readFails = false;
  assert.equal(await f.owner.cleanup(), "removed");
});

test("cancellation after insert rolls back, close racing open is retained and serialized", async () => {
  const f = fixture(), controller = new AbortController();
  f.state.afterInsert = () => controller.abort();
  await assert.rejects(f.owner.allow(f.endpoint, f.expected, controller.signal));
  assert.deepEqual(f.state.rule, []);
  const g = fixture(); let close: Promise<string> | undefined;
  g.state.afterInsert = () => {close = g.owner.cleanup();};
  await assert.rejects(g.owner.allow(g.endpoint, g.expected));
  assert.equal(await close, "removed");
  assert.deepEqual(g.state.rule, []);
});

test("CLI rejects relative executable selection without launching anything", () => {
  assert.throws(() => createFirewallCommand({iptables: "iptables", ip: "/sbin/ip", docker: "/usr/bin/docker"}));
});
