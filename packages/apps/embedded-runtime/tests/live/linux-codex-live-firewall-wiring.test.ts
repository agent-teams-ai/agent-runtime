import assert from "node:assert/strict";
import {test} from "node:test";
import {createLinuxCodexLiveFirewallWiring} from "./linux-codex-live-firewall-wiring.ts";
import type {FirewallCommand} from "./linux-codex-live-admin-firewall.ts";
import {networkFixture, call} from "@agent-teams/agent-execution/tests/fixtures/docker-operation-network-fixture.ts";
import {dockerHttpOperationNetworkRecipe} from
  "@agent-teams/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-network-resources.js";

import {createDockerOperationNetworkOwner} from
  "@agent-teams/agent-execution/dist/features/contained-agent-turn/composition/docker-operation-network-owner.js";
import {HostHttpEgressV4Journal} from
  "@agent-teams/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import {MemoryV4Storage} from "@agent-teams/agent-execution/tests/fixtures/host-http-egress-v4-fixture.ts";

// Synthetic command/listener boundaries only; no socket, daemon or firewall IO.
async function fixture() {
  const engine = networkFixture();
  const owner = createDockerOperationNetworkOwner(engine.resourceInput);
  const journal = new HostHttpEgressV4Journal(new MemoryV4Storage(), engine.subject, owner.observationOwner);
  await journal.prepare(`command:${"a".repeat(64)}`);
  await owner.allocate(journal, engine.current, call());
  engine.attach();
  owner.retainContainer(engine.container);
  const context = owner.listenerContext;
  const subject = engine.subject;
  const recipe = dockerHttpOperationNetworkRecipe(subject);
  const raw = engine.state.network;
  const state = {events: [] as string[], rule: [] as string[], deleteFails: false,
    closeState: "closed" as "closed" | "unknown", failOpen: false, failInsert: false,
    beforeInspect: async () => {}, afterInsert: () => {}};
  const command: FirewallCommand = async (tool, argv) => {
    state.events.push(`${tool}:${argv.join(" ")}`);
    if (tool === "docker") {
      if (argv.includes("info")) {return JSON.stringify({ID: "daemon"});}
      await state.beforeInspect(); return JSON.stringify([raw]);
    }
    if (tool === "ip") {return JSON.stringify([{ifname: `br-${context.networkId.slice(0, 12)}`, linkinfo: {info_kind: "bridge"},
      addr_info: [{family: "inet", local: "172.30.0.1", prefixlen: 16}]}]);}
    if (argv.includes("-S")) {return state.rule.length ? `-A INPUT ${state.rule.join(" ")}` : "";}
    if (argv.includes("-I")) {
      state.rule = argv.slice(argv.indexOf("INPUT") + 2); state.afterInsert();
      if (state.failInsert) {throw Error("lost acknowledgement");}
    } else if (argv.includes("-D")) {
      assert.deepEqual(argv.slice(argv.indexOf("INPUT") + 1), state.rule);
      if (state.deleteFails) {throw Error("pending deletion");} state.rule = [];
    } else {assert.ok(argv.includes("-C"));}
    return "";
  };
  type Listener = Parameters<ReturnType<typeof createLinuxCodexLiveFirewallWiring>>[0];
  const address = {address: "172.30.0.1", port: 43123, family: "IPv4" as const};
  const base = {async open() {state.events.push("open"); if (state.failOpen) {throw Error("bind failed");}
      return {address, close: base.close, sealAdmission: base.sealAdmission, observe: base.observe};},
    async close() {state.events.push("close"); return {state: state.closeState};},
    sealAdmission() {state.events.push("seal");},
    async settleAccepted() {return {state: "settled" as const};},
    observe: (() => {throw Error("No observation requested by deployment wrapper");}) as Listener["observe"]};
  const decorate = createLinuxCodexLiveFirewallWiring({command, hostEngine: {...subject.attempt} as never,
    daemonId: "daemon", socketPath: "/run/test-docker.sock"});
  const listener = decorate(base, subject, context);
  const cut = new AbortController();
  return {state, raw, listener, cut, open: () => listener.open(async () => {}, cut), recipe, address, context};
}

test("inert construction, bound endpoint, retained ID inspection with populated membership, listener-first exact cleanup", async () => {
  const f = await fixture(); assert.deepEqual(f.state.events, []);
  const opened = await f.open();
  assert.deepEqual(opened.address, f.address);
  assert.equal(Object.keys(f.raw.Containers).length, 1);
  assert.equal(f.state.events.some(e => e.endsWith("network inspect " + f.recipe.name)), false);
  assert.ok(f.state.events.some(e => e.endsWith("network inspect " + f.context.networkId)));
  assert.equal(f.state.rule[f.state.rule.indexOf("--dport") + 1], "43123");
  assert.equal((await opened.close()).state, "closed");
  assert.equal(f.state.rule.length, 0);
  assert.ok(f.state.events.indexOf("close") < f.state.events.findIndex(e => e.includes(" -D ")));
  await assert.rejects(f.open());
});

test("failed bind makes no command; failed install retains rollback handle for retry", async () => {
  const bind = await fixture(); bind.state.failOpen = true;
  await assert.rejects(bind.open()); assert.deepEqual(bind.state.events, ["open"]);
  assert.equal((await bind.listener.close()).state, "closed");
  const f = await fixture(); f.state.failInsert = true; f.state.deleteFails = true;
  await assert.rejects(f.open());
  assert.equal((await f.listener.close()).state, "unknown"); assert.ok(f.state.rule.length);
  f.state.deleteFails = false;
  assert.equal((await f.listener.close()).state, "closed"); assert.equal(f.state.rule.length, 0);
});

test("abort after insertion refuses publication and removes only retained rule", async () => {
  const f = await fixture(); f.state.afterInsert = () => f.cut.abort();
  await assert.rejects(f.open());
  assert.equal((await f.listener.close()).state, "closed"); assert.equal(f.state.rule.length, 0);
});

test("close during pending lookup joins opening; uncertain listener close remains retryable", async () => {
  const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  f.state.beforeInspect = async () => {entered.resolve(); await resume.promise;};
  const opening = f.open(); const rejected = assert.rejects(opening); await entered.promise;
  const closing = f.listener.close(); resume.resolve(); await rejected;
  assert.equal((await closing).state, "closed"); assert.equal(f.state.rule.length, 0);
  const uncertain = await fixture(); await uncertain.open(); uncertain.state.closeState = "unknown";
  assert.equal((await uncertain.listener.close()).state, "unknown");
  uncertain.state.closeState = "closed";
  assert.equal((await uncertain.listener.close()).state, "closed");
});

test("lookup substitution and operation-label mismatch cannot install a rule", async () => {
  for (const mutate of [(f: Awaited<ReturnType<typeof fixture>>) => {f.raw.Id = "c".repeat(64);},
    (f: Awaited<ReturnType<typeof fixture>>) => {f.raw.Labels["com.agent-runtime.http.allocation"] = "d".repeat(64);},
    (f: Awaited<ReturnType<typeof fixture>>) => {f.raw.Name = "other";},
    (f: Awaited<ReturnType<typeof fixture>>) => {f.raw.Labels = {...f.raw.Labels, "com.agent-runtime.http.operationSha256": "c".repeat(64)};}]) {
    const f = await fixture(); mutate(f); await assert.rejects(f.open());
    assert.equal(f.state.events.some(e => e.includes(" -I ")), false);
    assert.equal((await f.listener.close()).state, "closed");
  }
});
