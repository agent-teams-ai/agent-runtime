import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import type {
  ContainedTurnProviderAccessBinding,
  ProviderAccessProvider,
  RevalidateContainedTurnProviderAccessRejection,
} from "../../../dist/index.js";
import {
  createStaticContainedTurnProviderAccessFeature,
  type StaticAvailableProviderAccessAuthority,
  type StaticProviderAccessAuthority,
} from "../../../dist/composition.js";
import { createContainedTurnProviderAccessFeature } from "../../../dist/features/contained-turn-access/internal.js";

const binding = (
  overrides: Partial<StaticAvailableProviderAccessAuthority> = {},
): StaticAvailableProviderAccessAuthority => ({
  accessRef: "access:one",
  credentialBindingDigest: "authority-digest:one",
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

const rejectionEvidence = (reason: string, purpose: "acceptance" | "dispatch") => ({
  authorityDigest: JSON.stringify({ purpose, reason, version: 1 }),
  bindingAuthorityDigest: `authority-observation:${reason}`,
  proofRef: `observation:${reason}:purpose:${purpose}`,
  purpose,
});

const unavailable = (reason: string) => ({
  evidence: rejectionEvidence(reason, "acceptance"),
  kind: "unavailable",
  reason,
});

const rejectedOutcome = (reason: string) => ({
  evidence: rejectionEvidence(reason, "dispatch"),
  kind: "rejected",
  reason,
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
  assert.deepEqual(await resolve([binding()], "claude"), unavailable("not_found"));
  assert.deepEqual(await resolve([binding()], "codex", "project:other"), unavailable("not_found"));
  assert.deepEqual(await resolve([binding()], "codex", "project:one", "tenant:other"), unavailable("not_found"));
});

test("delimiter-like scope values coexist without key collisions", async () => {
  const first = binding({
    accessRef: "access:first",
    projectId: `project\u0001codex`,
    tenantId: "tenant",
  });
  const second = binding({
    accessRef: "access:second",
    projectId: "codex",
    tenantId: `tenant\u0001project`,
  });
  const feature = createStaticContainedTurnProviderAccessFeature([first, second]);
  const [firstResult, secondResult] = await Promise.all([
    feature.resolve.execute({ provider: "codex", scope: { projectId: first.projectId, tenantId: first.tenantId } }),
    feature.resolve.execute({ provider: "codex", scope: { projectId: second.projectId, tenantId: second.tenantId } }),
  ]);
  assert.equal(firstResult.kind, "resolved");
  assert.equal(secondResult.kind, "resolved");
  if (firstResult.kind !== "resolved" || secondResult.kind !== "resolved") { return; }
  assert.equal(firstResult.binding.accessRef, "access:first");
  assert.equal(secondResult.binding.accessRef, "access:second");
});

test("concurrent repository reads return detached immutable identities", async () => {
  const feature = createStaticContainedTurnProviderAccessFeature([binding()]);
  const input = { provider: "codex" as const, scope: { projectId: "project:one", tenantId: "tenant:one" } };
  const [first, second] = await Promise.all([
    feature.resolve.execute(input),
    feature.resolve.execute(input),
  ]);
  assert.equal(first.kind, "resolved");
  assert.equal(second.kind, "resolved");
  if (first.kind !== "resolved" || second.kind !== "resolved") { return; }
  assert.notEqual(first.binding, second.binding);
  assert.ok(Object.isFrozen(first.binding));
  assert.ok(Object.isFrozen(second.binding));
});

test("resolve reports revoked, unavailable, and indeterminate observations", async () => {
  assert.deepEqual(await resolve([binding({ revocation: "revoked" })]), unavailable("revoked"));
  assert.deepEqual(await resolve([binding({ availability: "unavailable" })]), unavailable("unavailable"));
  assert.deepEqual(await resolve([{
    kind: "indeterminate",
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }]), unavailable("indeterminate"));
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
  }), rejectedOutcome("revoked"));
  assert.equal(observations, 2);
});

test("composition captures one detached exact repository method and remains byte-stable", async () => {
  const currentBinding = await resolvedBinding();
  const record = { ...currentBinding, availability: "available" as const, revocation: "active" as const };
  const observation = { kind: "found" as const, record };
  const observationBytes = JSON.stringify(observation);
  let calls = 0;
  const repository = {
    async observeExact() {
      assert.notEqual(this, repository);
      calls += 1;
      return observation;
    },
  };
  const feature = createContainedTurnProviderAccessFeature({ bindingRepository: repository });
  repository.observeExact = async () => ({
    kind: "found" as const,
    record: { ...record, providerAccountRef: "provider-account:substituted" },
  });
  const input = { provider: "codex" as const, scope: { projectId: "project:one", tenantId: "tenant:one" } };
  const first = await feature.resolve.execute(input);
  const replay = await feature.resolve.execute(input);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(observation), observationBytes);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(first.kind, "resolved");
  if (first.kind !== "resolved") { return; }
  assert.equal(first.binding.providerAccountRef, "provider-account:one");
});

test("composition rejects repository proxies and accessors without invoking traps", async () => {
  let traps = 0;
  let getters = 0;
  const handler: ProxyHandler<object> = {
    get() { traps += 1; throw new Error("get trap must not run"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("descriptor trap must not run"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap must not run"); },
    ownKeys() { traps += 1; throw new Error("keys trap must not run"); },
  };
  const proxiedRepository = new Proxy({ async observeExact() { return { kind: "not_found" as const }; } }, handler);
  assert.throws(
    () => createContainedTurnProviderAccessFeature({ bindingRepository: proxiedRepository }),
    /plain data record/u,
  );
  const dependencyAccessor = Object.defineProperty({}, "bindingRepository", {
    enumerable: true,
    get() { getters += 1; return proxiedRepository; },
  });
  assert.throws(() => createContainedTurnProviderAccessFeature(dependencyAccessor as never), /accessors/u);
  const repositoryAccessor = Object.defineProperty({}, "observeExact", {
    enumerable: true,
    get() { getters += 1; return async () => ({ kind: "not_found" as const }); },
  });
  assert.throws(
    () => createContainedTurnProviderAccessFeature({ bindingRepository: repositoryAccessor } as never),
    /accessors/u,
  );
  const proxiedMethod = new Proxy(async () => ({ kind: "not_found" as const }), handler);
  assert.throws(
    () => createContainedTurnProviderAccessFeature({ bindingRepository: { observeExact: proxiedMethod } }),
    /stable method/u,
  );
  assert.equal(traps, 0);
  assert.equal(getters, 0);
});

test("composition rejects direct, intrinsic-bound, and native-exotic injected callables before invocation", () => {
  type InjectedMethod = (...args: never[]) => unknown;
  const runtimeTypes = (process.getBuiltinModule("node:util") as {
    readonly types: { readonly isProxy: (value: unknown) => boolean };
  }).types;
  let applyTraps = 0;
  const directProxy = new Proxy(async () => ({ kind: "not_found" as const }), {
    apply() { applyTraps += 1; throw new Error("direct proxy apply trap"); },
  });
  const proxiedTarget = new Proxy(async () => ({ kind: "not_found" as const }), {
    apply() { applyTraps += 1; throw new Error("bound proxy apply trap"); },
  });
  const boundProxy = Reflect.apply(Function.prototype.bind, proxiedTarget, [Object.freeze({})]) as InjectedMethod;
  assert.equal(runtimeTypes.isProxy(boundProxy), false);
  const boundNativeReceiver: unknown[] = [];
  const boundNative = Reflect.apply(Function.prototype.bind, Array.prototype.push, [boundNativeReceiver]) as InjectedMethod;
  const cases: readonly [string, InjectedMethod][] = [
    ["direct Proxy", directProxy as InjectedMethod],
    ["bound Proxy", boundProxy],
    ["bound native", boundNative],
  ];
  for (const [name, method] of cases) {
    assert.throws(
      () => createContainedTurnProviderAccessFeature({ bindingRepository: { observeExact: method } } as never),
      /stable method/u,
      name,
    );
  }
  assert.deepEqual(boundNativeReceiver, []);
  assert.equal(applyTraps, 0);
});

test("public observation boundary rejects aggregate proxies without invoking traps", async () => {
  let traps = 0;
  const handler: ProxyHandler<object> = {
    get() { traps += 1; throw new Error("get trap must not run"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("descriptor trap must not run"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap must not run"); },
    ownKeys() { traps += 1; throw new Error("keys trap must not run"); },
  };
  const record = { ...binding(), availability: "available" as const, revocation: "active" as const };
  const observations = [
    new Proxy({ kind: "found" as const, record }, handler),
    { kind: "found" as const, record: new Proxy(record, handler) },
  ];
  for (const observation of observations) {
    const feature = createContainedTurnProviderAccessFeature({
      bindingRepository: { observeExact() { return observation; } },
    } as never);
    assert.deepEqual(await feature.resolve.execute({
      provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), unavailable("indeterminate"));
  }
  assert.equal(traps, 0);
});

test("untrusted repository scope and provider mismatches fail closed", async () => {
  const expected = await resolvedBinding();
  const records = [
    [{ ...expected, availability: "available" as const, revocation: "active" as const, tenantId: "tenant:wrong" }, "scope_mismatch"],
    [{ ...expected, availability: "available" as const, revocation: "active" as const, projectId: "project:wrong" }, "scope_mismatch"],
    [{ ...expected, availability: "available" as const, revocation: "active" as const, provider: "claude" as const }, "provider_mismatch"],
  ];
  for (const [record, reason] of records) {
    const feature = createContainedTurnProviderAccessFeature({
      bindingRepository: { async observeExact() { return { kind: "found" as const, record }; } },
    });
    assert.deepEqual(await feature.resolve.execute({
      provider: "codex",
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), unavailable("indeterminate"));
    assert.deepEqual(await feature.revalidate.execute({
      binding: expected,
      provider: "codex",
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), rejectedOutcome(reason));
  }
});

test("malformed, oversized, and NUL-bearing repository observations are indeterminate", async () => {
  const expected = await resolvedBinding();
  const records: readonly unknown[] = [
    { ...expected, availability: "unknown", revocation: "active" },
    { ...expected, availability: "available", revocation: "unknown" },
    { ...expected, accessRef: "x".repeat(4_097), availability: "available", revocation: "active" },
    { ...expected, providerRouteRef: "route\u0000hidden", availability: "available", revocation: "active" },
  ];
  const observations: readonly unknown[] = [
    { kind: "unexpected" },
    ...records.map((record) => ({ kind: "found", record })),
  ];
  for (const observation of observations) {
    const feature = createContainedTurnProviderAccessFeature({
      bindingRepository: { async observeExact() { return observation; } },
    } as never);
    assert.deepEqual(await feature.resolve.execute({
      provider: "codex",
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), unavailable("indeterminate"));
    assert.deepEqual(await feature.revalidate.execute({
      binding: expected,
      provider: "codex",
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), rejectedOutcome("indeterminate"));
  }
});

test("revalidation rejects current repository digest-only drift", async () => {
  const expected = await resolvedBinding();
  const feature = createContainedTurnProviderAccessFeature({
    bindingRepository: {
      async observeExact() {
        return {
          kind: "found" as const,
          record: {
            ...expected,
            availability: "available" as const,
            credentialBindingDigest: "sha256:different-owner-facts-digest",
            revocation: "active" as const,
          },
        };
      },
    },
  });
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), rejectedOutcome("credential_changed"));
});

test("revalidation rejects caller scope, provider, and digest mismatches", async () => {
  const expected = await resolvedBinding();
  const feature = createStaticContainedTurnProviderAccessFeature([binding()]);
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:other", tenantId: "tenant:one" },
  }), rejectedOutcome("scope_mismatch"));
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:other" },
  }), rejectedOutcome("scope_mismatch"));
  assert.deepEqual(await feature.revalidate.execute({
    binding: expected,
    provider: "claude",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), rejectedOutcome("provider_mismatch"));
  assert.deepEqual(await feature.revalidate.execute({
    binding: { ...expected, credentialBindingDigest: "sha256:caller-supplied-digest" },
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), rejectedOutcome("credential_changed"));
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
    }), rejectedOutcome(reason));
  }
});

test("credential digest is an opaque authority-issued non-secret owner fact", async () => {
  const opaqueDigest = "authority-issued:opaque-owner-facts:v7";
  const outcome = await resolvedBinding([binding({ credentialBindingDigest: opaqueDigest })]);
  assert.equal(outcome.credentialBindingDigest, opaqueDigest);
});

test("primitive-string validation rejects boxed, aggregate, proxy, and accessor-like values", async () => {
  let accidentalAccess = false;
  const accessorLike = Object.defineProperties({}, {
    includes: { get() { accidentalAccess = true; throw new Error("must not inspect includes"); } },
    length: { get() { accidentalAccess = true; throw new Error("must not inspect length"); } },
  });
  const proxy = new Proxy({}, {
    get() { accidentalAccess = true; throw new Error("must not inspect proxy"); },
  });
  const invalidValues: readonly unknown[] = [null, 7, true, [], {}, new String("boxed"), accessorLike, proxy];
  for (const value of invalidValues) {
    const feature = createContainedTurnProviderAccessFeature({
      bindingRepository: {
        async observeExact() {
          return {
            kind: "found" as const,
            record: { ...binding(), availability: "available" as const, accessRef: value, revocation: "active" as const },
          };
        },
      },
    } as never);
    assert.deepEqual(await feature.resolve.execute({
      provider: "codex",
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), unavailable("indeterminate"));
  }
  assert.equal(accidentalAccess, false);
});

test("ill-formed Unicode is rejected while valid surrogate pairs remain lossless", async () => {
  for (const accessRef of ["lone-high:\ud800", "lone-low:\udc00"]) {
    assert.throws(() => createStaticContainedTurnProviderAccessFeature([binding({ accessRef })]), /well-formed Unicode/u);
  }
  const accessRef = "paired:\ud83d\ude80";
  assert.equal((await resolvedBinding([binding({ accessRef })])).accessRef, accessRef);
});

test("public commands fail closed for null, primitive, boxed, proxy, and throwing scope values", async () => {
  const feature = createStaticContainedTurnProviderAccessFeature([binding()]);
  const expected = await resolvedBinding();
  const invalidResolve = unavailable("indeterminate");
  const invalidRevalidation = rejectedOutcome("indeterminate");
  const throwing = Object.defineProperty({}, "projectId", { get() { throw new Error("boom"); } });
  const values: readonly unknown[] = [null, undefined, 1, "scope", [], new String("scope"), new Proxy({}, { get() { throw new Error("boom"); } }), throwing];
  for (const scope of values) {
    assert.deepEqual(await feature.resolve.execute({ provider: "codex", scope } as never), invalidResolve);
    assert.deepEqual(await feature.revalidate.execute({ binding: expected, provider: "codex", scope } as never), invalidRevalidation);
  }
  assert.deepEqual(await feature.resolve.execute({ provider: new String("codex"), scope: {} } as never), invalidResolve);
});

test("null, primitive, missing, throwing, and rejected repository observations fail closed", async () => {
  const expected = await resolvedBinding();
  const throwingObservation = Object.defineProperty({}, "kind", { get() { throw new Error("boom"); } });
  const throwingRecord = Object.defineProperty({}, "availability", { get() { throw new Error("boom"); } });
  const observations: readonly unknown[] = [
    null, undefined, false, 0, "found", { kind: "found" }, throwingObservation, { kind: "found", record: throwingRecord },
  ];
  for (const observation of observations) {
    const feature = createContainedTurnProviderAccessFeature({
      bindingRepository: { async observeExact() { return observation; } },
    } as never);
    assert.deepEqual(await feature.resolve.execute({
      provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), unavailable("indeterminate"));
    assert.deepEqual(await feature.revalidate.execute({
      binding: expected,
      provider: "codex",
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), rejectedOutcome("indeterminate"));
  }
  const rejected = createContainedTurnProviderAccessFeature({
    bindingRepository: { async observeExact() { throw new Error("repository unavailable"); } },
  });
  assert.deepEqual(await rejected.resolve.execute({
    provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), unavailable("indeterminate"));
  assert.deepEqual(await rejected.revalidate.execute({
    binding: expected,
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), rejectedOutcome("indeterminate"));
});

test("canonical repository observations reject accessors without invoking them", async () => {
  let availabilityReads = 0;
  let revocationReads = 0;
  const record = {
    ...binding(),
    get availability() {
      availabilityReads += 1;
      return availabilityReads === 1 ? "available" as const : "unavailable" as const;
    },
    get revocation() {
      revocationReads += 1;
      return revocationReads === 1 ? "active" as const : "revoked" as const;
    },
  };
  const feature = createContainedTurnProviderAccessFeature({
    bindingRepository: { async observeExact() { return { kind: "found" as const, record }; } },
  });
  assert.deepEqual(await feature.resolve.execute({
    provider: "codex",
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }), unavailable("indeterminate"));
  assert.equal(availabilityReads, 0);
  assert.equal(revocationReads, 0);
});

test("legacy repository observations reject unknown, proxy, accessor, and substituted path data", async () => {
  const expected = await resolvedBinding();
  let observationGetterReads = 0;
  let recordGetterReads = 0;
  const observationAccessor = Object.defineProperty({}, "kind", {
    enumerable: true, get() { observationGetterReads += 1; return "found"; },
  });
  const recordAccessor = { ...binding(), availability: "available", revocation: "active" } as Record<string, unknown>;
  Object.defineProperty(recordAccessor, "providerRouteRef", {
    enumerable: true, get() { recordGetterReads += 1; return "provider-route:one"; },
  });
  const observations: readonly unknown[] = [
    { kind: "found", record: { ...binding(), availability: "available", revocation: "active", secret: "substituted" } },
    { kind: "found", record: { ...binding(), availability: "available", revocation: "active", path: "/provider/home" } },
    new Proxy({ kind: "found", record: { ...binding(), availability: "available", revocation: "active" } }, {}),
    observationAccessor,
    { kind: "found", record: recordAccessor },
  ];
  for (const observation of observations) {
    const feature = createContainedTurnProviderAccessFeature({
      bindingRepository: { async observeExact() { return observation; } },
    } as never);
    assert.deepEqual(await feature.resolve.execute({
      provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), unavailable("indeterminate"));
    assert.deepEqual(await feature.revalidate.execute({
      binding: expected, provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" },
    }), rejectedOutcome("indeterminate"));
  }
  assert.equal(observationGetterReads, 0);
  assert.equal(recordGetterReads, 0);
});

test("legacy public mapping rejects unknown fields, proxies, and accessors without invoking getters", async () => {
  const feature = createStaticContainedTurnProviderAccessFeature([binding()]);
  const expected = await resolvedBinding();
  let outerGetterReads = 0;
  let bindingGetterReads = 0;
  const resolveAccessor = Object.defineProperty({ scope: { projectId: "project:one", tenantId: "tenant:one" } }, "provider", {
    enumerable: true, get() { outerGetterReads += 1; return "codex"; },
  });
  const bindingAccessor = { ...expected } as Record<string, unknown>;
  Object.defineProperty(bindingAccessor, "providerRouteRef", {
    enumerable: true, get() { bindingGetterReads += 1; return "provider-route:one"; },
  });
  for (const input of [
    { provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" }, unknown: true },
    new Proxy({ provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" } }, {}),
    resolveAccessor,
  ]) {
    assert.deepEqual(await feature.resolve.execute(input as never), unavailable("indeterminate"));
  }
  for (const input of [
    { binding: expected, provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" }, secret: "substituted" },
    { binding: bindingAccessor, provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" } },
    new Proxy({ binding: expected, provider: "codex", scope: { projectId: "project:one", tenantId: "tenant:one" } }, {}),
  ]) {
    assert.deepEqual(await feature.revalidate.execute(input as never), rejectedOutcome("indeterminate"));
  }
  assert.equal(outerGetterReads, 0);
  assert.equal(bindingGetterReads, 0);
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

test("static persistence boundary rejects proxies and accessors without invoking traps", () => {
  let traps = 0;
  let getters = 0;
  const handler: ProxyHandler<object> = {
    get() { traps += 1; throw new Error("get trap must not run"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("descriptor trap must not run"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap must not run"); },
    ownKeys() { traps += 1; throw new Error("keys trap must not run"); },
  };
  const proxiedAuthorities = new Proxy([binding()], handler);
  assert.throws(() => createStaticContainedTurnProviderAccessFeature(proxiedAuthorities), /stable array/u);
  assert.throws(
    () => createStaticContainedTurnProviderAccessFeature([new Proxy(binding(), handler)]),
    /plain data record/u,
  );
  const accessorAuthority = { ...binding() } as Record<string, unknown>;
  Object.defineProperty(accessorAuthority, "accessRef", {
    enumerable: true,
    get() { getters += 1; return "access:trap"; },
  });
  assert.throws(
    () => createStaticContainedTurnProviderAccessFeature([accessorAuthority] as never),
    /accessors/u,
  );
  assert.equal(traps, 0);
  assert.equal(getters, 0);
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
  const featureRoot = new URL("../../../src/features/contained-turn-access/", import.meta.url);
  for (const layer of ["domain/", "application/"]) {
    for (const file of await sourceFiles(new URL(layer, featureRoot))) {
      assert.doesNotMatch(await readFile(file, "utf8"), /\/contracts\//u);
    }
  }
  const index = await readFile(new URL("../../../dist/index.d.ts", import.meta.url), "utf8");
  const composition = await readFile(new URL("../../../dist/composition.d.ts", import.meta.url), "utf8");
  for (const declaration of [index, composition]) {
    assert.doesNotMatch(
      declaration,
      /ProviderAccessBindingRecord|ProviderAccessBindingRepository|createStaticProviderAccessBindingRepository|adapters\/|domain\//u,
    );
  }
});

test("package sources, contracts, diagnostics, and fixtures contain no credential or private-path material", async () => {
  const allText = await Promise.all((await sourceFiles(new URL("../../../", import.meta.url))).map(file => readFile(file, "utf8")));
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
