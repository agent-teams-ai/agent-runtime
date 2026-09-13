// Synthetic only: no PostgreSQL connection, provider, filesystem or launch.
import assert from "node:assert/strict";
import test from "node:test";
import {createLinuxCodexPaRenderingFactory, type LinuxCodexOwnedPaMaterial} from "./linux-codex-pa-rendering.ts";

type Factory = ReturnType<typeof createLinuxCodexPaRenderingFactory>;
const synthetic = (operationId = "synthetic:operation") => {
  const controller = new AbortController();
  const bytes = new TextEncoder().encode("synthetic-only-token");
  const accountBytes = new TextEncoder().encode("synthetic-only-account");
  const binding = {accessRef: "synthetic:access", availability: "available" as const,
    bindingRevision: 1, credentialBindingDigest: "synthetic:digest", credentialBindingRef: "synthetic:credential",
    credentialGeneration: 1, projectId: "synthetic:project", provider: "codex" as const,
    providerAccountRef: "synthetic:account", providerRouteRef: "synthetic:route", revocation: "active" as const,
    scopeDigest: "synthetic:scope", tenantId: "synthetic:tenant"};
  const owned: LinuxCodexOwnedPaMaterial = {material: {operationRef: operationId, binding,
    recipe: "codex-chatgpt", fields: [{name: "token", valueBytes: bytes}, {name: "accountId", valueBytes: accountBytes}]},
    operationAbortSignal: controller.signal, deadline: performance.now() + 60_000};
  const subject = {operationId, attemptId: "synthetic:attempt", custodyId: "synthetic:custody",
    scope: {tenantId: binding.tenantId, projectId: binding.projectId}, scopeDigest: binding.scopeDigest};
  // Minimal synthetic projections of the real deployment authority return type;
  // these fixtures are not evidence of acknowledgement or durable authority.
  const input = {kernel: subject} as unknown as Parameters<Factory>[0];
  const acknowledgement = {input: {subject}, current: {binding: {...binding}},
    providerAccessReceipt: {operationId, authorityFacts: {credentialGeneration: 1,
      authorityHeadDigest: binding.credentialBindingDigest}}} as unknown as Parameters<Factory>[1];
  let connections = 0;
  const pool = {async connect(): Promise<never> {connections++; throw new Error("synthetic connection forbidden");}};
  const factory = createLinuxCodexPaRenderingFactory(pool, selected => {
    assert.equal(selected, operationId); return owned;
  });
  return {owned, binding, bytes, accountBytes, controller, input, acknowledgement, factory, pool,
    connections: () => connections};
};

test("synthetic: fresh actual PA owners per call, transferred material and disposal cutoff", async () => {
  const a = synthetic("synthetic:a"); const b = synthetic("synthetic:b");
  const factory = createLinuxCodexPaRenderingFactory(a.pool, id => id === "synthetic:a" ? a.owned : b.owned);
  const first = factory(a.input, a.acknowledgement);
  const second = factory(b.input, b.acknowledgement);
  try {
    assert.notEqual(first, second);
    assert.notEqual(first.authorization, second.authorization);
    assert.equal(a.bytes.byteLength, 0); assert.equal(b.bytes.byteLength, 0);
    assert.equal(a.accountBytes.byteLength, 0); assert.equal(b.accountBytes.byteLength, 0);
    first.dispose(); first.dispose();
    assert.deepEqual(await first.rendering.render({}), {kind: "denied"});
    b.controller.abort();
    assert.deepEqual(await second.rendering.render({}), {kind: "denied"});
    assert.equal(a.connections(), 0);
  } finally {first.dispose(); second.dispose();}
});

for (const key of ["credentialGeneration", "credentialBindingDigest", "providerAccountRef"] as const) {
  test(`synthetic: independently selected ${key} mismatch erases attached material`, () => {
    const f = synthetic();
    Object.assign(f.binding, {[key]: key === "credentialGeneration" ? 2 : "synthetic:other"});
    assert.throws(() => f.factory(f.input, f.acknowledgement), {message: "Linux Codex PA rendering unavailable"});
    assert.ok(f.bytes.every(byte => byte === 0)); assert.ok(f.accountBytes.every(byte => byte === 0)); assert.equal(f.connections(), 0);
  });
}

for (const failure of ["constructor", "admission", "expired", "aborted", "operation"] as const) {
  test(`synthetic: ${failure} failure cleans supplied bytes without diagnostics`, () => {
    const f = synthetic();
    if (failure === "constructor") {Object.assign(f.owned, {deadline: Number.NaN});}
    if (failure === "admission") {f.bytes[0] = 0;}
    if (failure === "expired") {Object.assign(f.owned, {deadline: 1});}
    if (failure === "aborted") {f.controller.abort();}
    if (failure === "operation") {Object.assign(f.owned.material, {operationRef: "synthetic:other"});}
    assert.throws(() => f.factory(f.input, f.acknowledgement), {message: "Linux Codex PA rendering unavailable"});
    assert.ok(f.bytes.every(byte => byte === 0)); assert.ok(f.accountBytes.every(byte => byte === 0)); assert.equal(f.connections(), 0);
  });
}

test("synthetic: detached material cannot seed a second owner", () => {
  const f = synthetic(); const owner = f.factory(f.input, f.acknowledgement);
  try {assert.throws(() => f.factory(f.input, f.acknowledgement), {message: "Linux Codex PA rendering unavailable"});}
  finally {owner.dispose();}
});
