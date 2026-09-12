import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createContainedTurnCredentialRenderingOwner } from "../../../dist/features/contained-turn-access/composition/credential-rendering-owner-factory.js";
import type { CredentialGenerationOutcome } from "../../../dist/features/contained-turn-access/adapters/outbound/credential-rendering-contracts.js";
import { erased, generation, rendered, renderingFixture, syntheticBytes } from "./credential-rendering-test-fixture.ts";

test("exact private fields reject duplicate, unexpected, case-changed and extra names", async () => {
  for (const fields of [
    [{name: "token", valueBytes: syntheticBytes()}, {name: "token", valueBytes: syntheticBytes()}],
    [{name: "Authorization", valueBytes: syntheticBytes()}, {name: "accountId", valueBytes: syntheticBytes()}],
    [{name: "token", valueBytes: syntheticBytes()}, {name: "accountid", valueBytes: syntheticBytes()}],
    [{name: "token", valueBytes: syntheticBytes()}, {name: "accountId", valueBytes: syntheticBytes()}, {name: "unexpected", valueBytes: syntheticBytes()}],
    [{name: "token", valueBytes: syntheticBytes(), extra: "fixture"}, {name: "accountId", valueBytes: syntheticBytes()}],
  ]) {
    const fixture = renderingFixture();
    const owner = fixture.create({async acquire(request) {return {kind: "acquired", request, fields} as CredentialGenerationOutcome;}});
    assert.deepEqual(await owner.rendering.render(await fixture.fresh(owner)), {kind: "denied"});
    fields.forEach(field => erased(field.valueBytes));
  }
});

test("credential value bounds and visible ASCII reject CRLF, controls, spaces and non-ASCII", async () => {
  for (const [recipe, slot, values] of [
    ["codex-chatgpt", 0, [new Uint8Array(), syntheticBytes("fixture\r\ninjected"), syntheticBytes("fixture\n"), syntheticBytes("has space"),
      new Uint8Array([0]), new Uint8Array([0x1f]), new Uint8Array([0x7f]), new Uint8Array([0x80]), new Uint8Array(8193).fill(0x61)]],
    ["codex-chatgpt", 1, [new Uint8Array(), new Uint8Array(257).fill(0x61), syntheticBytes("fixture\taccount")]],
    ["claude-api", 0, [syntheticBytes("fixture\rkey"), new Uint8Array(8193).fill(0x61)]],
  ] as const) {
    for (const bytes of values) {
      const fixture = renderingFixture(recipe);
      const owner = fixture.create({async acquire(request) {
        const raw = generation(request);
        if (raw.kind !== "acquired") {throw new Error("fixture");}
        return {...raw, fields: raw.fields.map((field, index) => index === slot ? {...field, valueBytes: bytes} : field)};
      }});
      assert.deepEqual(await owner.rendering.render(await fixture.fresh(owner)), {kind: "denied"});
      erased(bytes);
    }
  }
});

test("exact maximum token/account lengths succeed with fixed allowlisted header limits", async () => {
  const fixture = renderingFixture();
  const token = new Uint8Array(8192).fill(0x61), account = new Uint8Array(256).fill(0x62);
  const owner = fixture.create({async acquire(request) {
    return {kind: "acquired", request, fields: [{name: "token", valueBytes: token}, {name: "accountId", valueBytes: account}]};
  }});
  const credentials = rendered(await owner.rendering.render(await fixture.fresh(owner)));
  assert.deepEqual(credentials.fields.map(field => field.valueBytes.length), [8199, 256]);
  erased(token); erased(account); credentials.release(); owner.dispose();
});

test("raw copy and erasure use typed-array intrinsics without invoking mutable buffer hooks", async () => {
  const fixture = renderingFixture("claude-api");
  let traps = 0;
  const bytes = syntheticBytes();
  for (const key of ["length", "buffer", "byteLength", "byteOffset", "slice", "subarray", "fill", "set", "toJSON", "constructor", Symbol.iterator]) {
    Object.defineProperty(bytes, key, {get() {traps += 1; throw new Error("fixture trap");}});
  }
  const owner = fixture.create({async acquire(request) {return {kind: "acquired", request, fields: [{name: "apiKey", valueBytes: bytes}]};}});
  const credentials = rendered(await owner.rendering.render(await fixture.fresh(owner)));
  assert.equal(new TextDecoder().decode(credentials.fields[0]?.valueBytes), "fixture-pa");
  assert.equal(traps, 0);
  assert.ok(Uint8Array.prototype.every.call(bytes, byte => byte === 0));
  Object.defineProperty(credentials.fields[0]?.valueBytes, "fill", {get() {traps += 1; throw new Error("fixture trap");}});
  credentials.release(); assert.equal(traps, 0); owner.dispose();
});

test("shared, resizable, aliased slab and detached raw buffers are refused", async () => {
  const detached = syntheticBytes(); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  const values = [new Uint8Array(new SharedArrayBuffer(10)), new Uint8Array(new ArrayBuffer(10, {maxByteLength: 20})),
    new Uint8Array(new ArrayBuffer(20), 2, 10), detached, new Uint16Array([65, 66])];
  for (const bytes of values) {
    const fixture = renderingFixture("claude-api");
    const owner = fixture.create({async acquire(request) {return {kind: "acquired", request,
      fields: [{name: "apiKey", valueBytes: bytes}]} as CredentialGenerationOutcome;}});
    assert.deepEqual(await owner.rendering.render(await fixture.fresh(owner)), {kind: "denied"});
  }
});

test("malformed raw object, fields, array slots, accessors and proxies execute no traps", async () => {
  for (const location of ["root", "fields", "slot", "name", "valueBytes", "buffer"] as const) {
    for (const proxy of [false, true]) {
      const fixture = renderingFixture(); let traps = 0;
      const trap = () => {traps += 1; throw new Error("fixture secret trap");};
      const owner = fixture.create({async acquire(request) {
        const value = generation(request);
        assert.ok(value.kind === "acquired");
        const root = {...value, fields: value.fields.map(field => ({...field}))};
        const proxify = <T extends object>(input: T): T => new Proxy(input, {ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap});
        if (location === "root") {
          if (proxy) {return proxify(root);}
          Object.defineProperty(root, "request", {get: trap});
        } else if (location === "fields") {
          if (proxy) {root.fields = proxify(root.fields);}
          else {Object.defineProperty(root, "fields", {get: trap});}
        } else if (location === "slot") {
          if (proxy) {root.fields[0] = proxify(root.fields[0] as object) as never;}
          else {Object.defineProperty(root.fields, "0", {get: trap});}
        } else {
          const field = root.fields[0] as {name: string; valueBytes: Uint8Array};
          if (location === "buffer") {field.valueBytes = proxify(field.valueBytes);}
          else if (proxy) {Object.defineProperty(field, location, {value: proxify({})});}
          else {Object.defineProperty(field, location, {get: trap});}
        }
        return root;
      }});
      assert.deepEqual(await owner.rendering.render(await fixture.fresh(owner)), {kind: "denied"}, `${location}:${proxy}`);
      assert.equal(traps, 0, `${location}:${proxy}`);
    }
  }
});

test("constructor rejects accessor/proxy dependencies and does not invoke proxy call traps", () => {
  const fixture = renderingFixture(); let traps = 0;
  const trap = () => {traps += 1; throw new Error("fixture trap");};
  const method = new Proxy(fixture.acquisition.acquire, {apply: trap, get: trap});
  const boundProxy = Function.prototype.bind.call(new Proxy(fixture.acquisition.acquire, {apply: trap}), null);
  const accessor = Object.defineProperty({}, "acquire", {get: trap});
  for (const acquisition of [accessor, new Proxy(fixture.acquisition, {ownKeys: trap}), {acquire: method},
    {acquire: boundProxy}, {...fixture.acquisition, store: "fixture"}]) {
    assert.throws(() => createContainedTurnCredentialRenderingOwner(fixture.selection, fixture.dependencies, acquisition as never), TypeError);
  }
  for (const selection of [new Proxy(fixture.selection, {ownKeys: trap, getPrototypeOf: trap}),
    Object.defineProperty({...fixture.selection}, "binding", {get: trap}),
    {...fixture.selection, operationAbortSignal: new Proxy(fixture.controller.signal, {get: trap})}]) {
    assert.throws(() => createContainedTurnCredentialRenderingOwner(selection, fixture.dependencies), TypeError);
  }
  assert.equal(traps, 0); assert.deepEqual(fixture.events, []);
});

test("caller receipt/request accessors and proxies never authorize acquisition or invoke traps", async () => {
  const fixture = renderingFixture(); let traps = 0;
  const trap = () => {traps += 1; throw new Error("fixture trap");};
  const owner = fixture.create(); const request = await fixture.request();
  const accessor = Object.defineProperty({...request}, "providerAccountRef", {get: trap});
  for (const input of [accessor, new Proxy(request, {ownKeys: trap, getPrototypeOf: trap})]) {
    assert.equal((await owner.authorization.authorize(input)).kind, "invalid");
    assert.deepEqual(await owner.rendering.render(input as never), {kind: "denied"});
  }
  assert.equal(traps, 0); assert.deepEqual(fixture.events, []); owner.dispose();
});

test("native promise methods cannot be substituted and thenable acquisitions fail without calling then", async () => {
  const fixture = renderingFixture(); let traps = 0;
  const trap = () => {traps += 1; throw new Error("fixture trap");};
  // Deliberately hostile boundary input, assembled without declaring a thenable API.
  const promiseMethod = ["th", "en"].join("");
  const owner = fixture.create({acquire(request) {
    const pending = Promise.resolve(generation(request));
    Object.defineProperty(pending, promiseMethod, {get: trap});
    return pending;
  }});
  rendered(await owner.rendering.render(await fixture.fresh(owner))).release(); owner.dispose();
  for (const value of [Object.defineProperty({}, promiseMethod, {get: trap}), new Proxy(Promise.resolve({kind: "unsupported"}), {get: trap})]) {
    const other = renderingFixture();
    const denied = other.create({acquire() {return value as never;}});
    assert.deepEqual(await denied.rendering.render(await other.fresh(denied, await other.request({authorizationRequestId: `request:${traps}:${typeof value}`}))), {kind: "denied"});
  }
  assert.equal(traps, 0);
});

test("constructor allocates no timers, listeners or abort controllers", t => {
  const fixture = renderingFixture();
  const timer = t.mock.method(globalThis, "setTimeout", () => {throw new Error("constructor timer");});
  const listener = t.mock.method(EventTarget.prototype, "addEventListener", () => {throw new Error("constructor listener");});
  const controller = t.mock.method(globalThis, "AbortController", () => {throw new Error("constructor controller");});
  const owner = fixture.create(); owner.dispose();
  assert.equal(timer.mock.callCount(), 0); assert.equal(listener.mock.callCount(), 0); assert.equal(controller.mock.callCount(), 0);
  assert.deepEqual(fixture.events, []);
});

test("signal symbol accessors are rejected without invoking them at construction or later calls", async () => {
  let traps = 0;
  const fixture = renderingFixture();
  const owner = fixture.create(); const receipt = await fixture.fresh(owner);
  const signal = fixture.controller.signal;
  const symbol = Object.getOwnPropertySymbols(signal).find(key => String(key) === "Symbol(kAborted)");
  assert.ok(symbol);
  Object.defineProperty(signal, symbol, {get() {traps += 1; throw new Error("fixture signal trap");}});
  assert.throws(() => fixture.create(), TypeError);
  assert.deepEqual(await owner.rendering.render(receipt), {kind: "denied"});
  assert.equal(traps, 0); assert.equal(fixture.requests.length, 0);
});

test("failed final reobservation erases every allocated rendered buffer", async t => {
  const fixture = renderingFixture();
  const NativeBytes = Uint8Array;
  const allocations: Uint8Array[] = [];
  const owner = fixture.create({async acquire(request) {
    const raw = generation(request);
    await fixture.control.replaceBindingHead({...fixture.head, revocation: "revoked"});
    // Instrument owned allocations only after PA acquisition, before renderer copies.
    t.mock.method(globalThis, "Uint8Array", function (length: number) {
      const bytes = new NativeBytes(length); allocations.push(bytes); return bytes;
    } as never);
    return raw;
  }});
  assert.deepEqual(await owner.rendering.render(await fixture.fresh(owner)), {kind: "denied"});
  // Digest decoding also allocates after acquisition; check the known field lengths.
  const fields = allocations.filter(bytes => bytes.length === 17 || bytes.length === 15);
  assert.equal(fields.length, 2); fields.forEach(erased);
});

test("abort while final PA reread is pending erases rendered copies and returns no fields", async t => {
  const fixture = renderingFixture();
  const NativeBytes = Uint8Array; const allocations: Uint8Array[] = [];
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const original = fixture.dependencies.repository.transact; let reads = 0;
  fixture.dependencies.repository.transact = async (...args) => {
    reads += 1;
    if (reads === 3) {entered.resolve(); await gate.promise;}
    return original(...args);
  };
  const owner = fixture.create({async acquire(request) {
    const raw = generation(request);
    t.mock.method(globalThis, "Uint8Array", function (length: number) {
      const bytes = new NativeBytes(length); allocations.push(bytes); return bytes;
    } as never);
    return raw;
  }});
  const receipt = await fixture.fresh(owner);
  const pending = owner.rendering.render(receipt); await entered.promise;
  fixture.controller.abort(); assert.deepEqual(await pending, {kind: "denied"});
  const fields = allocations.filter(bytes => bytes.length === 17 || bytes.length === 15);
  assert.equal(fields.length, 2); fields.forEach(erased);
  gate.resolve(); await nextTurn();
});
