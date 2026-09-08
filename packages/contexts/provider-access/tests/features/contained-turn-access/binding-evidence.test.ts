import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createContainedTurnProviderAccessAdapter,
  resolveResultToContract,
  revalidateResultToContract,
} from "../../../dist/features/contained-turn-access/adapters/inbound/contained-turn-provider-access-mapper.js";
import type { ProviderAccessBindingRecord } from "../../../dist/features/contained-turn-access/domain/provider-access-binding.js";

const binding = (): ProviderAccessBindingRecord => ({
  accessRef: "access:ar69-linux-codex-r6-20260907-acceptance",
  availability: "available",
  credentialBindingDigest: `sha256:${"a".repeat(64)}`,
  credentialBindingRef: "credential-binding:ar69-linux-codex-r6-20260907",
  credentialGeneration: 1,
  projectId: "project:ar69-linux-codex-r6-20260907",
  provider: "codex",
  providerAccountRef: "provider-account:ar69-linux-codex-r6-20260907",
  providerRouteRef: "provider-route:ar69-linux-codex-r6-20260907",
  revision: 1,
  revocation: "active",
  tenantId: "tenant:ar69-linux-codex-r6-20260907",
});

const resolve = async (value = binding()) => {
  const result = await resolveResultToContract({ binding: value, kind: "resolved" });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") { throw new Error("expected binding"); }
  return result;
};

test("complete versioned PA evidence hashes the full binding deterministically", async () => {
  const result = await resolve();
  const preimage = JSON.stringify({ binding: result.binding, purpose: "acceptance", version: 1 });
  assert.ok(preimage.length > 512, "reproduce the unbounded JSON evidence failure");
  assert.equal(result.evidence.authorityDigest, `sha256:${createHash("sha256").update(preimage).digest("hex")}`);
  assert.equal(result.evidence.authorityDigest.length, 71);
  assert.deepEqual(await resolve(), result);
  assert.ok(Object.isFrozen(result.evidence));
  assert.deepEqual(Object.keys(result.evidence).toSorted(), ["authorityDigest", "bindingAuthorityDigest", "proofRef", "purpose"]);
  assert.equal(result.evidence.bindingAuthorityDigest, binding().credentialBindingDigest);
  assert.deepEqual(result.binding, (({ availability: _availability, revocation: _revocation, ...value }) => value)(binding()));
  assert.equal(result.evidence.proofRef, `binding:${result.binding.accessRef}:revision:1:purpose:acceptance`);
  const dispatch = await revalidateResultToContract({ binding: binding(), kind: "valid" });
  assert.equal(dispatch.kind, "valid");
  if (dispatch.kind !== "valid") { return; }
  assert.deepEqual(dispatch.binding, result.binding);
  assert.equal(dispatch.evidence.purpose, "dispatch");
  assert.equal(dispatch.evidence.bindingAuthorityDigest, result.evidence.bindingAuthorityDigest);
  assert.notEqual(dispatch.evidence.authorityDigest, result.evidence.authorityDigest);
});

test("every accepted binding field changes the evidence digest", async () => {
  const original = await resolve();
  for (const key of Object.keys(original.binding) as (keyof typeof original.binding)[]) {
    const value = original.binding[key];
    const replacement = key === "provider" ? "claude" : typeof value === "number" ? value + 1 : `${value}:changed`;
    const changed = await resolve({ ...binding(), [key]: replacement });
    assert.notEqual(changed.evidence.authorityDigest, original.evidence.authorityDigest, key);
  }
});

test("maximal AE-valid access refs retain identity and produce bounded proof refs", async () => {
  const source = { ...binding(), accessRef: `access:${"x".repeat(505)}`, revision: Number.MAX_SAFE_INTEGER };
  assert.equal(source.accessRef.length, 512);
  for (const result of [await resolve(source), await revalidateResultToContract({ binding: source, kind: "valid" })]) {
    assert.ok(result.kind === "resolved" || result.kind === "valid");
    if (result.kind !== "resolved" && result.kind !== "valid") { continue; }
    assert.equal(result.binding.accessRef, source.accessRef);
    assert.equal(result.binding.revision, source.revision);
    assert.equal(result.evidence.proofRef, `binding:${result.evidence.authorityDigest}:purpose:${result.evidence.purpose}`);
  }
  assert.notEqual((await resolve({ ...source, accessRef: `${source.accessRef.slice(0, -1)}y` })).evidence.authorityDigest,
    (await resolve(source)).evidence.authorityDigest);
});


test("asynchronous evidence hashing failure stays a fail-closed owner outcome", async context => {
  const source = binding();
  const accepted = await resolve(source);
  const feature = createContainedTurnProviderAccessAdapter({
    resolve: { execute: async () => ({ binding: source, kind: "resolved" }) },
    revalidate: { execute: async () => ({ binding: source, kind: "valid" }) },
  });
  context.mock.method(crypto.subtle, "digest", async () => { throw new Error("synthetic hash failure"); });
  const input = { provider: source.provider, scope: { projectId: source.projectId, tenantId: source.tenantId } };
  const resolution = await feature.resolve.execute(input);
  const dispatch = await feature.revalidate.execute({ ...input, binding: accepted.binding });
  assert.equal(resolution.kind, "unavailable");
  assert.equal(dispatch.kind, "rejected");
  if (resolution.kind !== "unavailable" || dispatch.kind !== "rejected") { return; }
  assert.equal(resolution.reason, "indeterminate");
  assert.equal(dispatch.reason, "indeterminate");
});
