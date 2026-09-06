import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createAdmittedMaterialCredentialRenderingOwner } from "../../../dist/features/contained-turn-access/composition/credential-rendering-owner-factory.js";
import { createPostgresCredentialRenderingOwner } from "../../../dist/features/contained-turn-access/composition/postgres-credential-rendering-owner.js";
import { createOperationCredentialGenerationAcquisition } from "../../../dist/features/contained-turn-access/adapters/outbound/operation-credential-generation-acquisition.js";
import type { CredentialGenerationOutcome, CredentialGenerationRequest } from "../../../dist/features/contained-turn-access/adapters/outbound/credential-rendering-contracts.js";
import { erased, rendered, renderingFixture, selectorFor } from "./credential-rendering-test-fixture.ts";
import { acquired, acquisitionFixture, materialFor, permittedRequest, watchBytes, wipe } from "./operation-credential-material-fixture.ts";

for (const [recipe, names, values] of [
  ["codex-chatgpt", ["Authorization", "ChatGPT-Account-ID"], ["Bearer synthetic-token", "synthetic-account"]],
  ["codex-api", ["Authorization"], ["Bearer synthetic-key"]],
  ["claude-oauth", ["Authorization"], ["Bearer synthetic-key"]],
  ["claude-api", ["x-api-key"], ["synthetic-key"]],
] as const) {
  test(`${recipe}: concrete admission and real renderer serve two fresh HTTP authorizations`, async t => {
    const fixture = renderingFixture(recipe);
    const {owner, admission} = createAdmittedMaterialCredentialRenderingOwner(fixture.selection, fixture.dependencies);
    t.after(() => owner.dispose());
    assert.deepEqual(Object.keys(owner).sort(), ["authorization", "dispose", "rendering"]);
    assert.deepEqual(admission.admit(materialFor(fixture.selection)), {kind: "admitted"});
    const outputs = [];
    for (let index = 0; index < 2; index += 1) {
      const receipt = await fixture.fresh(owner, await fixture.request({authorizationRequestId: `request:success:${index}`}));
      const credentials = rendered(await owner.rendering.render(receipt)); outputs.push(credentials);
      assert.deepEqual(credentials.fields.map(field => field.name), names);
      assert.deepEqual(credentials.fields.map(field => new TextDecoder().decode(field.valueBytes)), values);
      assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
    }
    assert.deepEqual(fixture.events, Array.from({length: 6}, () => "pa-transaction"));
    assert.notEqual(outputs[0]!.fields[0]!.valueBytes.buffer, outputs[1]!.fields[0]!.valueBytes.buffer);
    owner.dispose();
    outputs.forEach(credentials => {
      assert.ok(credentials.fields[0]!.valueBytes.some(byte => byte !== 0));
      credentials.release(); credentials.release(); credentials.fields.forEach(field => erased(field.valueBytes));
    });
  });
}

test("foreign, cloned, historical and replayed receipts never reach concrete acquisition", async t => {
  const fixture = acquisitionFixture(); t.after(() => fixture.owner.dispose());
  fixture.source.admission.admit(materialFor(fixture.selection));
  const request = await fixture.request(); const receipt = await fixture.fresh(fixture.owner, request);
  const historical = await fixture.application.authorize(await fixture.request({authorizationRequestId: "request:historical"}));
  const replay = await fixture.owner.authorization.authorize(request);
  const observation = await fixture.owner.authorization.observe(selectorFor(request));
  for (const result of [historical, replay, observation]) {
    assert.ok("receipt" in result);
    if ("receipt" in result) {assert.deepEqual(await fixture.owner.rendering.render(result.receipt), {kind: "denied"});}
  }
  const foreign = acquisitionFixture(); t.after(() => foreign.owner.dispose());
  foreign.source.admission.admit(materialFor(foreign.selection));
  assert.deepEqual(await foreign.owner.rendering.render(receipt), {kind: "denied"});
  for (const fake of [{...receipt}, structuredClone(receipt), new Proxy(receipt, {})]) {
    assert.deepEqual(await fixture.owner.rendering.render(fake), {kind: "denied"});
  }
  assert.equal(fixture.results.length, 0); assert.equal(foreign.results.length, 0);
  rendered(await fixture.owner.rendering.render(receipt)).release();
  assert.equal(fixture.results.length, 1); assert.equal(fixture.requests[0]?.authorization, receipt);
  assert.ok(fixture.signals[0]?.aborted); // Normal per-call cleanup must leave operation seed available.
  rendered(await fixture.owner.rendering.render(await fixture.fresh(fixture.owner,
    await fixture.request({authorizationRequestId: "request:next"})))).release();
  assert.equal(fixture.results.length, 2);
});

test("current generation changes before and after concrete copying deny and erase seed plus copies", async t => {
  for (const phase of ["before", "after"] as const) {
    const fixture = acquisitionFixture(); t.after(() => fixture.owner.dispose());
    const input = materialFor(fixture.selection); const allocations = watchBytes(t);
    fixture.source.admission.admit(input); const seed = allocations.slice(0, 2);
    const receipt = await fixture.fresh(fixture.owner);
    if (phase === "before") {await fixture.control.replaceBindingHead({...fixture.head, credentialGeneration: 2});}
    else {fixture.hooks.after = async () => {await fixture.control.replaceBindingHead({...fixture.head, credentialGeneration: 2});};}
    assert.deepEqual(await fixture.owner.rendering.render(receipt), {kind: "denied"});
    assert.equal(fixture.results.length, phase === "before" ? 0 : 1);
    seed.forEach(erased);
    fixture.results.forEach(result => acquired(result).fields.forEach(field => erased(field.valueBytes)));
    if (phase === "after") {
      const renderedToken = allocations.filter(bytes => bytes.length === "Bearer synthetic-token".length);
      assert.equal(renderedToken.length, 1); renderedToken.forEach(erased);
    }
    await fixture.control.replaceBindingHead(fixture.head);
    assert.equal((await fixture.owner.authorization.authorize(await fixture.request({authorizationRequestId: "request:after-cutoff"}))).kind, "indeterminate");
    fixture.owner.dispose(); t.mock.restoreAll();
  }
});

test("authorization and observation retirement paths dispose the retained idle seed", async t => {
  for (const action of ["authorize-rejected", "authorize-error", "observe-rejected", "observe-error"] as const) {
    const fixture = renderingFixture(); let fail = false;
    const original = fixture.dependencies.repository.transact;
    fixture.dependencies.repository.transact = async (...args) => {if (fail) {throw new Error("synthetic unavailable");} return original(...args);};
    const {owner, admission} = createAdmittedMaterialCredentialRenderingOwner(fixture.selection, fixture.dependencies);
    const input = materialFor(fixture.selection); const allocations = watchBytes(t);
    assert.equal(admission.admit(input).kind, "admitted"); const seed = allocations.slice(0, 2);
    const command = await fixture.request();
    if (action.startsWith("observe")) {await fixture.fresh(owner, command);}
    if (action.endsWith("error")) {fail = true;}
    else {await fixture.control.replaceBindingHead({...fixture.head, revocation: "revoked"});}
    const result = action.startsWith("observe") ? await owner.authorization.observe(selectorFor(command)) : await owner.authorization.authorize(command);
    assert.equal(result.kind, action.endsWith("error") ? "indeterminate" : "rejected");
    seed.forEach(erased); owner.dispose(); t.mock.restoreAll();
  }
});

test("disposal and abort while concrete acquisition delivery is pending erase late outputs", async t => {
  for (const action of ["dispose", "abort"] as const) {
    const fixture = acquisitionFixture(); const input = materialFor(fixture.selection);
    const allocations = watchBytes(t); fixture.source.admission.admit(input); const seed = allocations.slice(0, 2);
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<CredentialGenerationOutcome>();
    fixture.hooks.delivery = () => {entered.resolve(); return gate.promise;};
    const receipt = await fixture.fresh(fixture.owner); const pending = fixture.owner.rendering.render(receipt);
    await entered.promise;
    if (action === "dispose") {fixture.owner.dispose();} else {fixture.controller.abort();}
    assert.deepEqual(await pending, {kind: "denied"}); seed.forEach(erased);
    const output = acquired(fixture.results[0]!);
    assert.ok(output.fields[0]!.valueBytes.some(byte => byte !== 0));
    gate.resolve(output); await nextTurn(); output.fields.forEach(field => erased(field.valueBytes));
    fixture.owner.dispose(); t.mock.restoreAll();
  }
});

test("per-call cancellation burns identity before allocation and preserves seed for another request", async t => {
  const fixture = acquisitionFixture(); t.after(() => fixture.owner.dispose());
  const input = materialFor(fixture.selection); const allocations = watchBytes(t);
  fixture.source.admission.admit(input); const seed = allocations.slice(0, 2);
  const request = await permittedRequest(fixture); const perCall = new AbortController(); perCall.abort();
  fixture.source.lifetime.acceptRequest(request);
  const before = allocations.length;
  await assert.rejects(fixture.source.acquisition.acquire(request, perCall.signal)); assert.equal(allocations.length, before);
  fixture.source.lifetime.acceptRequest(request);
  await assert.rejects(fixture.source.acquisition.acquire(request, new AbortController().signal));
  assert.ok(seed.every(bytes => bytes.some(byte => byte !== 0)));
  const fresh = await permittedRequest(fixture, "request:after-call-abort");
  fixture.source.lifetime.acceptRequest(fresh);
  wipe(acquired(await fixture.source.acquisition.acquire(fresh, new AbortController().signal)).fields);
});

test("allocation failure burns request identity and erases partial output without erasing operation seed", async t => {
  const fixture = acquisitionFixture(); t.after(() => fixture.owner.dispose());
  fixture.source.admission.admit(materialFor(fixture.selection));
  const request = await permittedRequest(fixture); fixture.source.lifetime.acceptRequest(request);
  const Native = Uint8Array; const output: Uint8Array[] = [];
  t.mock.method(globalThis, "Uint8Array", function (size: number) {
    if (output.length) {throw new Error("synthetic allocation failure");}
    const bytes = new Native(size); output.push(bytes); return bytes;
  } as never);
  await assert.rejects(fixture.source.acquisition.acquire(request, new AbortController().signal));
  assert.equal(output.length, 1); output.forEach(erased); t.mock.restoreAll();
  fixture.source.lifetime.acceptRequest(request);
  await assert.rejects(fixture.source.acquisition.acquire(request, new AbortController().signal));
  const fresh = await permittedRequest(fixture, "request:after-copy-failure"); fixture.source.lifetime.acceptRequest(fresh);
  wipe(acquired(await fixture.source.acquisition.acquire(fresh, new AbortController().signal)).fields);
});

test("bounded request ledger accepts 256 exact handoffs and never recycles consumed identities", async t => {
  const fixture = acquisitionFixture("codex-api"); t.after(() => fixture.owner.dispose());
  fixture.source.admission.admit(materialFor(fixture.selection));
  const request = await permittedRequest(fixture); const signal = new AbortController().signal;
  // Exercise the private adapter ceiling independently of the renderer's equal ceiling.
  for (let index = 0; index < 256; index += 1) {
    const next: CredentialGenerationRequest = Object.freeze({...request, authorization: Object.freeze({...request.authorization,
      authorizationRequestId: `request:bounded:${index}`})});
    fixture.source.lifetime.acceptRequest(next); wipe(acquired(await fixture.source.acquisition.acquire(next, signal)).fields);
  }
  fixture.source.lifetime.acceptRequest(request);
  await assert.rejects(fixture.source.acquisition.acquire(request, signal));
});

test("constructor snapshots metadata with no clock, repository, material, timer or listener activation", t => {
  const fixture = renderingFixture(); const input = materialFor(fixture.selection);
  const timer = t.mock.method(globalThis, "setTimeout", () => {throw new Error("synthetic constructor timer");});
  const clock = t.mock.method(performance, "now", () => {throw new Error("synthetic constructor clock");});
  const listener = t.mock.method(EventTarget.prototype, "addEventListener", () => {throw new Error("synthetic constructor listener");});
  const signal = t.mock.method(AbortSignal, "any", () => {throw new Error("synthetic constructor dependent signal");});
  const controller = t.mock.method(globalThis, "AbortController", () => {throw new Error("synthetic constructor controller");});
  const bytes = t.mock.method(globalThis, "Uint8Array", () => {throw new Error("synthetic constructor bytes");});
  const {owner, admission} = createAdmittedMaterialCredentialRenderingOwner(fixture.selection, fixture.dependencies);
  fixture.selection.operationRef = "operation:mutated";
  Object.defineProperty(fixture.selection.binding, "credentialGeneration", {value: 2});
  fixture.selection.deadline = 1;
  for (const spy of [timer, clock, listener, signal, controller, bytes]) {assert.equal(spy.mock.callCount(), 0);}
  assert.deepEqual(fixture.events, []); t.mock.restoreAll();
  assert.equal(admission.admit(input).kind, "admitted"); owner.dispose();
});

test("private Postgres assembly exposes bootstrap admission only through control, keeps legacy acquisition optional", t => {
  const fixture = renderingFixture(); let connects = 0;
  const pool = {async connect(): Promise<never> {connects += 1; throw new Error("synthetic pool not activated");}};
  const allocations = watchBytes(t);
  const concrete = createPostgresCredentialRenderingOwner(pool, fixture.selection);
  assert.equal(connects, 0); assert.deepEqual(Object.keys(concrete.owner).sort(), ["authorization", "dispose", "rendering"]);
  assert.equal(concrete.control.materialAdmission?.admit(materialFor(fixture.selection)).kind, "admitted");
  const seed = allocations.slice(-2); concrete.owner.dispose(); seed.forEach(erased); assert.equal(connects, 0);
  const legacy = createPostgresCredentialRenderingOwner(pool, fixture.selection, fixture.acquisition);
  assert.equal(Object.hasOwn(legacy.control, "materialAdmission"), false); legacy.owner.dispose();
  assert.equal(connects, 0); assert.deepEqual(fixture.events, []);
});

test("no admitted material stays unsupported and retirement permanently closes private admission", async () => {
  const fixture = renderingFixture();
  const {owner, admission} = createAdmittedMaterialCredentialRenderingOwner(fixture.selection, fixture.dependencies);
  const receipt = await fixture.fresh(owner);
  assert.deepEqual(await owner.rendering.render(receipt), {kind: "unsupported", reason: "credential_acquisition_unavailable"});
  const material = materialFor(fixture.selection);
  assert.equal(admission.admit(material).kind, "rejected"); wipe(material.fields); owner.dispose();
  const closed = createOperationCredentialGenerationAcquisition(fixture.selection); fixture.controller.abort();
  assert.equal(closed.admission.admit(materialFor(fixture.selection)).kind, "rejected"); closed.lifetime.dispose();
});

test("material stays outside PA authorization persistence and non-secret capability projections", async t => {
  const fixture = acquisitionFixture(); t.after(() => fixture.owner.dispose());
  const acknowledgement = fixture.source.admission.admit(materialFor(fixture.selection));
  const command = await fixture.request(); const receipt = await fixture.fresh(fixture.owner, command);
  rendered(await fixture.owner.rendering.render(receipt)).release();
  const persisted = await fixture.application.observe(selectorFor(command));
  assert.equal(persisted.kind, "observed");
  for (const projection of [acknowledgement, receipt, persisted, fixture.source.admission, fixture.owner.authorization]) {
    const text = JSON.stringify(projection);
    assert.ok(!text.includes("synthetic-token")); assert.ok(!text.includes("synthetic-account"));
    assert.ok(!text.includes("valueBytes"));
  }
  assert.equal(receipt.credentialBindingDigest, fixture.head.credentialBindingDigest);
});

test("operation cutoff during copying erases unreturned copies and operation seed", async t => {
  const fixture = acquisitionFixture(); const material = materialFor(fixture.selection);
  const seed = watchBytes(t); fixture.source.admission.admit(material); t.mock.restoreAll();
  const request = await permittedRequest(fixture); fixture.source.lifetime.acceptRequest(request);
  const Native = Uint8Array; const output: Uint8Array[] = [];
  t.mock.method(globalThis, "Uint8Array", function (size: number) {
    const bytes = new Native(size); output.push(bytes);
    if (output.length === 2) {fixture.controller.abort();}
    return bytes;
  } as never);
  await assert.rejects(fixture.source.acquisition.acquire(request, new AbortController().signal));
  assert.equal(output.length, 2); seed.forEach(erased); output.forEach(erased); fixture.owner.dispose();
});
