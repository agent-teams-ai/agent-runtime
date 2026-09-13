import assert from "node:assert/strict";
import test from "node:test";
import {setImmediate as nextTurn} from "node:timers/promises";
import {types} from "node:util";
import {createCredentialMaterializationRequestDigest} from "@agent-teams/provider-access/composition";
import {createContainedTurnHttpCredentialMaterialization, createContainedTurnHttpProviderAccessAuthorization} from
  "../dist/composition/contained-turn-http-provider-access.js";
import {erased, generation, renderingFixture, selectorFor} from "../../support/external/provider-access/features/contained-turn-access/credential-rendering-test-fixture.ts";
import type {CredentialGenerationOutcome, CredentialGenerationRequest} from
  "@agent-teams/provider-access/composition";
import {hostWipe, pairedFixture, type HostReceipt} from "../../contained-turn-http-credential-materialization-fixture.ts";

const indexOf = (id: string) => Number(id.split(":").at(-1));
const unavailable = /^TypeError: HTTP Provider Access credential rendering unavailable$/u;
const eraseRaw = (raw: CredentialGenerationOutcome): void => {
  assert.equal(raw.kind, "acquired");
  if (raw.kind === "acquired") {raw.fields.forEach(field => erased(field.valueBytes));}
};

for (const [recipe, names, values] of [
  ["codex-chatgpt", ["authorization", "chatgpt-account-id"], ["Bearer fixture-pa", "fixture-account"]],
  ["codex-api", ["authorization"], ["Bearer fixture-key"]],
  ["claude-oauth", ["authorization"], ["Bearer fixture-key"]],
  ["claude-api", ["x-api-key"], ["fixture-key"]],
] as const) {
  test(`${recipe}: pairs original PA identity with detached Host receipt and transfers normalized dedicated copies`, async t => {
    const f = pairedFixture({recipe}); t.after(f.pair.dispose);
    assert.deepEqual(f.fixture.events, []);
    const detached = await f.fresh(); const original = f.outcomes[0];
    assert.ok(original?.kind === "authorized");
    assert.notEqual(detached, original.receipt); assert.deepEqual(detached, original.receipt);
    assert.ok(Object.isFrozen(detached)); assert.ok(Object.isFrozen(f.pair));
    const fields = await f.pair.materializer.render(detached); t.after(() => hostWipe(fields));
    assert.equal(f.renderInputs[0], original.receipt);
    assert.equal(f.fixture.requests[0]?.authorization, original.receipt);
    assert.equal(f.fixture.requests[0]?.operationRef, "operation:fixture");
    assert.equal(detached.credentialBindingDigest, "credential:digest:1");
    assert.deepEqual(f.fixture.events, ["pa-transaction", "pa-transaction", "acquire", "pa-transaction"]);
    assert.deepEqual(fields.map(field => field.name), names);
    assert.deepEqual(fields.map(field => new TextDecoder().decode(field.valueBytes)), values);
    assert.ok(Object.isFrozen(fields));
    fields.forEach((field, index) => {
      assert.ok(Object.isFrozen(field));
      assert.equal(field.valueBytes.buffer.byteLength, field.valueBytes.byteLength);
      assert.ok(field.valueBytes.buffer instanceof ArrayBuffer);
      assert.equal(field.valueBytes.buffer.resizable, false);
      assert.notEqual(field.valueBytes.buffer, f.renderedBuffers[index]?.buffer);
    });
    f.fixture.raw.forEach(eraseRaw); f.renderedBuffers.forEach(erased);
    f.pair.dispose(); f.pair.dispose(); assert.equal(f.disposals(), 1);
    assert.deepEqual(fields.map(field => new TextDecoder().decode(field.valueBytes)), values);
    hostWipe(fields); fields.forEach(field => erased(field.valueBytes));
    await assert.rejects(f.pair.materializer.render(detached), unavailable);
  });
}

test("real PA factory wrappers are native async and still work with authorization-only projection", async t => {
  const fixture = renderingFixture(); const owner = fixture.create(); t.after(owner.dispose);
  for (const method of [owner.authorization.authorize, owner.authorization.observe, owner.rendering.render]) {
    assert.equal(types.isAsyncFunction(method), true);
  }
  const authorization = createContainedTurnHttpProviderAccessAuthorization({authorization: owner.authorization,
    createRequestDigest: createCredentialMaterializationRequestDigest});
  const request = await fixture.request(); const {requestDigest, ...unsigned} = request;
  assert.equal(await authorization.createRequestDigest(unsigned), requestDigest);
  const first = await authorization.authorize(request); assert.equal(first.kind, "authorized");
  assert.equal((await authorization.authorize(request)).kind, "observed");
  if (first.kind === "authorized") {assert.deepEqual(await owner.rendering.render(first.receipt as never), {kind: "denied"});}
  assert.equal(fixture.requests.length, 0);
});

test("concurrent authorization and acquisition completion cannot exchange original receipts", async t => {
  const count = 8;
  const authorized = Array.from({length: count}, () => Promise.withResolvers<void>());
  const authorizationGates = Array.from({length: count}, () => Promise.withResolvers<void>());
  const acquired = Array.from({length: count}, () => Promise.withResolvers<CredentialGenerationRequest>());
  const acquisitionGates = Array.from({length: count}, () => Promise.withResolvers<CredentialGenerationOutcome>());
  const f = pairedFixture({
    async afterAuthorize(result) {
      assert.ok(result.kind === "authorized"); const index = indexOf(result.receipt.authorizationRequestId);
      authorized[index]!.resolve(); await authorizationGates[index]!.promise; return result;
    },
    acquisition: {async acquire(request) {
      const index = indexOf(request.authorization.authorizationRequestId);
      acquired[index]!.resolve(request); return acquisitionGates[index]!.promise;
    }},
  }); t.after(f.pair.dispose);
  const pending = Array.from({length: count}, (_, index) => f.fresh(`request:${index}`));
  await Promise.all(authorized.map(item => item.promise));
  const receipts: HostReceipt[] = [];
  for (let index = count - 1; index >= 0; index--) {
    authorizationGates[index]!.resolve(); receipts[index] = await pending[index]!;
  }
  const renders = receipts.map(receipt => f.pair.materializer.render(receipt));
  const requests = await Promise.all(acquired.map(item => item.promise));
  for (const [index, request] of requests.entries()) {
    const original = f.outcomes.find(result => "receipt" in result && result.receipt.authorizationRequestId === `request:${index}`);
    assert.ok(original?.kind === "authorized"); assert.equal(request.authorization, original.receipt);
    assert.notEqual(request.authorization, receipts[index]);
  }
  const raw = requests.map(generation);
  for (const index of [5, 1, 7, 0, 6, 2, 4, 3]) {
    acquisitionGates[index]!.resolve(raw[index]!); const fields = await renders[index]!;
    hostWipe(fields); await assert.rejects(f.pair.materializer.render(receipts[index]!), unavailable);
  }
  raw.forEach(eraseRaw); f.renderedBuffers.forEach(erased);
  assert.equal(f.renderInputs.length, count);
});

test("copied, forged, observed, replayed, unpaired and foreign receipts deny before PA rendering or acquisition", async t => {
  const f = pairedFixture(); const other = pairedFixture(); t.after(f.pair.dispose); t.after(other.pair.dispose);
  const receipt = await f.fresh(); const request = await f.fixture.request();
  const replay = await f.pair.providerAccess.authorize(request);
  const observed = await f.pair.providerAccess.observe(selectorFor(request));
  const independent = createContainedTurnHttpProviderAccessAuthorization({authorization: f.pa.authorization,
    createRequestDigest: createCredentialMaterializationRequestDigest});
  const unpaired = await independent.authorize(await f.fixture.request({authorizationRequestId: "request:unpaired"}));
  assert.equal(replay.kind, "observed"); assert.equal(observed.kind, "observed"); assert.equal(unpaired.kind, "authorized");
  let traps = 0; const trap = () => {traps++; throw new Error("fixture trap");};
  const original = f.outcomes[0]; assert.ok(original?.kind === "authorized");
  const fakes = [{...receipt}, structuredClone(receipt), {...receipt, requestDigest: "forged"}, original.receipt,
    new Proxy(receipt, {get: trap, ownKeys: trap}), Object.defineProperty({}, "decision", {get: trap}),
    {}, null, undefined, "request:fixture", ...[replay, observed, unpaired].flatMap(result => "receipt" in result ? [result.receipt] : [])];
  const before = f.fixture.events.length;
  for (const fake of fakes) {await assert.rejects(f.pair.materializer.render(fake as never), unavailable);}
  await assert.rejects(other.pair.materializer.render(receipt), unavailable);
  assert.equal(traps, 0); assert.equal(f.fixture.events.length, before);
  assert.equal(f.renderInputs.length, 0); assert.equal(other.renderInputs.length, 0); assert.equal(f.fixture.requests.length, 0);
  const results = await Promise.allSettled(Array.from({length: 20}, () => f.pair.materializer.render(receipt)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 19);
  results.forEach(result => {if (result.status === "fulfilled") {hostWipe(result.value);}});
  assert.equal(f.fixture.requests.length, 1); assert.equal(f.renderInputs.length, 1);
});

test("current PA revocation between authorization and rendering denies before acquisition and burns the pair", async t => {
  const f = pairedFixture(); t.after(f.pair.dispose); const receipt = await f.fresh();
  await f.fixture.control.replaceBindingHead({...f.fixture.head, revocation: "revoked"});
  await assert.rejects(f.pair.materializer.render(receipt), unavailable);
  assert.equal(f.fixture.requests.length, 0); assert.equal(f.renderInputs.length, 1);
  await f.fixture.control.replaceBindingHead(f.fixture.head);
  await assert.rejects(f.pair.materializer.render(receipt), unavailable);
  assert.equal((await f.pair.providerAccess.authorize(await f.fixture.request({authorizationRequestId: "request:new"}))).kind, "indeterminate");
  assert.equal(f.renderInputs.length, 1);
});

test("failed exact-data projection never registers a render capability", async t => {
  const f = pairedFixture({async afterAuthorize(result) {
    assert.ok(result.kind === "authorized"); return {...result, receipt: {...result.receipt, extra: true}};
  }}); t.after(f.pair.dispose);
  assert.deepEqual(await f.pair.providerAccess.authorize(await f.fixture.request()), {kind: "indeterminate"});
  const original = f.outcomes[0]; assert.ok(original?.kind === "authorized");
  await assert.rejects(f.pair.materializer.render(original.receipt), unavailable);
  assert.equal(f.renderInputs.length, 0); assert.equal(f.fixture.requests.length, 0);
});

for (const failure of ["first-allocation", "second-allocation", "validation", "release", "dispose-during-copy"] as const) {
  test(`${failure}: failure erases partial Host copies and releases every PA buffer`, async t => {
    const NativeBytes = Uint8Array; const copies: Uint8Array[] = []; let allocations = 0;
    let restore: (() => void) | undefined; let releases = 0;
    const f = pairedFixture({async afterRender(result) {
      assert.ok(result.kind === "rendered");
      if (failure === "validation") {result.credentials.fields[1]!.valueBytes[0] = 13;}
      const mocked = t.mock.method(globalThis, "Uint8Array", function (length: number) {
        allocations++;
        if (failure === "first-allocation" || (failure === "second-allocation" && allocations === 2)) {throw new Error("fixture copy failure");}
        const bytes = new NativeBytes(length); copies.push(bytes);
        if (failure === "dispose-during-copy") {f.pair.dispose();}
        return bytes;
      } as never); restore = () => mocked.mock.restore();
      return {kind: "rendered", credentials: {fields: result.credentials.fields, release() {
        releases++; result.credentials.release();
        if (failure === "release") {throw new Error("fixture release failure");}
      }}};
    }}); t.after(f.pair.dispose);
    const receipt = await f.fresh();
    try {await assert.rejects(f.pair.materializer.render(receipt), unavailable);} finally {restore?.();}
    assert.equal(releases, 1); assert.equal(copies.length, failure === "first-allocation" ? 0 : failure === "second-allocation" ? 1 : 2);
    copies.forEach(erased); f.renderedBuffers.forEach(erased); f.fixture.raw.forEach(eraseRaw);
    await assert.rejects(f.pair.materializer.render(receipt), unavailable); assert.equal(f.fixture.requests.length, 1);
  });
}

for (const cutoff of ["dispose", "abort"] as const) {
  for (const completion of ["resolve", "reject"] as const) {
    test(`${cutoff} while acquisition is pending: ${completion} is drained and admission cannot reopen`, async t => {
      const gate = Promise.withResolvers<CredentialGenerationOutcome>();
      const entered = Promise.withResolvers<{request: CredentialGenerationRequest; signal: AbortSignal}>();
      const f = pairedFixture({acquisition: {async acquire(request, signal) {entered.resolve({request, signal}); return gate.promise;}}});
      t.after(f.pair.dispose); const receipt = await f.fresh();
      const pending = f.pair.materializer.render(receipt); const {request, signal} = await entered.promise;
      if (cutoff === "dispose") {f.pair.dispose();} else {f.fixture.controller.abort();}
      await assert.rejects(pending, unavailable); assert.equal(signal.aborted, true);
      const late = generation(request);
      if (completion === "resolve") {gate.resolve(late);} else {gate.reject(new Error("fixture acquisition rejection"));}
      await nextTurn();
      if (completion === "resolve") {eraseRaw(late);}
      else if (late.kind === "acquired") {hostWipe(late.fields);}
      assert.equal(f.renderedBuffers.length, 0);
      await assert.rejects(f.pair.materializer.render(receipt), unavailable);
      assert.deepEqual(await f.pair.providerAccess.authorize(await f.fixture.request({authorizationRequestId: "request:later"})), {kind: "indeterminate"});
      if (cutoff === "dispose") {
        assert.equal(f.disposals(), 1);
        assert.deepEqual(await f.pair.providerAccess.observe(selectorFor(request.authorization)), {kind: "indeterminate"});
        const {requestDigest: _digest, ...unsigned} = await f.fixture.request();
        await assert.rejects(f.pair.providerAccess.createRequestDigest(unsigned), /digest unavailable/u);
      }
    });
  }
}

test("disposal after PA transfer but before the paired continuation releases PA buffers without copying", async t => {
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  const f = pairedFixture({async afterRender(result) {entered.resolve(); await gate.promise; return result;}});
  t.after(f.pair.dispose); const receipt = await f.fresh(); const pending = f.pair.materializer.render(receipt);
  await entered.promise; assert.ok(f.renderedBuffers.every(bytes => bytes.some(byte => byte !== 0)));
  f.pair.dispose(); gate.resolve(); await assert.rejects(pending, unavailable);
  f.renderedBuffers.forEach(erased); f.fixture.raw.forEach(eraseRaw);
});

test("disposal while authorization projection is pending suppresses the late receipt and all later owner calls", async t => {
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  const f = pairedFixture({async afterAuthorize(result) {entered.resolve(); await gate.promise; return result;}});
  t.after(f.pair.dispose); const request = await f.fixture.request();
  const pending = f.pair.providerAccess.authorize(request); await entered.promise;
  f.pair.dispose(); gate.resolve(); assert.deepEqual(await pending, {kind: "indeterminate"});
  const original = f.outcomes[0]; assert.ok(original?.kind === "authorized");
  await assert.rejects(f.pair.materializer.render(original.receipt), unavailable);
  assert.deepEqual(await f.pa.rendering.render(original.receipt), {kind: "denied"});
  const events = f.fixture.events.length;
  assert.deepEqual(await f.pair.providerAccess.authorize(request), {kind: "indeterminate"});
  assert.deepEqual(await f.pair.providerAccess.observe(selectorFor(request)), {kind: "indeterminate"});
  assert.equal(f.fixture.events.length, events); assert.equal(f.renderInputs.length, 0);
});

test("pair construction rejects non-native async, proxy and extra capabilities without invocation", t => {
  const f = pairedFixture(); t.after(f.pair.dispose); let calls = 0;
  const forbidden = () => {calls++; return Promise.reject(new Error("fixture must never run"));};
  const trap = () => {calls++; throw new Error("fixture trap");};
  for (const capability of ["authorize", "observe", "render", "digest"] as const) {
    const owner = capability === "render" ? {...f.owner, rendering: {render: forbidden}} :
      capability === "digest" ? f.owner : {...f.owner, authorization: {...f.owner.authorization, [capability]: forbidden}};
    assert.throws(() => createContainedTurnHttpCredentialMaterialization(owner as never,
      capability === "digest" ? forbidden : createCredentialMaterializationRequestDigest), /Invalid HTTP Provider Access owner/u);
  }
  for (const owner of [new Proxy(f.owner, {ownKeys: trap}), {...f.owner, extra: true},
    Object.defineProperty({...f.owner}, "rendering", {get: trap}), {...f.owner, rendering: {...f.owner.rendering, extra: true}},
    {...f.owner, rendering: {render: new Proxy(f.owner.rendering.render, {apply: trap})}}]) {
    assert.throws(() => createContainedTurnHttpCredentialMaterialization(owner, createCredentialMaterializationRequestDigest), /Invalid HTTP Provider Access owner/u);
  }
  assert.equal(calls, 0); assert.equal(f.disposals(), 0); assert.deepEqual(f.fixture.events, []);
});
