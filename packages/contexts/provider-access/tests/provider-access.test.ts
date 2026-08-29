import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import type {
  ContainedTurnProviderAccessBinding,
  ProviderAccessProvider,
  RevalidateContainedTurnProviderAccessRejection,
} from "../dist/index.js";
import {
  createStaticContainedTurnProviderAccessFeature,
  type StaticAvailableProviderAccessAuthority,
  type StaticProviderAccessAuthority,
} from "../dist/composition.js";
import { createContainedTurnProviderAccessFeature } from "../dist/features/contained-turn-access/composition/feature-module-factory.js";

const binding = (
  overrides: Partial<StaticAvailableProviderAccessAuthority> = {},
): StaticAvailableProviderAccessAuthority => ({
  accessRef: "access:one",
  credentialBindingRef: "credential-binding:one",
  credentialGeneration: 1,
  kind: "binding",
  projectId: "project:one",
  provider: "codex",
  providerAccountRef: "provider-account:one",
  providerRouteRef: "provider-route:one",
  revision: 1,
  tenantId: "tenant:one",
  ...overrides,
});

const resolve = async (
  authorities: readonly StaticProviderAccessAuthority[],
  provider: ProviderAccessProvider = "codex",
  projectId = "project:one",
  tenantId = "tenant:one",
) => createStaticContainedTurnProviderAccessFeature(authorities).resolve.execute({
  provider,
  scope: { projectId, tenantId },
});

const resolvedBinding = async (
  authorities: readonly StaticProviderAccessAuthority[] = [binding()],
): Promise<ContainedTurnProviderAccessBinding> => {
  const outcome = await resolve(authorities);
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind !== "resolved") { throw new Error("expected resolved authority"); }
  return outcome.binding;
};

test("resolves and exactly replays one qualified owner-fact snapshot", async () => {
  const feature = createStaticContainedTurnProviderAccessFeature([binding()]);
  const input = { provider: "codex" as const, scope: { projectId: "project:one", tenantId: "tenant:one" } };
  const first = await feature.resolve.execute(input);
  const replay = await feature.resolve.execute(input);
  assert.deepEqual(replay, first);
  assert.equal(first.kind, "resolved");
  assert.equal(replay.kind, "resolved");
  if (first.kind !== "resolved" || replay.kind !== "resolved") { return; }
  assert.notEqual(first.binding, replay.binding);
  assert.ok(Object.isFrozen(first.binding));
  assert.deepEqual(Object.keys(first.binding).toSorted(), [
    "accessRef", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration",
    "projectId", "provider", "providerAccountRef", "providerRouteRef", "revision", "tenantId",
  ]);
});

test("exact lookup never falls back across tenant, project, or provider", async () => {
  assert.deepEqual(await resolve([binding()], "claude"), { kind: "unavailable", reason: "not_found" });
  assert.deepEqual(await resolve([binding()], "codex", "project:other"), { kind: "unavailable", reason: "not_found" });
  assert.deepEqual(await resolve([binding()], "codex", "project:one", "tenant:other"), {
    kind: "unavailable", reason: "not_found",
  });
});

test("resolve reports revoked, unavailable, and indeterminate observations", async () => {
  assert.deepEqual(await resolve([binding({ revocation: "revoked" })]), { kind: "unavailable", reason: "revoked" });
  assert.deepEqual(await resolve([binding({ availability: "unavailable" })]), {
    kind: "unavailable", reason: "unavailable",
  });
  assert.deepEqual(await resolve([{
    kind: "indeterminate",
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }]), { kind: "unavailable", reason: "indeterminate" });
});

test("revalidation uses fresh canonical authority and never returns expected caller data", async () => {
  const expected = await resolvedBinding();
  const feature = createStaticContainedTurnProviderAccessFeature([binding()]);
  const callerBinding = { ...expected };
  const pending = feature.revalidate.execute({
    binding: callerBinding,
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  callerBinding.providerRouteRef = "provider-route:caller-mutation";
  const result = await pending;
  const repeated = await feature.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(result.kind, "valid");
  assert.equal(repeated.kind, "valid");
  if (result.kind !== "valid" || repeated.kind !== "valid") { return; }
  assert.deepEqual(result.binding, expected);
  assert.notEqual(result.binding, expected);
  assert.notEqual(result.binding, repeated.binding);
  assert.ok(Object.isFrozen(result.binding));
});

test("one feature observes changed repository authority again during revalidation", async () => {
  const expected = await resolvedBinding();
  let revocation: "active" | "revoked" = "active";
  let observations = 0;
  const feature = createContainedTurnProviderAccessFeature({
    bindingRepository: {
      async observeExact() {
        observations += 1;
        return {
          kind: "found" as const,
          record: { ...expected, availability: "available" as const, revocation },
        };
      },
    },
  });
  assert.equal((await feature.resolve.execute({
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  })).kind, "resolved");
  revocation = "revoked";
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), { kind: "rejected", reason: "revoked" });
  assert.equal(observations, 2);
});

test("revalidation rejects caller scope, provider, and digest mismatches", async () => {
  const expected = await resolvedBinding();
  const feature = createStaticContainedTurnProviderAccessFeature([binding()]);
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:other", tenantId: "tenant:one" },
  }), { kind: "rejected", reason: "scope_mismatch" });
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:other" },
  }), { kind: "rejected", reason: "scope_mismatch" });
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "claude",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), { kind: "rejected", reason: "provider_mismatch" });
  assert.deepEqual(await feature.revalidate.execute({
    binding: { ...expected, credentialBindingDigest: "sha256:caller-supplied-digest" },
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), { kind: "rejected", reason: "credential_changed" });
});

test("revalidation has typed changed, rotated, revoked, unavailable, missing, and indeterminate outcomes", async () => {
  const expected = await resolvedBinding();
  const cases: readonly [StaticProviderAccessAuthority | undefined, RevalidateContainedTurnProviderAccessRejection][] = [
    [binding({ accessRef: "access:two" }), "access_changed"],
    [binding({ revision: 2 }), "revision_changed"],
    [binding({ providerAccountRef: "provider-account:two" }), "account_changed"],
    [binding({ providerRouteRef: "provider-route:two" }), "route_changed"],
    [binding({ credentialGeneration: 2 }), "credential_rotated"],
    [binding({ credentialBindingRef: "credential-binding:two" }), "credential_changed"],
    [binding({ revocation: "revoked" }), "revoked"],
    [binding({ availability: "unavailable" }), "unavailable"],
    [undefined, "not_found"],
    [{ kind: "indeterminate", provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" } }, "indeterminate"],
  ];
  for (const [authority, reason] of cases) {
    const feature = createStaticContainedTurnProviderAccessFeature(authority === undefined ? [] : [authority]);
    assert.deepEqual(await feature.revalidate.execute({
      binding: expected,
      provider: "codex",
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), { kind: "rejected", reason });
  }
});

test("credential digest covers every canonical non-secret owner fact", async () => {
  const original = binding();
  const originalDigest = (await resolvedBinding([original])).credentialBindingDigest;
  const variants: readonly StaticAvailableProviderAccessAuthority[] = [
    binding({ accessRef: "access:two" }),
    binding({ credentialBindingRef: "credential-binding:two" }),
    binding({ credentialGeneration: 2 }),
    binding({ projectId: "project:two" }),
    binding({ provider: "claude" }),
    binding({ providerAccountRef: "provider-account:two" }),
    binding({ providerRouteRef: "provider-route:two" }),
    binding({ revision: 2 }),
    binding({ tenantId: "tenant:two" }),
  ];
  for (const variant of variants) {
    const outcome = await resolve([variant], variant.provider, variant.projectId, variant.tenantId);
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind === "resolved") { assert.notEqual(outcome.binding.credentialBindingDigest, originalDigest); }
  }
  assert.match(originalDigest, /^sha256:[a-f0-9]{64}$/u);
});

test("static composition snapshots inputs and isolates every returned mutation", async () => {
  const source = binding();
  const feature = createStaticContainedTurnProviderAccessFeature([source]);
  source.providerRouteRef = "provider-route:mutated";
  const outcome = await feature.resolve.execute({
    provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind !== "resolved") { return; }
  assert.equal(outcome.binding.providerRouteRef, "provider-route:one");
  assert.throws(() => {
    (outcome.binding as { providerRouteRef: string }).providerRouteRef = "provider-route:attempted";
  }, TypeError);
});

test("rejects duplicate exact authority and invalid revisions or generations", () => {
  assert.throws(() => createStaticContainedTurnProviderAccessFeature([binding(), binding()]), /duplicate exact-scope/u);
  assert.throws(() => createStaticContainedTurnProviderAccessFeature([binding({ revision: 0 })]), /revision/u);
  assert.throws(() => createStaticContainedTurnProviderAccessFeature([binding({ credentialGeneration: 0 })]), /credentialGeneration/u);
});

const sourceFiles = async (directory: URL): Promise<readonly URL[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    return entry.isDirectory() ? sourceFiles(url) : entry.name.endsWith(".ts") ? [url] : [];
  }));
  return nested.flat();
};

test("domain and application point inward and curated declarations leak no feature internals", async () => {
  const featureRoot = new URL("../src/features/contained-turn-access/", import.meta.url);
  for (const layer of ["domain/", "application/"]) {
    for (const file of await sourceFiles(new URL(layer, featureRoot))) {
      assert.doesNotMatch(await readFile(file, "utf8"), /\/contracts\//u);
    }
  }
  const index = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
  const composition = await readFile(new URL("../dist/composition.d.ts", import.meta.url), "utf8");
  for (const declaration of [index, composition]) {
    assert.doesNotMatch(
      declaration,
      /ProviderAccessBindingRecord|ProviderAccessBindingRepository|createStaticProviderAccessBindingRepository|adapters\/|domain\//u,
    );
  }
});

test("package sources, contracts, diagnostics, and fixtures contain no credential or private-path material", async () => {
  const allText = await Promise.all((await sourceFiles(new URL("../", import.meta.url))).map(file => readFile(file, "utf8")));
  const forbidden = [
    ["raw", "Credential"].join(""),
    ["secret", "Value"].join(""),
    ["credential", "Bytes"].join(""),
    ["private", "Home", "Lease", "Ref"].join(""),
    ["lease", "Path"].join(""),
    ["home", "Path"].join(""),
  ];
  for (const text of allText) {
    for (const token of forbidden) { assert.equal(text.includes(token), false); }
  }
});
