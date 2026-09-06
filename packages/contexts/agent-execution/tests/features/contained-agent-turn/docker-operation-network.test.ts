import assert from "node:assert/strict";
import test from "node:test";
import { DockerOperationNetwork } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-operation-network.js";
import { call, deferred, networkFixture } from "../../fixtures/docker-operation-network-fixture.ts";

test("reservation and fixed network naming are effect-free and snapshot generation", () => {
  const f = networkFixture(); const owner = f.open();
  assert.match(owner.name, /^ar-http-[a-f0-9]{64}$/u);
  assert.equal(f.state.calls.length, 0);
  assert.throws(() => new DockerOperationNetwork({...f.input,
    binding: {...f.input.binding, executionGenerationSha256: "e".repeat(64)}}));
  assert.throws(() => new DockerOperationNetwork({...f.input,
    binding: {...f.input.binding, operationSha256: "a".repeat(64)}}));
  assert.equal(f.state.calls.length, 0);
  let getterCalls = 0;
  assert.throws(() => new DockerOperationNetwork({...f.input, get binding() {getterCalls += 1; return f.input.binding;}}));
  assert.equal(getterCalls, 0);
});

test("actual internal network has exact allocation labels and is removed only by retained id", async () => {
  const f = networkFixture(); const owner = f.open();
  const observed = await owner.allocate(call());
  assert.equal(observed.networkId, f.networkId);
  assert.equal(observed.gateway, "172.30.0.1");
  assert.equal(observed.endpoint, null);
  const create = JSON.parse(Buffer.from(f.state.writes[0]!.body!).toString());
  assert.equal(create.Internal, true); assert.equal(create.Attachable, false);
  assert.equal(create.Labels["com.agent-runtime.http.operationSha256"], f.input.binding.operationSha256);
  assert.equal(create.Labels["com.agent-runtime.http.executionGenerationSha256"], f.input.binding.executionGenerationSha256);
  assert.equal(create.Labels["com.agent-runtime.http.launchFingerprintSha256"], f.container.launchFingerprintSha256);
  assert.match(create.Labels["com.agent-runtime.http.allocation"], /^[a-f0-9]{64}$/u);
  const first = owner.remove(call()); const duplicate = owner.remove(call());
  assert.equal(first, duplicate);
  assert.equal((await first).state, "absent");
  await owner.remove(call());
  assert.deepEqual(f.state.writes.map(value => [value.method, value.path]), [
    ["POST", "/v1.47/networks/create"], ["DELETE", `/v1.47/networks/${f.networkId}`],
  ]);
});

test("any preexisting network, including an exact previous owner snapshot, is rejected", async () => {
  const f = networkFixture(); await f.open().allocate(call());
  const writes = f.state.writes.length;
  const successor = f.open();
  await assert.rejects(successor.allocate(call()));
  assert.equal((await successor.remove(call())).state, "unknown");
  assert.equal(f.state.writes.length, writes);
  assert.ok(f.state.network);
});

for (const fault of ["lost", "malformed", "lost-before", "conflict"] as const) {
  test(`ambiguous create ${fault} never permits retry or name-only absence proof`, async () => {
    const f = networkFixture(); f.state.createFault = fault; const owner = f.open();
    await assert.rejects(owner.allocate(call()));
    assert.throws(() => owner.allocate(call()));
    const removed = await owner.remove(call());
    assert.equal(removed.state, fault === "lost" || fault === "malformed" ? "absent" : "unknown");
    assert.equal(owner.reconcileRequired, true);
    assert.equal(f.state.writes.filter(value => value.method === "POST").length, 1);
  });
}

for (const mutation of ["label", "shared", "driver", "internal", "id", "ipv6"] as const) {
  test(`foreign or changed network ${mutation} is never removed`, async () => {
    const f = networkFixture(); const owner = f.open(); await owner.allocate(call());
    switch (mutation) {
      case "label": f.state.network.Labels["com.agent-runtime.http.allocation"] = "1".repeat(64); break;
      case "shared": f.state.network.Containers = {["2".repeat(64)]: {EndpointID: "3".repeat(64)}}; break;
      case "driver": f.state.network.Driver = "overlay"; break;
      case "internal": f.state.network.Internal = false; break;
      case "id": f.state.network.Id = "4".repeat(64); break;
      case "ipv6": f.state.network.EnableIPv6 = true; break;
    }
    assert.equal((await owner.remove(call())).state, "unknown");
    assert.equal(f.state.writes.length, 1);
  });
}

test("Engine boot drift forbids cleanup on another daemon", async () => {
  const f = networkFixture(); const owner = f.open(); await owner.allocate(call());
  f.endpoint.daemonBootGenerationSha256 = "9".repeat(64);
  assert.equal((await owner.remove(call())).state, "unknown");
  assert.equal(f.state.writes.length, 1);
});

test("unknown inspection never becomes absence and may be reobserved without reallocating", async () => {
  const f = networkFixture(); const owner = f.open(); await owner.allocate(call());
  f.state.inspectFault = true;
  assert.equal((await owner.remove(call())).state, "unknown");
  await Promise.resolve(); f.state.inspectFault = false;
  assert.equal((await owner.remove(call())).state, "absent");
  assert.equal(owner.reconcileRequired, true);
});

for (const fault of ["lost", "lost-before"] as const) {
  test(`DELETE ${fault} preserves uncertainty without repeating a mutation`, async () => {
    const f = networkFixture(); const owner = f.open(); await owner.allocate(call());
    f.state.removeFault = fault;
    assert.equal((await owner.remove(call())).state, fault === "lost" ? "absent" : "unknown");
    await Promise.resolve(); await owner.remove(call());
    assert.equal(f.state.writes.filter(value => value.method === "DELETE").length, 1);
    assert.equal(owner.reconcileRequired, true);
  });
}

test("membership is bound to real launch, container id, sole network and endpoint", async () => {
  const f = networkFixture(); const owner = f.open(); await owner.allocate(call());
  assert.throws(() => owner.retainContainer({...f.container, launchFingerprintSha256: "1".repeat(64)}));
  owner.retainContainer(f.container); f.attach();
  const member = await owner.inspectMembership(call());
  assert.equal(member.endpoint?.containerId, f.container.containerId);
  assert.equal((await owner.remove(call())).state, "unknown");
  assert.equal(f.state.writes.length, 1, "attached/live container forbids DELETE");
  await Promise.resolve(); f.state.containerPresent = false; f.state.network.Containers = {};
  assert.equal((await owner.remove(call())).state, "absent");
});

for (const mismatch of ["endpoint", "network", "extra-network", "launch-label"] as const) {
  test(`matching names cannot substitute for actual container provenance: ${mismatch}`, async () => {
    const f = networkFixture(); const owner = f.open(); await owner.allocate(call()); owner.retainContainer(f.container); f.attach();
    const networks = f.state.containerRaw.NetworkSettings.Networks;
    if (mismatch === "endpoint") {networks[owner.name].EndpointID = "1".repeat(64);}
    if (mismatch === "network") {networks[owner.name].NetworkID = "2".repeat(64);}
    if (mismatch === "extra-network") {networks.shared = {...networks[owner.name]};}
    if (mismatch === "launch-label") {f.state.containerRaw.Config.Labels = {...f.state.containerRaw.Config.Labels,
      "com.agent-runtime.launch-fingerprint-sha256": "3".repeat(64)};}
    await assert.rejects(owner.inspectMembership(call()));
    assert.equal(owner.reconcileRequired, true);
  });
}

test("cancellation at every allocation IO await retains late allocations for independent cleanup", async () => {
  const baseline = networkFixture(); await baseline.open().allocate(call());
  const count = baseline.state.calls.length;
  assert.ok(count > 10);
  for (let stopAt = 1; stopAt <= count; stopAt += 1) {
    const f = networkFixture(); const owner = f.open(); const abort = new AbortController();
    let index = 0;
    f.state.after = async () => {if (++index === stopAt) {abort.abort();}};
    await assert.rejects(owner.allocate(call(abort.signal)), `IO boundary ${stopAt}`);
    const allocated = f.state.network !== undefined;
    f.state.after = async (_label, cleanup) => {assert.equal(cleanup.signal.aborted, false);};
    const result = await owner.remove(call());
    if (allocated) {assert.equal(result.state, "absent", `retained allocation at boundary ${stopAt}`);}
    assert.ok(f.state.writes.filter(value => value.method === "POST").length <= 1);
  }
});

test("cleanup waits for a late successful POST and seals the allocation slot first", async () => {
  const f = networkFixture(); const owner = f.open(); const reached = deferred(); const release = deferred();
  f.state.after = async label => {if (label === "POST /v1.47/networks/create") {reached.resolve(); await release.promise;}};
  const opening = owner.allocate(call()); const rejected = assert.rejects(opening); await reached.promise;
  const cleanup = owner.remove(call());
  let settled = false; void cleanup.then(() => {settled = true;});
  await Promise.resolve(); assert.equal(settled, false);
  release.resolve(); await rejected;
  assert.equal((await cleanup).state, "absent");
  assert.equal(f.state.network, undefined);
});

test("cancellation at every cleanup IO await preserves unknown and never repeats DELETE", async () => {
  const baseline = networkFixture(); const baseOwner = baseline.open(); await baseOwner.allocate(call());
  baseline.state.calls.length = 0; await baseOwner.remove(call());
  for (let stopAt = 1; stopAt <= baseline.state.calls.length; stopAt += 1) {
    const f = networkFixture(); const owner = f.open(); await owner.allocate(call());
    const abort = new AbortController(); let index = 0;
    f.state.after = async () => {if (++index === stopAt) {abort.abort();}};
    const result = await owner.remove(call(abort.signal));
    assert.equal(result.state, "unknown", `cleanup IO boundary ${stopAt}`);
    await Promise.resolve();
    f.state.after = async (_label, cleanup) => {assert.equal(cleanup.signal.aborted, false);};
    await owner.remove(call());
    assert.ok(f.state.writes.filter(value => value.method === "DELETE").length <= 1);
    assert.equal(owner.reconcileRequired, true);
  }
});

test("container label drift during network readback is caught by final launch inspection", async () => {
  const f = networkFixture(); const owner = f.open(); await owner.allocate(call()); owner.retainContainer(f.container); f.attach();
  let reads = 0;
  f.state.after = async label => {
    if (label === `GET /v1.47/containers/${f.container.containerId}/json` && ++reads === 2) {
      f.state.containerRaw.Config.Labels = {...f.state.containerRaw.Config.Labels,
        "com.agent-runtime.launch-fingerprint-sha256": "f".repeat(64)};
    }
  };
  await assert.rejects(owner.inspectMembership(call()));
  assert.equal(owner.reconcileRequired, true);
});
