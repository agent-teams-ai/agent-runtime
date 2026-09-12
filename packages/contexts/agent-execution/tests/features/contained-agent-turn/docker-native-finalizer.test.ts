import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import test from "node:test";
import {nativeFinalizerFixture} from "./support/docker-native-finalizer-fixture.ts";
import {createDockerCodexNativeBrokerFinalizer as composedFinalizer} from "../../../dist/composition.js";
import {createDockerCodexNativeBrokerFinalizer} from "../../../dist/features/contained-agent-turn/composition/docker-codex-native-broker-finalizer.js";
import {codexNativeBrokerLaunchInput, isCodexNativeBrokerLaunchPlan}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";

test("component evidence: actual joined native plan, Docker paths, sole reader and authenticated broker", async t => {
  const f = await nativeFinalizerFixture(t); const running = f.start();
  assert.deepEqual(await running.prepare(), {kind: "prepared"}, String(f.error));
  const prepared = running.owner.takePrepared(f.f.claimed);
  assert.equal(prepared.launch, f.finishInput.launch); assert.equal(prepared.providerIo, f.finishInput.providerIo);
  assert.equal(isCodexNativeBrokerLaunchPlan(prepared.plan), true);
  assert.notEqual(prepared.plan, f.originalPlan);
  const material = codexNativeBrokerLaunchInput(prepared.plan);
  assert.equal(material.recipe.endpoint, "http://172.30.0.1:43129/backend-api/codex");
  assert.equal(material.recipe.catalogPath, "/agent-private/home/models.json");
  const config = readFileSync(`${f.codexHome}/config.toml`, "utf8");
  assert.ok(config.includes('"/agent-private/home" = "deny"'));
  assert.equal(config.includes(material.localCapability), false);
  assert.equal(f.prepareIoCount, 1); assert.equal(f.f.events.filter(x => x === "host-handshake").length, 1);
  assert.equal(f.f.events.includes("provider-exec"), false);
  const receipt = await running.finalizer.execute(f.operation(material.localCapability));
  assert.equal(receipt.outcome, "completed");
  assert.equal(f.session.materializer.renders, 1);
  assert.equal(f.egress.observations.dispatches, 1);
  assert.equal(f.consumes, 1); assert.equal(f.reservations.length, 1);
  const wire = Buffer.from(f.egress.observations.dispatchedRequests[0]!).toString();
  assert.equal(wire.includes(material.localCapability), false);
  assert.ok(wire.includes("synthetic-upstream-only"));
  await assert.rejects(running.finalizer.finishClaimed(f.finishInput));
});

for (const key of ["providerAccess", "runtimeSecurity", "materializer", "verifier", "resolver", "transport", "journal", "ids"] as const) {
  test(`component evidence: absent ${key} owner refuses before allocation`, async t => {
    const f = await nativeFinalizerFixture(t);
    assert.throws(() => createDockerCodexNativeBrokerFinalizer({...f.input, session: {...f.input.session, [key]: {}}} as never));
    assert.deepEqual(f.f.events, []); assert.deepEqual(f.f.network.state.calls, []); assert.deepEqual(f.writes, []);
  });
}

test("component evidence: factory inert, missing file/route owners and accessor input refused", async t => {
  const f = await nativeFinalizerFixture(t);
  assert.equal(composedFinalizer, createDockerCodexNativeBrokerFinalizer);
  const owner = createDockerCodexNativeBrokerFinalizer(f.input);
  assert.deepEqual(f.f.events, []); assert.deepEqual(f.writes, []);
  assert.deepEqual(Object.keys(owner).toSorted(), ["cutoff", "execute", "finishClaimed", "routeAdmission"]);
  for (const input of [{...f.input, nativeFiles: {}}, {...f.input, routeAdmission: {}}]) {
    assert.throws(() => createDockerCodexNativeBrokerFinalizer(input as never));
  }
  let reads = 0;
  assert.throws(() => createDockerCodexNativeBrokerFinalizer({...f.input, get session() {reads += 1; return f.session;}}));
  assert.equal(reads, 0);
  await assert.rejects(owner.execute({} as never));
});

for (const attack of ["plan-copy", "foreign-io", "foreign-route", "provider-generation", "wrong-home", "foreign-claim"] as const) {
  test(`component evidence: ${attack} cannot publish or install native material`, async t => {
    const f = await nativeFinalizerFixture(t);
    if (attack === "provider-generation") {f.input.session.providerAccessSnapshot.credentialGeneration += 1;}
    const running = f.start(undefined, input => {
      switch (attack) {
        case "plan-copy": return {...input, originalPlan: {...input.originalPlan}};
        case "foreign-io": return {...input, providerIo: {...input.providerIo}};
        case "foreign-route": return {...input, routeFirstWrite: {...input.routeFirstWrite}};
        case "wrong-home": return {...input, record: {...input.record, boundary: {...input.record.boundary, codexHome: "/foreign"}}};
        case "foreign-claim": return {...input, claimed: {...input.claimed, committedDispatchProof: {...input.claimed.committedDispatchProof, projectId: "foreign"}}};
        default: return input;
      }
    });
    assert.notEqual((await running.prepare()).kind, "prepared");
    assert.deepEqual(f.writes, []); assert.throws(() => running.owner.takePrepared(f.f.claimed));
    assert.ok(f.f.physical.seals > 0);
    assert.equal(f.f.events.filter(x => x === "remove").length, 1);
    assert.notEqual((await running.prepare()).kind, "prepared");
  });
}

test("component evidence: installed route refusal never reaches finalization", async t => {
  const f = await nativeFinalizerFixture(t); f.f.route.lease = undefined;
  const running = f.start(); assert.notEqual((await running.prepare()).kind, "prepared");
  assert.deepEqual(f.writes, []); assert.equal(f.finishInput, undefined);
});

test("component evidence: cancellation during native file work closes ingress and awaits late work", async t => {
  const f = await nativeFinalizerFixture(t); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const install = f.input.nativeFiles.install;
  f.input.nativeFiles.install = async recipe => {entered.resolve(); await release.promise; await install(recipe);};
  const running = f.start(); const work = running.prepare(); await entered.promise;
  f.f.controller.abort(); assert.ok(f.f.physical.seals > 0);
  assert.throws(() => f.finishInput.http.openIngress());
  release.resolve(); assert.notEqual((await work).kind, "prepared");
  assert.throws(() => running.owner.takePrepared(f.f.claimed));
  assert.equal(f.f.events.includes("provider-exec"), false);
});

test("component evidence: failed file validation keeps cleanup debt and one-use admission", async t => {
  const f = await nativeFinalizerFixture(t); const install = f.input.nativeFiles.install;
  f.input.nativeFiles.install = async recipe => {await install(recipe); writeFileSync(`${f.codexHome}/models.json`, "wrong");};
  f.f.route.release = "quarantined";
  const running = f.start(); assert.deepEqual(await running.prepare(), {kind: "quarantined"});
  assert.deepEqual(await running.owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "quarantined"});
  await assert.rejects(running.finalizer.finishClaimed(f.finishInput));
  assert.equal(f.writes.length, 1); assert.throws(() => running.owner.takePrepared(f.f.claimed));
});

test("component evidence: captured file, route and credential methods keep their original receivers", async t => {
  const f = await nativeFinalizerFixture(t); const install = f.input.nativeFiles.install;
  let calls = 0;
  const files = {marker: "original", async install(recipe: Parameters<typeof install>[0]) {
    assert.equal(this.marker, "original"); calls += 1; await install(recipe);
  }};
  const owner = createDockerCodexNativeBrokerFinalizer({...f.input, nativeFiles: files});
  files.install = async () => {throw new Error("replaced installer");};
  f.input.routeAdmission.admit = async () => {throw new Error("replaced admission");};
  const render = f.session.materializer.render;
  f.session.materializer.render = async () => {throw new Error("replaced renderer");};
  const running = f.start(owner); assert.deepEqual(await running.prepare(), {kind: "prepared"}, String(f.error));
  const plan = running.owner.takePrepared(f.f.claimed).plan;
  assert.equal(calls, 1);
  assert.equal((await owner.execute(f.operation(codexNativeBrokerLaunchInput(plan).localCapability))).outcome, "completed");
  assert.equal(f.session.materializer.renders, 1); f.session.materializer.render = render;
});

for (const failure of ["bad-capability", "custody-cancel", "resource-cutoff"] as const) {
  test(`component evidence: ${failure} closes broker admission without upstream writes`, async t => {
    const f = await nativeFinalizerFixture(t); const running = f.start();
    assert.deepEqual(await running.prepare(), {kind: "prepared"}, String(f.error));
    const plan = running.owner.takePrepared(f.f.claimed).plan;
    if (failure === "custody-cancel") {f.f.controller.abort();}
    if (failure === "resource-cutoff") {f.finishInput.http.cutoff();}
    const capability = failure === "bad-capability" ? "wrong" : codexNativeBrokerLaunchInput(plan).localCapability;
    const outcome = await running.finalizer.execute(f.operation(capability)).then(receipt => receipt.outcome, () => "rejected");
    assert.notEqual(outcome, "completed");
    assert.equal(f.egress.observations.dispatches, 0);
    assert.equal(f.f.events.includes("provider-exec"), false);
    assert.ok(f.f.physical.seals > 0);
  });
}


test("component evidence: failure after genuine session binding cuts the session and retained HTTP resources", async t => {
  const f = await nativeFinalizerFixture(t);
  let bound = false;
  const running = f.start(undefined, input => ({...input, http: {...input.http, bindSession(dependencies) {
    const session = input.http.bindSession(dependencies); bound = true;
    writeFileSync(`${f.codexHome}/models.json`, "changed after session bind");
    return session;
  }}}));
  assert.notEqual((await running.prepare()).kind, "prepared");
  assert.equal(bound, true); assert.ok(f.f.physical.seals > 0);
  await assert.rejects(running.finalizer.execute({} as never));
  assert.equal(f.egress.observations.dispatches, 0);
});

for (const metadata of ["name", "length"] as const) {
  test(`component evidence: factory captures owners without reading function ${metadata}`, async t => {
    const f = await nativeFinalizerFixture(t);
    let reads = 0;
    for (const method of [f.input.nativeFiles.install, f.input.routeAdmission.admit,
      f.input.routeAdmission.releaseAfterContainerRemoval]) {
      Object.defineProperty(method, metadata, {get() {reads += 1; throw Error("metadata evaluated");}});
      Object.freeze(method);
    }
    const finalizer = createDockerCodexNativeBrokerFinalizer(f.input);
    assert.equal(reads, 0);
    assert.deepEqual(f.f.events, []);
    assert.deepEqual(f.writes, []);
    const running = f.start(finalizer);
    assert.deepEqual(await running.prepare(), {kind: "prepared"}, String(f.error));
    assert.equal(reads, 0);
  });
}

test("native cutoff is required, preserves receiver, and closes finalizer admission even when it throws", async t => {
  const f = await nativeFinalizerFixture(t);
  assert.throws(() => createDockerCodexNativeBrokerFinalizer({...f.input, cutoffNativeFiles: undefined!}));
  let cuts = 0; let failCutoff = true;
  const input = {...f.input, cutoffNativeFiles() {
    assert.strictEqual(this, input); cuts += 1;
    if (failCutoff) {throw new Error("native cutoff failed");}
  }};
  const owner = createDockerCodexNativeBrokerFinalizer(input);
  const running = f.start(owner);
  assert.deepEqual(await running.prepare(), {kind: "prepared"}, String(f.error));
  const seals = f.f.physical.seals;
  assert.throws(() => owner.cutoff(), /native cutoff failed/);
  failCutoff = false; // The fixture performs a final disposal after the assertion.
  assert.equal(cuts, 1);
  assert.ok(f.f.physical.seals > seals);
  await assert.rejects(owner.execute({} as never));
  await assert.rejects(owner.finishClaimed({} as never));
});
