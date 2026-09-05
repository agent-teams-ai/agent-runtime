import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createContainedTurnCredentialRenderingOwner } from "../../../dist/features/contained-turn-access/composition/credential-rendering-owner-factory.js";
import type {
  CredentialGenerationAcquisition, CredentialGenerationOutcome, CredentialGenerationRequest, CredentialRecipe,
} from "../../../dist/features/contained-turn-access/adapters/outbound/credential-rendering-contracts.js";
import type { AuthorizeCredentialMaterializationInput } from "../../../dist/index.js";
import { erased, generation, rendered, renderingFixture, selectorFor, syntheticBytes } from "./credential-rendering-test-fixture.ts";

for (const [recipe, names, values] of [
  ["codex-chatgpt", ["Authorization", "ChatGPT-Account-ID"], ["Bearer fixture-pa", "fixture-account"]],
  ["codex-api", ["Authorization"], ["Bearer fixture-key"]],
  ["claude-oauth", ["Authorization"], ["Bearer fixture-key"]],
  ["claude-api", ["x-api-key"], ["fixture-key"]],
] as const) {
  test(`${recipe}: existing PA application authorizes once, reobserves twice, renders exact fields`, async () => {
    const fixture = renderingFixture(recipe);
    const owner = fixture.create();
    const receipt = await fixture.fresh(owner);
    const credentials = rendered(await owner.rendering.render(receipt));
    assert.deepEqual(fixture.events, ["pa-transaction", "pa-transaction", "acquire", "pa-transaction"]);
    assert.deepEqual(credentials.fields.map(field => field.name), names);
    assert.deepEqual(credentials.fields.map(field => new TextDecoder().decode(field.valueBytes)), values);
    assert.equal(fixture.requests[0]?.authorization, receipt);
    assert.equal(fixture.requests[0]?.authorization.credentialBindingDigest, "credential:digest:1");
    assert.equal(fixture.requests[0]?.operationRef, "operation:fixture");
    for (const raw of fixture.raw) {if (raw.kind === "acquired") {raw.fields.forEach(field => erased(field.valueBytes));}}
    owner.dispose();
    // Successful buffers belong to the recipient, including across owner disposal.
    assert.ok(credentials.fields.every(field => field.valueBytes.some(byte => byte !== 0)));
    credentials.release(); credentials.release();
    credentials.fields.forEach(field => erased(field.valueBytes));
    assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
  });
}

test("replay, observation and historical authorization cannot independently acquire", async () => {
  const fixture = renderingFixture();
  const owner = fixture.create();
  const request = await fixture.request();
  const receipt = await fixture.fresh(owner, request);
  const replay = await owner.authorization.authorize(request);
  const observation = await owner.authorization.observe(selectorFor(request));
  assert.equal(replay.kind, "observed"); assert.equal(observation.kind, "observed");
  for (const result of [replay, observation]) {
    if (result.kind === "observed") {assert.deepEqual(await owner.rendering.render(result.receipt), {kind: "denied"});}
  }
  const otherOwner = fixture.create();
  assert.deepEqual(await otherOwner.rendering.render(receipt), {kind: "denied"});
  assert.equal((await otherOwner.authorization.authorize(request)).kind, "observed");
  assert.equal(fixture.requests.length, 0);
  rendered(await owner.rendering.render(receipt)).release();
  const historical = await fixture.application.authorize(await fixture.request({authorizationRequestId: "request:historical"}));
  assert.equal(historical.kind, "authorized");
  if (historical.kind === "authorized") {assert.deepEqual(await owner.rendering.render(historical.receipt), {kind: "denied"});}
  owner.dispose(); otherOwner.dispose();
});

test("clones, forged receipts and every substituted identity lack same-owner capability", async () => {
  const fixture = renderingFixture();
  const owner = fixture.create();
  const receipt = await fixture.fresh(owner);
  const changes = {
    tenantId: "tenant:other", projectId: "project:other", scopeDigest: "scope:other", provider: "claude",
    providerAccountRef: "account:other", accessRef: "access:other", providerRouteRef: "route:other", bindingRevision: 2,
    credentialBindingRef: "credential:other", credentialBindingDigest: "ae:normalized:digest", credentialGeneration: 2,
    authorizationRequestId: "request:other", requestDigest: "digest:other", revocation: "revoked", availability: "unavailable",
    decision: "rejected", rejectionReason: "revoked",
  };
  for (const [key, value] of Object.entries(changes)) {
    assert.deepEqual(await owner.rendering.render({...receipt, [key]: value}), {kind: "denied"}, key);
  }
  for (const fake of [{...receipt}, structuredClone(receipt), {}, new Proxy(receipt, {})]) {
    assert.deepEqual(await owner.rendering.render(fake as never), {kind: "denied"});
  }
  assert.equal(fixture.requests.length, 0);
  rendered(await owner.rendering.render(receipt)).release();
  owner.dispose();
});

test("selection binds all owner fields before authorization and ignores later input mutation", async () => {
  const fixture = renderingFixture();
  const owner = fixture.create();
  const changes: Partial<AuthorizeCredentialMaterializationInput>[] = [
    {tenantId: "tenant:2"}, {projectId: "project:2"}, {scopeDigest: "scope:2"}, {provider: "claude"},
    {providerAccountRef: "account:2"}, {accessRef: "access:2"}, {providerRouteRef: "route:2"}, {bindingRevision: 2},
    {credentialBindingRef: "credential:2"}, {credentialBindingDigest: "ae:normalized"}, {credentialGeneration: 2},
    {revocation: "revoked"}, {availability: "unavailable"},
  ];
  for (const change of changes) {
    assert.deepEqual(await owner.authorization.authorize(await fixture.request(change)), {kind: "invalid", reason: "invalid_request"});
  }
  assert.equal(fixture.events.length, 0);
  const request = await fixture.request();
  const pending = owner.authorization.authorize(request);
  request.providerAccountRef = "caller:mutation";
  const result = await pending;
  assert.equal(result.kind, "authorized");
  if (result.kind === "authorized") {rendered(await owner.rendering.render(result.receipt)).release();}
  owner.dispose();
});

test("fresh unauthorized and invalid digest results never acquire", async () => {
  for (const change of [{revocation: "revoked" as const}, {availability: "unavailable" as const}, {credentialGeneration: 2}]) {
    const fixture = renderingFixture();
    await fixture.control.replaceBindingHead({...fixture.head, ...change});
    const owner = fixture.create();
    const result = await owner.authorization.authorize(await fixture.request());
    assert.equal(result.kind, "rejected");
    if (result.kind === "rejected") {assert.deepEqual(await owner.rendering.render(result.receipt), {kind: "denied"});}
    assert.equal(fixture.requests.length, 0); owner.dispose();
  }
  const fixture = renderingFixture();
  const owner = fixture.create();
  assert.equal((await owner.authorization.authorize({...await fixture.request(), requestDigest: "sha256:invalid"})).kind, "invalid");
  assert.equal(fixture.requests.length, 0); owner.dispose();
});

test("observed revocation and owner uncertainty permanently retire retained freshness", async () => {
  for (const kind of ["revoked", "indeterminate"] as const) {
    const fixture = renderingFixture();
    const original = fixture.dependencies.repository.transact;
    let unavailable = false;
    fixture.dependencies.repository.transact = async (...args) => {
      if (unavailable) {throw new Error("fixture unavailable");}
      return original(...args);
    };
    const owner = fixture.create();
    const request = await fixture.request();
    const receipt = await fixture.fresh(owner, request);
    if (kind === "revoked") {await fixture.control.replaceBindingHead({...fixture.head, revocation: "revoked"});}
    else {unavailable = true;}
    assert.equal((await owner.authorization.observe(selectorFor(request))).kind, kind === "revoked" ? "rejected" : "indeterminate");
    unavailable = false; await fixture.control.replaceBindingHead(fixture.head);
    assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
    assert.equal((await owner.authorization.authorize(await fixture.request({authorizationRequestId: "request:recovery"}))).kind, "indeterminate");
    assert.equal(fixture.requests.length, 0);
  }
});

test("PA missing binding and substituted materialization history fail before acquisition", async () => {
  for (const failure of ["missing", "history"] as const) {
    const fixture = renderingFixture();
    const original = fixture.dependencies.repository.transact; let reads = 0;
    fixture.dependencies.repository.transact = async (selector, work) => {
      reads += 1;
      return original(selector, transaction => work({
        ...transaction,
        async findBinding() {return failure === "missing" ? undefined : transaction.findBinding();},
        async findAuthorizationRequest() {
          const receipt = await transaction.findAuthorizationRequest();
          return receipt && reads > 1 ? {...receipt, authorizationRequestId: "request:substituted"} : receipt;
        },
      }));
    };
    const owner = fixture.create();
    const result = await owner.authorization.authorize(await fixture.request());
    if (failure === "missing") {assert.equal(result.kind, "rejected");}
    else {assert.equal(result.kind, "authorized");}
    if (result.kind === "authorized" || result.kind === "rejected") {assert.deepEqual(await owner.rendering.render(result.receipt), {kind: "denied"});}
    assert.equal(fixture.requests.length, 0); owner.dispose();
  }
});

test("abort after fresh authorization and late acquisition rejection cannot reacquire", async () => {
  const before = renderingFixture(); const closed = before.create();
  const receipt = await before.fresh(closed); before.controller.abort();
  assert.deepEqual(await closed.rendering.render(receipt), {kind: "denied"});
  assert.equal(before.requests.length, 0);
  const fixture = renderingFixture(); const gate = Promise.withResolvers<CredentialGenerationOutcome>();
  const entered = Promise.withResolvers<void>();
  const owner = fixture.create({acquire() {entered.resolve(); return gate.promise;}});
  const fresh = await fixture.fresh(owner); const pending = owner.rendering.render(fresh);
  await entered.promise; owner.dispose(); assert.deepEqual(await pending, {kind: "denied"});
  gate.reject(new Error("fixture-pa /fixture/provider-store")); await nextTurn();
  assert.deepEqual(await owner.rendering.render(fresh), {kind: "denied"});
});

const changedBindings = [
  {accessRef: "access:2"}, {providerAccountRef: "account:2"}, {providerRouteRef: "route:2"}, {bindingRevision: 2},
  {credentialBindingRef: "credential:2"}, {credentialBindingDigest: "credential:rotated"}, {credentialGeneration: 2},
  {revocation: "revoked" as const}, {availability: "unavailable" as const},
];
test("current binding change before acquisition denies with zero acquisition calls", async () => {
  for (const change of changedBindings) {
    const fixture = renderingFixture();
    const owner = fixture.create();
    const receipt = await fixture.fresh(owner);
    await fixture.control.replaceBindingHead({...fixture.head, ...change});
    assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
    assert.equal(fixture.requests.length, 0);
    await fixture.control.replaceBindingHead(fixture.head);
    assert.equal((await owner.authorization.authorize(await fixture.request({authorizationRequestId: "request:later"}))).kind, "indeterminate");
  }
});

test("binding changes during awaited acquisition deny and erase raw plus rendered copies", async () => {
  for (const change of changedBindings) {
    const fixture = renderingFixture();
    let acquired: CredentialGenerationOutcome | undefined;
    const owner = fixture.create({async acquire(request) {
      acquired = generation(request);
      await fixture.control.replaceBindingHead({...fixture.head, ...change});
      return acquired;
    }});
    const receipt = await fixture.fresh(owner);
    assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
    assert.ok(acquired?.kind === "acquired");
    if (acquired?.kind === "acquired") {acquired.fields.forEach(field => erased(field.valueBytes));}
    assert.deepEqual(fixture.events, ["pa-transaction", "pa-transaction", "pa-transaction"]);
  }
});

test("duplicate render is consumed synchronously before the first await", async () => {
  const fixture = renderingFixture();
  const owner = fixture.create();
  const receipt = await fixture.fresh(owner);
  const results = await Promise.all(Array.from({length: 40}, () => owner.rendering.render(receipt)));
  assert.equal(results.filter(result => result.kind === "rendered").length, 1);
  assert.equal(results.filter(result => result.kind === "denied").length, 39);
  assert.equal(fixture.requests.length, 1);
  results.forEach(result => {if (result.kind === "rendered") {result.credentials.release();}});
  owner.dispose();
});

test("bounded freshness ledger burns 256 admission slots without recycling", async () => {
  const fixture = renderingFixture("codex-api");
  const owner = fixture.create();
  const requests = await Promise.all(Array.from({length: 257}, (_, index) => fixture.request({authorizationRequestId: `request:${index}`})));
  const outcomes = await Promise.all(requests.map(request => owner.authorization.authorize(request)));
  assert.equal(outcomes.filter(outcome => outcome.kind === "authorized").length, 256);
  assert.equal(outcomes[256]?.kind, "indeterminate");
  const first = outcomes[0];
  assert.ok(first?.kind === "authorized");
  if (first?.kind === "authorized") {rendered(await owner.rendering.render(first.receipt)).release();}
  assert.equal((await owner.authorization.authorize(requests[256] as AuthorizeCredentialMaterializationInput)).kind, "indeterminate");
  owner.dispose();
});

test("missing and explicitly unsupported PA acquisition have typed denial without fallback", async () => {
  const fixture = renderingFixture();
  for (const acquisition of [undefined, {async acquire() {return {kind: "unsupported" as const};}}]) {
    const owner = createContainedTurnCredentialRenderingOwner(fixture.selection, fixture.dependencies, acquisition);
    const receipt = await fixture.fresh(owner, await fixture.request({authorizationRequestId: `request:${acquisition ? "explicit" : "absent"}`}));
    assert.deepEqual(await owner.rendering.render(receipt), {kind: "unsupported", reason: "credential_acquisition_unavailable"});
    assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
    owner.dispose();
  }
  assert.equal(fixture.requests.length, 0);
});

test("acquisition rejects with secret-safe canonical denial, no retry or receipt resurrection", async () => {
  const fixture = renderingFixture(); let calls = 0;
  const owner = fixture.create({async acquire() {calls += 1; throw new Error("fixture-pa /fixture/provider-store");}});
  const receipt = await fixture.fresh(owner);
  const outcome = await owner.rendering.render(receipt);
  assert.deepEqual(outcome, {kind: "denied"});
  assert.equal(JSON.stringify(outcome).includes("fixture"), false);
  assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
  assert.equal(calls, 1);
});

for (const cutoff of ["abort", "dispose", "deadline"] as const) {
  test(`${cutoff} during acquisition returns promptly, propagates abort, erases late completion`, async () => {
    const fixture = renderingFixture();
    if (cutoff === "deadline") {fixture.selection.deadline = performance.now() + 100;}
    const gate = Promise.withResolvers<CredentialGenerationOutcome>();
    const entered = Promise.withResolvers<CredentialGenerationRequest>();
    let acquisitionSignal: AbortSignal | undefined;
    const owner = fixture.create({acquire(request, signal) {acquisitionSignal = signal; entered.resolve(request); return gate.promise;}});
    const receipt = await fixture.fresh(owner);
    const pending = owner.rendering.render(receipt);
    const request = await entered.promise;
    if (cutoff === "abort") {fixture.controller.abort();}
    if (cutoff === "dispose") {owner.dispose();}
    assert.deepEqual(await pending, {kind: "denied"});
    assert.equal(acquisitionSignal?.aborted, true);
    const late = generation(request);
    gate.resolve(late); await nextTurn();
    if (late.kind === "acquired") {late.fields.forEach(field => erased(field.valueBytes));}
    assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
  });
}

test("abort before calls and synchronous abort inside acquisition fail closed", async () => {
  const fixture = renderingFixture();
  const owner = fixture.create(); fixture.controller.abort();
  assert.equal((await owner.authorization.authorize(await fixture.request())).kind, "indeterminate");
  assert.equal(fixture.events.length, 0);
  const other = renderingFixture(); let raw: CredentialGenerationOutcome | undefined;
  const active = other.create({async acquire(request) {raw = generation(request); other.controller.abort(); return raw;}});
  assert.deepEqual(await active.rendering.render(await other.fresh(active)), {kind: "denied"});
  if (raw?.kind === "acquired") {raw.fields.forEach(field => erased(field.valueBytes));}
});

test("PA authorization awaiting a transaction loses freshness on owner disposal", async () => {
  const fixture = renderingFixture();
  const repository = fixture.dependencies.repository;
  const transact = repository.transact;
  const gate = Promise.withResolvers<void>();
  repository.transact = async (...args) => {await gate.promise; return transact(...args);};
  const owner = fixture.create();
  const request = await fixture.request();
  const pending = owner.authorization.authorize(request); owner.dispose();
  assert.equal((await pending).kind, "indeterminate");
  gate.resolve(); await nextTurn();
  const historical = await fixture.application.observe(selectorFor(request));
  assert.equal(historical.kind, "observed");
  if (historical.kind === "observed") {assert.deepEqual(await owner.rendering.render(historical.receipt), {kind: "denied"});}
  assert.equal(fixture.requests.length, 0);
});

test("generation must return the exact captured request identity", async () => {
  for (const change of [null, {operationRef: "operation:other"}, {recipe: "claude-api" as CredentialRecipe}]) {
    const fixture = renderingFixture(); let raw: CredentialGenerationOutcome | undefined;
    const owner = fixture.create({async acquire(request) {
      raw = generation({...request, ...change}); return raw;
    }});
    assert.deepEqual(await owner.rendering.render(await fixture.fresh(owner)), {kind: "denied"});
    if (raw?.kind === "acquired") {raw.fields.forEach(field => erased(field.valueBytes));}
  }
});

test("construction snapshots selection and acquisition methods without effects", async () => {
  const fixture = renderingFixture();
  const mutable = {...fixture.acquisition};
  const owner = fixture.create(mutable);
  assert.deepEqual(fixture.events, []);
  fixture.selection.recipe = "claude-api";
  fixture.selection.operationRef = "operation:changed";
  fixture.selection.deadline = 1;
  mutable.acquire = (() => {throw new Error("replacement called");}) as CredentialGenerationAcquisition["acquire"];
  const receipt = await fixture.fresh(owner);
  const credentials = rendered(await owner.rendering.render(receipt));
  assert.equal(fixture.requests[0]?.recipe, "codex-chatgpt");
  assert.equal(fixture.requests[0]?.operationRef, "operation:fixture");
  credentials.release(); owner.dispose();
});

test("closed selection recipes, no mode/provider mismatch or caller native account input", async () => {
  const fixture = renderingFixture();
  for (const change of [{recipe: "unknown"}, {recipe: "claude-oauth"}, {deadline: Number.NaN}, {deadline: Number.POSITIVE_INFINITY},
    {operationRef: ""}, {nativeAccount: "fixture-account"}, {headers: []}, {body: syntheticBytes()}]) {
    assert.throws(() => createContainedTurnCredentialRenderingOwner({...fixture.selection, ...change} as never, fixture.dependencies), TypeError);
  }
  assert.deepEqual(fixture.events, []);
});
