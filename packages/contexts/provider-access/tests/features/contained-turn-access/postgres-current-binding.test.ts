import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresCurrentProviderAccess } from "../../../dist/composition.js";
import { createPostgresCredentialRenderingOwner } from "../../../dist/features/contained-turn-access/composition/postgres-credential-rendering-owner.js";
import { materializationPostgresSchemaDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-schema.js";
import { renderingFixture } from "./credential-rendering-test-fixture.ts";

const schema = {version: 1, digest: await materializationPostgresSchemaDigest()};
const harness = () => {
  const fixture = renderingFixture();
  const current: {binding: unknown; rows?: Record<string, unknown>[]; fail: boolean; badSchema: boolean} = {
    binding: structuredClone(fixture.selection.binding), fail: false, badSchema: false,
  };
  const calls: {sql: string; values?: unknown[] | undefined}[] = [];
  let connects = 0;
  const pool = {async connect() {
    connects++;
    if (current.fail) {throw new Error("Synthetic DB outage");}
    return {
      async query(sql: string, values?: unknown[]) {
        calls.push({sql, values});
        if (sql.includes("SELECT version")) {return {rows: [{...schema, version: current.badSchema ? 2 : 1}], rowCount: 1};}
        if (sql.startsWith("SELECT binding")) {
          const rows = current.rows ?? [{binding: current.binding}];
          return {rows, rowCount: rows.length};
        }
        return {rows: [], rowCount: 0};
      },
      release() {},
    };
  }};
  const owner = createPostgresCredentialRenderingOwner(pool, fixture.selection, fixture.acquisition);
  const input = {provider: fixture.selection.binding.provider,
    scope: {tenantId: fixture.selection.binding.tenantId, projectId: fixture.selection.binding.projectId}};
  const shared = createPostgresCurrentProviderAccess(pool, {provider: input.provider, tenantId: input.scope.tenantId,
    projectId: input.scope.projectId, scopeDigest: fixture.selection.binding.scopeDigest});
  return {fixture, current, calls, connects: () => connects, owner, input, shared};
};

test("PA resolve reads current durable binding without creating heads or authorizations", async t => {
  const h = harness(); t.after(h.owner.owner.dispose);
  assert.equal(h.connects(), 0, "Construction has no database effects");
  const resolved = await h.owner.providerAccess.resolve.execute(h.input);
  assert.equal(resolved.kind, "resolved");
  if (resolved.kind !== "resolved") {throw new Error("Expected resolved binding");}
  assert.equal(resolved.binding.revision, h.fixture.selection.binding.bindingRevision);
  assert.equal(Object.isFrozen(resolved.binding), true);
  assert.equal("scopeDigest" in resolved.binding, false, "Private selector does not expand the public DTO");
  const query = h.calls.find(call => call.sql.startsWith("SELECT binding"));
  assert.deepEqual(query?.values?.slice(1), [h.input.scope.tenantId, h.input.scope.projectId, h.input.provider, h.fixture.selection.binding.scopeDigest]);
  assert.equal(h.calls.some(call => /INSERT|UPDATE|DELETE|FOR UPDATE|CREATE/u.test(call.sql)), false);
  assert.deepEqual(h.fixture.requests, [], "Observation cannot acquire credentials");
});

test("resolve and revalidate observe rotations and revocation from the same durable head", async t => {
  const h = harness(); t.after(h.owner.owner.dispose);
  const initial = await h.owner.providerAccess.resolve.execute(h.input);
  if (initial.kind !== "resolved") {throw new Error("Expected initial binding");}
  h.current.binding = {...h.fixture.selection.binding, credentialGeneration: 2};
  const revalidated = await h.owner.providerAccess.revalidate.execute({...h.input, binding: initial.binding});
  assert.equal(revalidated.kind, "rejected");
  if (revalidated.kind !== "rejected") {throw new Error("Expected rotation rejection");}
  assert.equal(revalidated.reason, "credential_rotated");
  const fresh = await h.owner.providerAccess.resolve.execute(h.input);
  assert.equal(fresh.kind, "resolved");
  if (fresh.kind === "resolved") {assert.equal(fresh.binding.credentialGeneration, 2);}
  h.current.binding = {...h.fixture.selection.binding, revocation: "revoked"};
  const revoked = await h.owner.providerAccess.resolve.execute(h.input);
  assert.equal(revoked.kind, "unavailable");
  if (revoked.kind === "unavailable") {assert.equal(revoked.reason, "revoked");}
});

test("scope is captured once and foreign lookups never touch the database", async t => {
  const h = harness(); t.after(h.owner.owner.dispose);
  Object.assign(h.fixture.selection.binding, {scopeDigest: "mutated:scope", tenantId: "mutated:tenant"});
  for (const change of [{provider: "claude" as const}, {scope: {...h.input.scope, tenantId: "foreign"}},
    {scope: {...h.input.scope, projectId: "foreign"}}]) {
    const result = await h.owner.providerAccess.resolve.execute({...h.input, ...change});
    assert.equal(result.kind, "unavailable");
  }
  assert.equal(h.connects(), 0);
  assert.equal((await h.owner.providerAccess.resolve.execute(h.input)).kind, "resolved");
});

test("absent heads are unavailable and malformed or foreign stored rows are indeterminate", async t => {
  const h = harness(); t.after(h.owner.owner.dispose);
  for (const rows of [[], [{binding: null}]]) {
    h.current.rows = rows;
    const result = await h.owner.providerAccess.resolve.execute(h.input);
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") {assert.equal(result.reason, "not_found");}
  }
  for (const rows of [[{binding: {...h.fixture.selection.binding, tenantId: "foreign"}}],
    [{binding: {...h.fixture.selection.binding, scopeDigest: "foreign"}}],
    [{binding: {...h.fixture.selection.binding, credentialGeneration: 0}}],
    [{binding: h.fixture.selection.binding}, {binding: h.fixture.selection.binding}], [{}]]) {
    h.current.rows = rows;
    const result = await h.owner.providerAccess.resolve.execute(h.input);
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") {assert.equal(result.reason, "indeterminate");}
  }
});

test("schema drift, database outage and disposal cannot return cached PA authority", async t => {
  const h = harness(); t.after(h.owner.owner.dispose);
  assert.equal((await h.owner.providerAccess.resolve.execute(h.input)).kind, "resolved");
  for (const failure of ["badSchema", "fail"] as const) {
    h.current[failure] = true;
    const result = await h.owner.providerAccess.resolve.execute(h.input);
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") {assert.equal(result.reason, "indeterminate");}
    h.current[failure] = false;
  }
  h.owner.owner.dispose();
  const before = h.connects();
  const result = await h.owner.providerAccess.resolve.execute(h.input);
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") {assert.equal(result.reason, "indeterminate");}
  assert.equal(h.connects(), before);
});

test("shared current resolver survives disposing an operation rendering owner and observes independent revocation", async t => {
  const h = harness(); t.after(h.shared.dispose);
  assert.equal(h.connects(), 0);
  h.owner.owner.dispose();
  const first = await h.shared.providerAccess.resolve.execute(h.input);
  assert.equal(first.kind, "resolved");
  if (first.kind !== "resolved") {throw new Error("Expected independent resolver");}
  assert.equal(first.evidence.bindingAuthorityDigest, h.fixture.selection.binding.credentialBindingDigest);
  h.current.binding = {...h.fixture.selection.binding, revocation: "revoked"};
  const result = await h.shared.providerAccess.revalidate.execute({...h.input, binding: first.binding});
  assert.equal(result.kind, "rejected");
  assert.equal(h.calls.some(call => /INSERT|UPDATE|DELETE|CREATE/u.test(call.sql)), false);
  h.shared.dispose();
  const closed = await h.shared.providerAccess.resolve.execute(h.input);
  assert.equal(closed.kind, "unavailable");
});
