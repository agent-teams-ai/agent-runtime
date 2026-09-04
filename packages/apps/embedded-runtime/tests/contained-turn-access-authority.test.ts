import assert from "node:assert/strict";
import test from "node:test";

import {
  copyContainedTurnAccessAuthority,
  isContainedTurnAccessAuthorityIdentity,
  matchesContainedTurnAccessAuthority,
} from "../dist/composition/contained-turn-access-authority.js";

const authority = () => ({
  authorityRevision: "runtime-access-authority:one",
  projectId: "project:one",
  tenantId: "tenant:one",
});

test("authority is a detached immutable snapshot of all three trusted facts", () => {
  const original = authority();
  const bound = copyContainedTurnAccessAuthority(original)!;
  assert.deepEqual(bound, original);
  assert.notEqual(bound, original);
  assert.equal(Object.isFrozen(bound), true);
  original.authorityRevision = "runtime-access-authority:two";
  original.projectId = "project:two";
  original.tenantId = "tenant:two";
  assert.deepEqual(bound, authority());
  assert.equal(Reflect.set(bound, "authorityRevision", original.authorityRevision), false);
});

test("matching requires tenant, project, and the exact independent revision", () => {
  const bound = copyContainedTurnAccessAuthority(authority())!;
  assert.equal(matchesContainedTurnAccessAuthority(authority(), bound), true);
  for (const field of ["authorityRevision", "projectId", "tenantId"] as const) {
    const other = { ...authority(), [field]: `${bound[field]}-other` };
    assert.equal(matchesContainedTurnAccessAuthority(other, bound), false);
  }
});

test("authority rejects getters and proxies without executing their traps", () => {
  let reads = 0;
  const hostile = () => { reads += 1; throw new Error("private sentinel"); };
  for (const field of ["authorityRevision", "projectId", "tenantId"]) {
    const value = Object.defineProperty(authority(), field, { get: hostile });
    assert.equal(copyContainedTurnAccessAuthority(value), undefined);
  }
  const proxy = new Proxy(authority(), {
    get: hostile, getOwnPropertyDescriptor: hostile, getPrototypeOf: hostile, ownKeys: hostile,
  });
  assert.equal(copyContainedTurnAccessAuthority(proxy), undefined);
  const revoked = Proxy.revocable(authority(), {});
  revoked.revoke();
  assert.equal(copyContainedTurnAccessAuthority(revoked.proxy), undefined);
  assert.equal(reads, 0);
});

test("revision is bounded and disjoint from CAS and other identity namespaces", () => {
  for (const authorityRevision of [
    1, "1", "", "runtime-access-authority:", "runtime-access-authority:a/b",
    "runtime-access-authority:a\n", `runtime-access-authority:${"a".repeat(106)}`,
    ...["operation", "effect", "attempt", "command", "receipt", "workspace", "host",
      "boot", "custody", "module", "module-generation", "plan", "loaded-head", "lifecycle"]
      .map(namespace => `${namespace}:one`),
  ]) {
    assert.equal(copyContainedTurnAccessAuthority({ ...authority(), authorityRevision }), undefined);
  }
  assert.ok(copyContainedTurnAccessAuthority({
    ...authority(), authorityRevision: `runtime-access-authority:${"a".repeat(103)}`,
  }));
  for (const field of ["projectId", "tenantId"]) {
    assert.equal(copyContainedTurnAccessAuthority({
      ...authority(), [field]: authority().authorityRevision,
    }), undefined);
  }
  assert.equal(isContainedTurnAccessAuthorityIdentity(authority().authorityRevision), true);
  assert.equal(isContainedTurnAccessAuthorityIdentity("operation:one"), false);
});

test("authority accepts existing scope limits and refuses hidden or extra authority", () => {
  assert.ok(copyContainedTurnAccessAuthority({
    ...authority(), projectId: "p".repeat(512), tenantId: "t".repeat(512),
  }));
  for (const value of [
    null, undefined, [], Object.create(authority()),
    { ...authority(), projectId: "p".repeat(513) },
    { ...authority(), tenantId: "" }, { ...authority(), projectId: "p\0" },
    { ...authority(), revision: 7 }, { ...authority(), [Symbol("hidden")]: true },
  ]) {
    assert.equal(copyContainedTurnAccessAuthority(value), undefined);
  }
});

import {
  AgentRuntimeHostDisposalIncompleteError,
  bindContainedTurnCapabilityAuthority,
  ContainedTurnOwnerContractError,
  createAgentRuntimeHost,
  type AuthorityBoundContainedTurnCapability,
  type ContainedTurnCapabilityBundle,
} from "../dist/composition.js";

const unavailable = (): never => { throw new Error("setup must not run"); };
const setup = {
  claudeCodeSetup: {
    authorizeClaudeCodeSetupInspection: { execute: unavailable },
    discoverClaudeCodeInstallations: { execute: unavailable },
    inspectClaudeCodeConfiguration: { execute: unavailable },
    planClaudeCodeSetupInspection: { plan: unavailable },
  },
  codexSetup: {
    authorizeSetupInspection: { execute: unavailable },
    discoverCodexInstallations: { execute: unavailable },
    inspectCodexConfiguration: { execute: unavailable },
    planCodexSetupInspection: { plan: unavailable },
  },
};
const scope = () => ({ projectId: "project:one", tenantId: "tenant:one" });
const input = () => ({
  commandId: "command:one", expectedProvider: "synthetic",
  intent: { mode: "analysis" as const, prompt: "synthetic contained turn" },
});
const turn = () => ({
  operationId: "operation:one", commandId: "command:one", effectId: "effect:one",
  provider: "synthetic", revision: 9, status: "succeeded" as const,
  artifactManifestRef: "artifact:one", resultRef: "result:one", output: [],
});
const envelope = (outcome: unknown, binding: unknown = authority()) => ({ authority: binding, outcome });
const observed = () => ({ status: "observed", turn: turn() });
const boundedOwner = (execute: () => Promise<unknown>): AuthorityBoundContainedTurnCapability => ({
  authorityRevision: authority().authorityRevision,
  cancel: { execute }, observe: { execute }, submit: { execute },
});
const assertSafeError = (error: unknown): boolean => {
  assert.ok(error instanceof ContainedTurnOwnerContractError);
  assert.equal(error.message, "Contained-turn owner contract violation");
  assert.doesNotMatch(JSON.stringify(error), /runtime-access-authority|private sentinel/u);
  return true;
};

test("trusted owner composition pins revision and caller methods remain detached DTOs", async () => {
  const rawScopes: unknown[] = [];
  const ownerTurn = turn();
  const raw: ContainedTurnCapabilityBundle = {
    cancel: { async execute(ref) { rawScopes.push(ref.scope); return { status: "observed", turn: ownerTurn }; } },
    observe: { async execute(ref) { rawScopes.push(ref.scope); return { status: "observed", turn: ownerTurn }; } },
    submit: { async execute(command, options) {
      rawScopes.push(command.scope);
      options?.onAccepted?.({ operationId: ownerTurn.operationId, scope: command.scope });
      return { status: "observed", turn: ownerTurn };
    } },
  };
  const capability = { ...bindContainedTurnCapabilityAuthority(raw, authority().authorityRevision) };
  const host = createAgentRuntimeHost({ ...setup, containedTurn: capability });
  const mutableScope = scope();
  const handle = host.bindAccess({ containedTurn: mutableScope });
  mutableScope.projectId = "project:changed";
  mutableScope.tenantId = "tenant:changed";
  capability.authorityRevision = "runtime-access-authority:changed";
  raw.observe.execute = async () => { throw new Error("mutated method must not run"); };
  const callerInput = { ...input(), scope: mutableScope, authority: authority(), authorityRevision: capability.authorityRevision };
  const accepted = await handle.containedTurn.submit(callerInput);
  assert.deepEqual(accepted, { operationId: "operation:one", status: "accepted" });
  const { observe, cancel } = handle.containedTurn;
  const observation = await observe("operation:one");
  const cancellation = await cancel("operation:one");
  assert.equal(observation.status, "observed");
  assert.equal(cancellation.status, "observed");
  assert.deepEqual(rawScopes, [scope(), scope(), scope()]);
  for (const rawScope of rawScopes) { assert.equal(Object.isFrozen(rawScope), true); }
  assert.deepEqual(Reflect.ownKeys(handle.containedTurn).sort(), ["cancel", "observe", "submit"]);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(Object.isFrozen(handle.containedTurn), true);
  assert.doesNotMatch(JSON.stringify([handle, accepted, observation, cancellation]), /authority|revision|scope|dispose/u);
  ownerTurn.resultRef = "result:changed";
  if (observation.status === "observed") {
    assert.equal(observation.turn.resultRef, "result:one");
    assert.equal(Object.isFrozen(observation.turn), true);
    assert.equal(Object.isFrozen(observation.turn.output), true);
  }
  await host.dispose();
});

test("a capability refuses cross-revision or mismatched-scope commands before invoking its owner", async () => {
  let calls = 0;
  const execute = async () => { calls += 1; return observed(); };
  const bound = bindContainedTurnCapabilityAuthority({
    cancel: { execute }, observe: { execute }, submit: { execute },
  }, authority().authorityRevision);
  for (const binding of [
    { ...authority(), authorityRevision: "runtime-access-authority:two" },
    { ...authority(), tenantId: "tenant:two" }, { ...authority(), projectId: "project:two" },
  ]) {
    const ref = { operationId: "operation:one", scope: scope(), authority: binding };
    await assert.rejects(bound.cancel.execute(ref), assertSafeError);
    await assert.rejects(bound.observe.execute(ref), assertSafeError);
    await assert.rejects(bound.submit.execute({ ...input(), scope: scope(), authority: binding }), assertSafeError);
  }
  assert.equal(calls, 0);
});

test("submit, observe, and cancel reject owner envelopes from another authority", async () => {
  for (const binding of [
    undefined, { ...authority(), authorityRevision: "runtime-access-authority:two" },
    { ...authority(), tenantId: "tenant:two" }, { ...authority(), projectId: "project:two" },
  ]) {
    const host = createAgentRuntimeHost({ ...setup, containedTurn: boundedOwner(async () => ({
      authority: binding, outcome: observed(),
    })) });
    const access = host.bindAccess({ containedTurn: scope() }).containedTurn;
    await assert.rejects(access.submit(input()), assertSafeError);
    await assert.rejects(access.observe("operation:one"), assertSafeError);
    await assert.rejects(access.cancel("operation:one"), assertSafeError);
    await host.dispose();
  }
});

test("hostile outcome envelopes fail closed without reading getters or proxy traps", async () => {
  let reads = 0;
  const trap = () => { reads += 1; throw new Error("private sentinel"); };
  const proxy = new Proxy(envelope(observed()), { getOwnPropertyDescriptor: trap, getPrototypeOf: trap, ownKeys: trap });
  const revoked = Proxy.revocable(envelope(observed()), {});
  revoked.revoke();
  for (const value of [
    proxy, revoked.proxy,
    Object.defineProperty(envelope(observed()), "authority", { get: trap }),
    Object.defineProperty(envelope(observed()), "outcome", { get: trap }),
    envelope(observed(), Object.defineProperty(authority(), "authorityRevision", { get: trap })),
  ]) {
    const host = createAgentRuntimeHost({ ...setup, containedTurn: boundedOwner(async () => value) });
    const access = host.bindAccess({ containedTurn: scope() }).containedTurn;
    await assert.rejects(access.submit(input()), assertSafeError);
    await assert.rejects(access.observe("operation:one"), assertSafeError);
    await assert.rejects(access.cancel("operation:one"), assertSafeError);
    await host.dispose();
  }
  assert.equal(reads, 0);
});

test("acceptance callbacks and Host cancellation cannot substitute another authority", async () => {
  const wrong = { ...authority(), authorityRevision: "runtime-access-authority:two" };
  for (const badAcceptance of [true, false]) {
    const host = createAgentRuntimeHost({ ...setup, containedTurn: {
      ...boundedOwner(async () => envelope(observed(), wrong)),
      submit: { async execute(_command, options) {
        options?.onAccepted?.(envelope({ operationId: "operation:one", scope: scope() }, badAcceptance ? wrong : authority()));
        return envelope(observed(), wrong);
      } },
    } });
    const access = host.bindAccess({ containedTurn: scope() }).containedTurn;
    if (badAcceptance) {
      await assert.rejects(access.submit(input()), assertSafeError);
      await host.dispose();
    } else {
      assert.deepEqual(await access.submit(input()), { status: "accepted", operationId: "operation:one" });
      await assert.rejects(host.dispose(), (error: unknown) => {
        assert.ok(error instanceof AgentRuntimeHostDisposalIncompleteError);
        assert.equal(error.status, "termination_unproven");
        assert.doesNotMatch(JSON.stringify(error), /runtime-access-authority/u);
        assert.equal(error.containedTurns[0]?.status, "contract_violation");
        return true;
      });
    }
  }
});

test("trusted revision and scope getters/proxies cannot publish an enabled handle", async () => {
  let reads = 0;
  const trap = () => { reads += 1; throw new Error("private sentinel"); };
  const feature = boundedOwner(async () => { throw new Error("owner must not run"); });
  assert.throws(() => createAgentRuntimeHost({ ...setup, containedTurn:
    Object.defineProperty({ ...feature }, "authorityRevision", { get: trap }),
  }), TypeError);
  const host = createAgentRuntimeHost({ ...setup, containedTurn: feature });
  for (const containedTurn of [
    new Proxy(scope(), { getOwnPropertyDescriptor: trap }),
    Object.defineProperty(scope(), "projectId", { get: trap }),
    Object.defineProperty(scope(), "tenantId", { get: trap }),
  ]) {
    const access = host.bindAccess({ containedTurn }).containedTurn;
    assert.deepEqual(await access.submit(input()), { code: "capability_unavailable", status: "unsupported" });
    assert.deepEqual(await access.observe("operation:one"), { code: "capability_unavailable", status: "unsupported" });
  }
  const poisoned = Object.defineProperty({}, "containedTurn", { get: trap });
  assert.deepEqual(await host.bindAccess(poisoned).containedTurn.cancel("operation:one"), {
    code: "capability_unavailable", status: "unsupported",
  });
  assert.equal(reads, 0);
  await host.dispose();
});

test("private authority identities cannot escape through owner identities or caller commands", async () => {
  for (const value of [authority().authorityRevision, `operation:${authority().authorityRevision}`]) {
    for (const field of ["operationId", "commandId", "effectId", "artifactManifestRef", "resultRef", "provider"]) {
      const ownerTurn = { ...turn(), [field]: value };
      const host = createAgentRuntimeHost({ ...setup, containedTurn: boundedOwner(async () => envelope({
        status: "observed", turn: ownerTurn,
      })) });
      const access = host.bindAccess({ containedTurn: scope() }).containedTurn;
      try {
        const result = await access.observe("operation:one");
        assert.deepEqual(result, { code: "capability_unavailable", status: "unsupported" });
      } catch (error) { assertSafeError(error); }
      assert.deepEqual(await access.submit({ ...input(), commandId: value }), {
        code: "provider_unsupported", status: "unsupported",
      });
      await assert.rejects(access.observe(value), assertSafeError);
      await host.dispose();
    }
  }
});
