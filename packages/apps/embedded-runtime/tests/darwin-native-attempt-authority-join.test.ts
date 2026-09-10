import assert from "node:assert/strict";
import test from "node:test";
import {bindDarwinNativeAttemptAuthority} from "../dist/composition.js";
import {containedTurnPreparationToken, type ContainedTurnFeatureDependencies, type NativePreparedAttemptBinding,
  type RetainedNativeAttemptAuthority} from "@agent-teams/agent-execution/composition";

type Store = ContainedTurnFeatureDependencies["operationStore"];
const methods = ["accept", "appendOutput", "commit", "preventIntent", "requestCancellation", "terminalProof",
  "prepareCancellation", "claimPreparedDispatch", "identifyAcceptance", "prepareDispatch", "proofsForPrevention",
  "proofsForProcessNoStart", "proofsForAcceptedEffect", "read", "retireDispatchPreparation",
  "recordDispatchPreparationCleanup", "listDispatchPreparations", "proveDispatchPreparationClosure"] as const;
const prepared = Object.freeze({attemptId: "attempt:actual", claimProofId: "proof:claim", custodyId: "custody:actual",
  cutoffProofId: "proof:cutoff", executionGenerationId: "execution-generation:actual", writerFence: "writer-fence:actual"});
const preparationToken = containedTurnPreparationToken({attemptId: prepared.attemptId, custodyId: prepared.custodyId,
  operationId: "operation:actual"} as Parameters<typeof containedTurnPreparationToken>[0]);
const proof = Object.freeze({purpose: "contained_turn_committed_dispatch_v1", version: 1, operationId: "operation:actual",
  attemptId: prepared.attemptId, custodyId: prepared.custodyId, executionGenerationId: prepared.executionGenerationId,
  workspaceId: "workspace:actual", preparationToken, tenantId: "tenant:actual", projectId: "project:actual"});

const fixture = (claimResult: object = Object.freeze({kind: "claimed", operation: Object.freeze({}), committedDispatchProof: proof})) => {
  const calls: string[] = [];
  const owner: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of methods) {
    owner[name] = async function (): Promise<unknown> {
      assert.equal(this, owner); calls.push(`store:${name}`);
      if (name === "prepareDispatch") {return prepared;}
      if (name === "claimPreparedDispatch") {return claimResult;}
      return undefined;
    };
  }
  let binding: NativePreparedAttemptBinding | undefined;
  let bindConsumed = false, claimConsumed = false;
  const authority: RetainedNativeAttemptAuthority = {
    async bindPreparedAttempt(input) {
      assert.equal(this, authority); calls.push("native:bind"); binding = input;
      if (bindConsumed) {throw new Error("synthetic binding already consumed");} bindConsumed = true;
      if (input.workspaceId === undefined) {throw new Error("actual prepared native attempt requires workspace identity");}
    },
    async confirmCommittedClaim(input) {
      assert.equal(this, authority); calls.push("native:confirm");
      assert.equal(input, proof);
      assert.deepEqual(input, {purpose: "contained_turn_committed_dispatch_v1", version: 1, operationId: "operation:actual",
        attemptId: prepared.attemptId, custodyId: prepared.custodyId,
        executionGenerationId: prepared.executionGenerationId, workspaceId: "workspace:actual",
        preparationToken, tenantId: "tenant:actual", projectId: "project:actual"});
      if (claimConsumed) {throw new Error("synthetic claim already consumed");} claimConsumed = true;
    },
  };
  return {authority, binding: () => binding, calls, store: owner as unknown as Store};
};
const prepareInput = Object.freeze({authority: Object.freeze({scope: Object.freeze({tenantId: "tenant:actual", projectId: "project:actual"})}),
  operation: Object.freeze({operationId: "operation:actual", workspaceId: "workspace:actual"})});

test("binds the exact actual durable preparation before returning it and preserves every receiver", async () => {
  const h = fixture(); const joined = bindDarwinNativeAttemptAuthority(h.store, h.authority);
  const result = await joined.prepareDispatch(prepareInput as Parameters<Store["prepareDispatch"]>[0]);
  assert.equal(result, prepared); assert.deepEqual(h.calls, ["store:prepareDispatch", "native:bind"]);
  assert.deepEqual(h.binding(), {operationId: "operation:actual", attemptId: "attempt:actual", custodyId: "custody:actual",
    executionGenerationId: "execution-generation:actual", workspaceId: "workspace:actual",
    preparationToken,
    writerFence: "writer-fence:actual", scope: {tenantId: "tenant:actual", projectId: "project:actual"}});
  await joined.read({} as Parameters<Store["read"]>[0]);
  assert.equal(h.calls.at(-1), "store:read");
});

test("confirms only the exact fresh claim result, after the actual claim", async () => {
  const h = fixture(); const joined = bindDarwinNativeAttemptAuthority(h.store, h.authority);
  await joined.prepareDispatch(prepareInput as Parameters<Store["prepareDispatch"]>[0]);
  const result = await joined.claimPreparedDispatch({} as Parameters<Store["claimPreparedDispatch"]>[0]);
  assert.equal(result.kind, "claimed");
  assert.deepEqual(h.calls, ["store:prepareDispatch", "native:bind", "store:claimPreparedDispatch", "native:confirm"]);
});

test("never confirms non-fresh outcomes", async () => {
  for (const kind of ["observed_claim", "stale", "indeterminate", "not_found"] as const) {
    const outcome = Object.freeze({kind}); const h = fixture(outcome);
    assert.equal(await bindDarwinNativeAttemptAuthority(h.store, h.authority).claimPreparedDispatch({} as Parameters<Store["claimPreparedDispatch"]>[0]), outcome);
    assert.deepEqual(h.calls, ["store:claimPreparedDispatch"]);
  }
});

test("post-commit native failures reject and authority calls remain one-shot", async () => {
  const oneShot = fixture(); const joinedOnce = bindDarwinNativeAttemptAuthority(oneShot.store, oneShot.authority);
  await joinedOnce.prepareDispatch(prepareInput as Parameters<Store["prepareDispatch"]>[0]);
  await assert.rejects(joinedOnce.prepareDispatch(prepareInput as Parameters<Store["prepareDispatch"]>[0]), /already consumed/u);
  await joinedOnce.claimPreparedDispatch({} as Parameters<Store["claimPreparedDispatch"]>[0]);
  await assert.rejects(joinedOnce.claimPreparedDispatch({} as Parameters<Store["claimPreparedDispatch"]>[0]), /already consumed/u);
  const h = fixture(); let binds = 0, confirms = 0;
  h.authority.bindPreparedAttempt = async () => {binds++; throw new Error("synthetic bind uncertainty");};
  h.authority.confirmCommittedClaim = async () => {confirms++; throw new Error("synthetic claim uncertainty");};
  const joined = bindDarwinNativeAttemptAuthority(h.store, h.authority);
  await assert.rejects(joined.prepareDispatch(prepareInput as Parameters<Store["prepareDispatch"]>[0]), /bind uncertainty/u);
  await assert.rejects(joined.claimPreparedDispatch({} as Parameters<Store["claimPreparedDispatch"]>[0]), /claim uncertainty/u);
  assert.equal(binds, 1); assert.equal(confirms, 1);
});

test("missing workspace rejects only after durable preparation", async () => {
  for (const operation of [{operationId: "operation:actual"}, {operationId: "operation:actual", workspaceId: ""}]) {
    const h = fixture(); const input = {...prepareInput, operation};
    await assert.rejects(bindDarwinNativeAttemptAuthority(h.store, h.authority).prepareDispatch(input as Parameters<Store["prepareDispatch"]>[0]), /requires workspace/u);
    assert.deepEqual(h.calls, ["store:prepareDispatch"]);
  }
});

test("accepts absent optional store operations and preserves prototype receivers when present", async () => {
  const absent = fixture();
  delete (absent.store as Store).listDispatchPreparations;
  delete (absent.store as Store).proveDispatchPreparationClosure;
  const withoutOptional = bindDarwinNativeAttemptAuthority(absent.store, absent.authority);
  assert.equal(withoutOptional.listDispatchPreparations, undefined);
  assert.equal(withoutOptional.proveDispatchPreparationClosure, undefined);

  const inherited = fixture();
  const owner = inherited.store as Store;
  const list = owner.listDispatchPreparations!;
  delete owner.listDispatchPreparations;
  Object.setPrototypeOf(owner, Object.freeze({listDispatchPreparations: list}));
  await bindDarwinNativeAttemptAuthority(owner, inherited.authority).listDispatchPreparations!({} as never);
  assert.equal(inherited.calls.at(-1), "store:listDispatchPreparations");
});

test("rejects unsafe optional store operations", () => {
  for (const unsafe of [42, new Proxy(async () => undefined, {})]) {
    const h = fixture(); h.store.listDispatchPreparations = unsafe as never;
    assert.throws(() => bindDarwinNativeAttemptAuthority(h.store, h.authority), /authority unavailable/u);
  }
  const h = fixture(); delete h.store.listDispatchPreparations;
  Object.defineProperty(h.store, "listDispatchPreparations", {get() {throw new Error("must not execute accessor");}});
  assert.throws(() => bindDarwinNativeAttemptAuthority(h.store, h.authority), /authority unavailable/u);
});

test("store rejection never invokes native callbacks", async () => {
  const h = fixture();
  h.store.prepareDispatch = async () => {throw new Error("synthetic durable prepare rejection");};
  h.store.claimPreparedDispatch = async () => {throw new Error("synthetic durable claim rejection");};
  const joined = bindDarwinNativeAttemptAuthority(h.store, h.authority);
  await assert.rejects(joined.prepareDispatch(prepareInput as Parameters<Store["prepareDispatch"]>[0]), /prepare rejection/u);
  await assert.rejects(joined.claimPreparedDispatch({} as Parameters<Store["claimPreparedDispatch"]>[0]), /claim rejection/u);
  assert.deepEqual(h.calls, []);
});
