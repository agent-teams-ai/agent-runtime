import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { markAsUntransferable } from "node:worker_threads";
import { createOperationCredentialGenerationAcquisition } from "../../../dist/features/contained-turn-access/adapters/outbound/operation-credential-generation-acquisition.js";
import type { OperationCredentialMaterial } from "../../../dist/features/contained-turn-access/adapters/outbound/credential-rendering-contracts.js";
import { erased, renderingFixture, syntheticBytes } from "./credential-rendering-test-fixture.ts";
import { acquired, acquisitionFixture, materialFor, permittedRequest, watchBytes, wipe } from "./operation-credential-material-fixture.ts";

test("admission detaches every producer alias; acquisitions transfer dedicated independent copies", async t => {
  const fixture = acquisitionFixture(); t.after(() => fixture.owner.dispose());
  const material = materialFor(fixture.selection);
  const aliases = material.fields.map(field => new Uint8Array(field.valueBytes.buffer));
  const seed = watchBytes(t);
  assert.deepEqual(fixture.source.admission.admit(material), {kind: "admitted"});
  assert.equal(seed.length, 2);
  material.fields.forEach(field => assert.equal(field.valueBytes.byteLength, 0));
  aliases.forEach(bytes => assert.equal(bytes.byteLength, 0));
  const seedBuffers = seed.map(bytes => bytes.buffer);
  const request = await permittedRequest(fixture);
  fixture.source.lifetime.acceptRequest(request);
  const first = acquired(await fixture.source.acquisition.acquire(request, new AbortController().signal));
  assert.equal(first.request, request); assert.equal(first.request.authorization, request.authorization);
  assert.equal(first.request.authorization.credentialBindingDigest, "credential:digest:1");
  assert.notEqual(first.fields[0]?.valueBytes.buffer, first.fields[1]?.valueBytes.buffer);
  for (const field of first.fields) {
    assert.equal(field.valueBytes.byteLength, field.valueBytes.buffer.byteLength);
    assert.ok(!seedBuffers.includes(field.valueBytes.buffer));
  }
  wipe(first.fields);
  const secondRequest = await permittedRequest(fixture, "request:second");
  fixture.source.lifetime.acceptRequest(secondRequest);
  const second = acquired(await fixture.source.acquisition.acquire(secondRequest, new AbortController().signal));
  assert.equal(new TextDecoder().decode(second.fields[0]?.valueBytes), "synthetic-token");
  assert.notEqual(first.fields[0]?.valueBytes.buffer, second.fields[0]?.valueBytes.buffer);
  fixture.owner.dispose(); seed.slice(0, 2).forEach(erased);
  assert.ok(second.fields.every(field => field.valueBytes.some(byte => byte !== 0)));
  wipe(second.fields);
});

test("one admission attempt, including failure; rejection leaves attached bytes with producer", () => {
  for (const success of [false, true]) {
    const fixture = acquisitionFixture();
    const first = materialFor(fixture.selection);
    const supplied = success ? first : {...first, operationRef: "operation:wrong"};
    assert.equal(fixture.source.admission.admit(supplied).kind, success ? "admitted" : "rejected");
    const replacement = materialFor(fixture.selection);
    assert.equal(fixture.source.admission.admit(replacement).kind, "rejected");
    assert.ok(replacement.fields[0]!.valueBytes.byteLength > 0);
    if (!success) {assert.ok(first.fields[0]!.valueBytes.byteLength > 0); wipe(first.fields);}
    wipe(replacement.fields); fixture.owner.dispose();
    const late = materialFor(fixture.selection);
    assert.equal(fixture.source.admission.admit(late).kind, "rejected"); wipe(late.fields);
  }
});

const substitutions = {
  tenantId: "tenant:other", projectId: "project:other", scopeDigest: "scope:other", provider: "claude",
  accessRef: "access:other", providerAccountRef: "account:other", providerRouteRef: "route:other", bindingRevision: 2,
  credentialBindingRef: "credential:other", credentialBindingDigest: "digest:other", credentialGeneration: 2,
  availability: "unavailable", revocation: "revoked",
};
test("admission checks exact operation, recipe and all thirteen binding fields before transfer", () => {
  const changes = [
    {operationRef: "operation:other"}, {recipe: "codex-api"},
    ...Object.entries(substitutions).map(([key, value]) => ({bindingChange: {[key]: value}})),
  ];
  for (const change of changes) {
    const fixture = acquisitionFixture();
    const material = materialFor(fixture.selection);
    const input = "bindingChange" in change ? {...material, binding: {...material.binding, ...change.bindingChange}} : {...material, ...change};
    assert.equal(fixture.source.admission.admit(input as OperationCredentialMaterial).kind, "rejected");
    assert.ok(material.fields.every(field => field.valueBytes.byteLength > 0));
    wipe(material.fields); fixture.owner.dispose();
  }
});

test("request handoff validates full selection and requires the exact frozen owner request", async t => {
  const fixture = acquisitionFixture(); t.after(() => fixture.owner.dispose());
  fixture.source.admission.admit(materialFor(fixture.selection));
  const request = await permittedRequest(fixture);
  const signal = new AbortController().signal;
  await assert.rejects(fixture.source.acquisition.acquire(request, signal));
  const changes = Object.entries(substitutions).map(([key, value]) => ({...request,
    authorization: Object.freeze({...request.authorization, [key]: value})}));
  changes.push({...request, operationRef: "operation:other"}, {...request, recipe: "codex-api"});
  for (const candidate of changes) {assert.throws(() => fixture.source.lifetime.acceptRequest(Object.freeze(candidate)));}
  assert.throws(() => fixture.source.lifetime.acceptRequest({...request}));
  fixture.source.lifetime.acceptRequest(request);
  await assert.rejects(fixture.source.acquisition.acquire(Object.freeze({...request}), signal));
  await assert.rejects(fixture.source.acquisition.acquire(request, signal));
  fixture.source.lifetime.acceptRequest(request);
  wipe(acquired(await fixture.source.acquisition.acquire(request, signal)).fields);
  fixture.source.lifetime.acceptRequest(request);
  await assert.rejects(fixture.source.acquisition.acquire(request, signal));
});

test("shared, resizable, detached, slab, wrong type and same-buffer fields are rejected pretransfer", () => {
  const detached = syntheticBytes(); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  const cases = [new Uint8Array(new SharedArrayBuffer(8)), new Uint8Array(new ArrayBuffer(8, {maxByteLength: 16})),
    new Uint8Array(new ArrayBuffer(16), 4, 8), detached, new Uint16Array([65]), new DataView(new ArrayBuffer(8))];
  for (const bytes of cases) {
    const fixture = acquisitionFixture("claude-api");
    assert.equal(fixture.source.admission.admit({...materialFor(fixture.selection),
      fields: [{name: "apiKey", valueBytes: bytes as unknown as Uint8Array}]}).kind, "rejected");
    fixture.owner.dispose();
  }
  const fixture = acquisitionFixture(); const bytes = syntheticBytes();
  assert.equal(fixture.source.admission.admit({...materialFor(fixture.selection), fields:
    [{name: "token", valueBytes: bytes}, {name: "accountId", valueBytes: new Uint8Array(bytes.buffer)}]}).kind, "rejected");
  assert.ok(bytes.byteLength > 0); bytes.fill(0); fixture.owner.dispose();
});

test("recipe byte rules enforce ordered fields, visible ASCII and total 8448-byte bound", () => {
  for (const [tokenLength, accountLength, expected] of [[8192, 256, "admitted"], [8193, 256, "rejected"], [8192, 257, "rejected"], [0, 1, "rejected"]] as const) {
    const fixture = acquisitionFixture();
    const token = new Uint8Array(tokenLength).fill(65), account = new Uint8Array(accountLength).fill(66);
    assert.equal(fixture.source.admission.admit({...materialFor(fixture.selection), fields:
      [{name: "token", valueBytes: token}, {name: "accountId", valueBytes: account}]}).kind, expected);
    fixture.owner.dispose();
    if (expected === "rejected") {token.fill(0); account.fill(0);}
  }
  for (const byte of [0, 0x20, 0x7f, 0xff, 10, 13]) {
    const fixture = acquisitionFixture("claude-api");
    const bytes = new Uint8Array([byte]);
    assert.equal(fixture.source.admission.admit({...materialFor(fixture.selection), fields: [{name: "apiKey", valueBytes: bytes}]}).kind, "rejected");
    assert.equal(bytes[0], byte); bytes.fill(0); fixture.owner.dispose();
  }
  for (const change of ["reverse", "missing", "extra", "wrong-name"] as const) {
    const fixture = acquisitionFixture(); const material = materialFor(fixture.selection);
    const fields = [...material.fields];
    if (change === "reverse") {fields.reverse();}
    if (change === "missing") {fields.pop();}
    if (change === "extra") {fields.push(fields[0]!);}
    if (change === "wrong-name") {fields[0] = {...fields[0]!, name: "apiKey"};}
    assert.equal(fixture.source.admission.admit({...material, fields}).kind, "rejected");
    wipe(material.fields); fixture.owner.dispose();
  }
});

test("malformed descriptors and proxies never execute producer code at any admission layer", () => {
  for (const location of ["root", "binding", "fields", "slot", "name", "bytes", "buffer"] as const) {
    for (const proxy of [false, true]) {
      const fixture = acquisitionFixture(); let traps = 0;
      const trap = () => {traps += 1; throw new Error("synthetic trap");};
      const wrap = <T extends object>(value: T): T => new Proxy(value, {get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap});
      const material = materialFor(fixture.selection);
      const fields = material.fields.map(field => ({...field})); const field = fields[0]!;
      let input = {...material, fields};
      if (location === "root") {input = proxy ? wrap(input) : Object.defineProperty(input, "recipe", {get: trap});}
      if (location === "binding") {input.binding = proxy ? wrap(input.binding) : Object.defineProperty({...input.binding}, "accessRef", {get: trap});}
      if (location === "fields") {
        if (proxy) {input.fields = wrap(fields);} else {Object.defineProperty(input, "fields", {get: trap});}
      }
      if (location === "slot") {
        if (proxy) {fields[0] = wrap(field);} else {Object.defineProperty(fields, "0", {get: trap});}
      }
      if (location === "name" || location === "bytes") {
        const key = location === "name" ? "name" : "valueBytes";
        Object.defineProperty(field, key, proxy ? {value: wrap({})} : {get: trap});
      }
      if (location === "buffer") {
        if (proxy) {field.valueBytes = wrap(field.valueBytes);}
        else {Object.defineProperty(field.valueBytes, "buffer", {get: trap});}
      }
      assert.equal(fixture.source.admission.admit(input).kind, location === "buffer" && !proxy ? "admitted" : "rejected");
      assert.equal(traps, 0); fixture.owner.dispose();
      for (const original of material.fields) {if (original.valueBytes.byteLength > 0) {original.valueBytes.fill(0);}}
    }
  }
});

test("failed second transfer erases PA-owned first buffer and leaves remaining cleanup to producer", t => {
  const fixture = acquisitionFixture(); const material = materialFor(fixture.selection);
  markAsUntransferable(material.fields[1]!.valueBytes.buffer);
  const transferred = watchBytes(t);
  assert.equal(fixture.source.admission.admit(material).kind, "rejected");
  assert.equal(material.fields[0]!.valueBytes.byteLength, 0);
  assert.ok(material.fields[1]!.valueBytes.byteLength > 0);
  assert.equal(transferred.length, 1); transferred.forEach(erased);
  material.fields[1]!.valueBytes.fill(0); fixture.owner.dispose();
});

test("failed first transfer leaves producer ownership; failed post-transfer view construction is erased", t => {
  const fixture = acquisitionFixture(); const material = materialFor(fixture.selection);
  markAsUntransferable(material.fields[0]!.valueBytes.buffer);
  assert.equal(fixture.source.admission.admit(material).kind, "rejected");
  assert.ok(material.fields.every(field => field.valueBytes.byteLength > 0)); wipe(material.fields); fixture.owner.dispose();
  const other = acquisitionFixture(); const input = materialFor(other.selection);
  let transferred: ArrayBuffer | undefined;
  t.mock.method(globalThis, "Uint8Array", function (buffer: ArrayBuffer) {transferred = buffer; throw new Error("synthetic allocation failure");} as never);
  assert.equal(other.source.admission.admit(input).kind, "rejected");
  assert.equal(input.fields[0]!.valueBytes.byteLength, 0);
  assert.ok(transferred); t.mock.restoreAll(); erased(new Uint8Array(transferred));
  input.fields[1]!.valueBytes.fill(0); other.owner.dispose();
});

test("idle seed has one fixed timer, operation abort cleanup cannot be stopped by source listener", t => {
  const fixture = acquisitionFixture(); const material = materialFor(fixture.selection);
  const allocations = watchBytes(t);
  const original = globalThis.setTimeout;
  const timer = t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => original(...args));
  fixture.controller.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  assert.equal(fixture.source.admission.admit(material).kind, "admitted");
  assert.equal(timer.mock.callCount(), 1); assert.equal(allocations.length, 2);
  fixture.controller.abort(); allocations.forEach(erased);
  assert.equal(fixture.source.admission.admit(materialFor(fixture.selection)).kind, "rejected");
  fixture.owner.dispose();
});

test("idle deadline, explicit disposal and late timer callback erase without acquisition or reopening", async t => {
  const fixture = renderingFixture(); fixture.selection.deadline = performance.now() + 25;
  const source = createOperationCredentialGenerationAcquisition(fixture.selection);
  const input = materialFor(fixture.selection); const allocations = watchBytes(t);
  const timer = t.mock.method(globalThis, "setTimeout");
  assert.equal(source.admission.admit(input).kind, "admitted");
  assert.equal(timer.mock.callCount(), 1);
  await delay(45); allocations.forEach(erased); source.lifetime.dispose();
  const callback = timer.mock.calls[0]!.arguments[0] as () => void; callback();
  assert.equal(source.admission.admit(materialFor(fixture.selection)).kind, "rejected");
});

test("lifetime activation failure cleans transferred material and scheduled resources", t => {
  const fixture = acquisitionFixture(); const material = materialFor(fixture.selection);
  const allocations = watchBytes(t);
  t.mock.method(globalThis, "setTimeout", () => {throw new Error("synthetic timer unavailable");});
  assert.equal(fixture.source.admission.admit(material).kind, "rejected");
  allocations.forEach(erased); assert.ok(material.fields.every(field => field.valueBytes.byteLength === 0));
  fixture.controller.abort(); fixture.owner.dispose();
});

test("expired, aborted and timer-overflow selections fail before material transfer", () => {
  for (const state of ["expired", "aborted", "overflow"] as const) {
    const fixture = renderingFixture();
    if (state === "expired") {fixture.selection.deadline = 1;}
    if (state === "overflow") {fixture.selection.deadline = performance.now() + 2_147_483_647 + 60_000;}
    if (state === "aborted") {fixture.controller.abort();}
    const source = createOperationCredentialGenerationAcquisition(fixture.selection);
    const material = materialFor(fixture.selection);
    assert.equal(source.admission.admit(material).kind, "rejected");
    assert.ok(material.fields.every(field => field.valueBytes.byteLength > 0)); wipe(material.fields); source.lifetime.dispose();
  }
});

test("malformed request descriptors and mutated operation signal cannot invoke getters or retain seed", async t => {
  const fixture = acquisitionFixture(); const material = materialFor(fixture.selection);
  const allocations = watchBytes(t); fixture.source.admission.admit(material); const seed = allocations.slice(0, 2);
  const request = await permittedRequest(fixture); let traps = 0;
  const trap = () => {traps += 1; throw new Error("synthetic-token");};
  for (const input of [new Proxy(request, {get: trap, ownKeys: trap}),
    Object.defineProperty({...request}, "authorization", {get: trap}),
    {...request, authorization: new Proxy(request.authorization, {ownKeys: trap})},
    {...request, authorization: Object.defineProperty({...request.authorization}, "accessRef", {get: trap})}]) {
    assert.throws(() => fixture.source.lifetime.acceptRequest(input));
  }
  Object.defineProperty(fixture.controller.signal, "aborted", {get: trap});
  assert.throws(() => fixture.source.lifetime.acceptRequest(request));
  assert.equal(traps, 0); seed.forEach(erased); fixture.owner.dispose();
});
