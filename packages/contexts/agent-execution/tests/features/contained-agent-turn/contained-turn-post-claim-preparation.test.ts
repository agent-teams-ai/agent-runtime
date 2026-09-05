import assert from "node:assert/strict";
import test from "node:test";
import { ContainedTurnKernelCustodyAdapter } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js";
import type { ContainedTurnHostPostClaimPreparation, ContainedTurnKernelCustodyAdapterOptions } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-contracts.js";
import type { ContainedTurnKernelCustodyPort } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { containedTurnOperationCutoffRevision } from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import { adapterSnapshot, attemptId, authorityDigest, commandId, custodyId, effectId, hostBootId, hostInstanceId,
  operationId, preparationToken, providerAccessSnapshot, workspaceId } from "../../contained-turn-kernel-fixtures.ts";
import { committedDispatchProofFixture } from "./support/committed-dispatch-proof-fixture.ts";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";

type Preparation = ContainedTurnKernelCustodyAdapterOptions["postClaimPreparation"];
type PrepareInput = Parameters<ContainedTurnHostPostClaimPreparation["prepareClaimed"]>[0];
const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
const deferred = <Value>() => {
  let complete!: (value: Value) => void;
  const promise = new Promise<Value>(resolve => {complete = resolve;});
  return {promise, resolve: complete};
};
const openInput: Parameters<ContainedTurnKernelCustodyPort["open"]>[0] = Object.freeze({
  adapterSnapshot, attemptId, authorityVectorDigest: authorityDigest, commandId, custodyId, effectId,
  intentMode: "analysis", operationId, operationCutoffRevision: containedTurnOperationCutoffRevision(0),
  operationRevision: 1, preparationToken, providerAccessSnapshot, workspaceId,
});
const create = (postClaimPreparation: Preparation, events: string[] = [], completionAfterMs = 100) => {
  const host = {
    reserve: async () => {events.push("reserve"); return {custodyRef: "host:retained"};},
    open: async () => {throw new Error("not the reservation seam");},
    evidence: (): undefined => {},
    requestContainment: async () => {events.push("contain"); return {kind: "contained" as const, receiptRef: "receipt:synthetic"};},
    release: async () => {events.push("release"); return {kind: "released" as const};},
  };
  const options: ContainedTurnKernelCustodyAdapterOptions = {
    postClaimPreparation, hostBootId, hostInstanceId, completionAfterMs, startObservationAfterMs: 5,
    workspaceOwner: {async withLaunchAuthority(_input, consume) {
      events.push("workspace");
      return consume({canonicalPath: "/synthetic/disposable", descriptorPath: "/synthetic/descriptor",
        identity: {dev: 1n, ino: 2n, mountId: "mount:synthetic"}});
    }},
    attemptOwner: {
      async prepare() {
        events.push("plan");
        return {arguments: [], binaryRevision: adapterSnapshot.binaryRevision, containmentProfile: "strict-linux-cgroup-v2",
          environment: {}, executablePath: "/synthetic/provider", executableSha256: "a".repeat(64), intentMode: "analysis",
          privateRootPath: "/synthetic/private", provider: "codex", spawnMode: "sdk-delegated"};
      },
      retain() {events.push("retain");}, retire() {events.push("retire");},
    },
  };
  return {custody: new ContainedTurnKernelCustodyAdapter(host, options), events, host, options};
};
const startInput = (proof: ReturnType<typeof committedDispatchProofFixture>, events: string[]) => ({
  attemptId, custodyId, intentMode: "analysis" as const, operationId, workspaceId, committedDispatchProof: proof,
  async execute(start: Parameters<Parameters<ContainedTurnKernelCustodyPort["start"]>[0]["execute"]>[0]) {
    events.push("execute"); start.createProcess(() => {events.push("creator");});
    assert.throws(() => start.createProcess(() => {events.push("duplicate-creator");}), /one-use/u);
    return {kind: "completed" as const, outcome: "succeeded" as const};
  },
});

test("construct and reserve are inert with respect to post-claim preparation; exact admitted proof alone reaches Host", async () => {
  const events: string[] = []; const gate = deferred<{kind: "prepared"}>(); let received: PrepareInput | undefined;
  const {custody} = create({async prepareClaimed(input) {events.push("prepare-claimed"); received = input; return gate.promise;}}, events);
  await tick(); assert.deepEqual(events.slice(), []);
  const opened = await custody.open(openInput);
  assert.deepEqual(events.slice(), ["workspace", "plan", "reserve", "retain"]);
  const proof = committedDispatchProofFixture(openInput, opened);
  const input = startInput(proof, events); const starting = custody.start(input);
  await tick(); assert.equal(events.at(-1), "prepare-claimed");
  assert.strictEqual(received?.committedDispatchProof, proof);
  assert.equal(received?.underlyingCustodyRef, "host:retained");
  assert.equal(received?.signal.aborted, false);
  await assert.rejects(custody.start(input), /already consumed/u);
  gate.resolve({kind: "prepared"});
  assert.equal((await starting).kind, "indeterminate", "no process evidence was fabricated by preparation");
  assert.deepEqual(events.filter(value => ["prepare-claimed", "execute", "creator", "duplicate-creator"].includes(value)),
    ["prepare-claimed", "execute", "creator"]);
  await assert.rejects(custody.start(input), /already consumed/u);
});

test("missing prerequisites and preparation faults retain one-use start and contain without calling provider", async t => {
  for (const reason of ["network", "broker", "journal", "owner", "quarantined", "throw"] as const) {
    await t.test(reason, async () => {
      let received: PrepareInput | undefined; const events: string[] = [];
      const {custody} = create({async prepareClaimed(input) {
        received = input; events.push("prepare-claimed");
        if (reason === "throw") {throw new Error("synthetic owner fault");}
        return reason === "quarantined" ? {kind: "quarantined"} : {kind: "unsupported", reason};
      }}, events);
      const opened = await custody.open(openInput); const input = startInput(committedDispatchProofFixture(openInput, opened), events);
      assert.equal((await custody.start(input)).kind, "indeterminate");
      assert.equal(received?.signal.aborted, true); assert.equal(events.includes("execute"), false);
      assert.equal(events.filter(value => value === "contain").length, 1);
      await assert.rejects(custody.start(input), /already consumed/u);
    });
  }
});

test("missing owner capability rejects construction, while current-owner semantics are explicitly selected", async () => {
  const {host, options, events, custody} = create("current-owner");
  assert.throws(() => new ContainedTurnKernelCustodyAdapter(host, {...options, postClaimPreparation: undefined as never}), /unavailable/u);
  const opened = await custody.open(openInput);
  await custody.start(startInput(committedDispatchProofFixture(openInput, opened), events));
  assert.equal(events.includes("execute"), true); assert.equal(events.includes("prepare-claimed"), false);
});

test("expired or contained preparation cannot execute on late ready, and Host sees irreversible cutoff", async t => {
  for (const boundary of ["deadline", "containment", "release"] as const) {
    await t.test(boundary, async () => {
      const gate = deferred<{kind: "prepared"}>(); const entered = deferred<PrepareInput>(); const events: string[] = [];
      const {custody} = create({async prepareClaimed(input) {entered.resolve(input); return gate.promise;}}, events, 5);
      const opened = await custody.open(openInput); const input = startInput(committedDispatchProofFixture(openInput, opened), events);
      const deadline = custody.completionBoundary({attemptId, custodyId, operationId, phase: "start"});
      const starting = custody.start(input); const received = await entered.promise;
      if (boundary === "deadline") {await deadline.expiration;}
      if (boundary === "containment") {await custody.requestContainment({attemptId, custodyId, operationId});}
      if (boundary === "release") {await custody.releaseReservation({attemptId, custodyId, operationId, workspaceId, reason: "claim_lost"});}
      await tick(); assert.equal(received.signal.aborted, true);
      gate.resolve({kind: "prepared"}); assert.equal((await starting).kind, "indeterminate");
      deadline.release(); assert.equal(events.includes("execute"), false);
      await assert.rejects(custody.start(input), /already consumed/u);
    });
  }
});

test("preparation owner is captured once and proof mismatch never reaches it", async () => {
  const events: string[] = [];
  const owner = {async prepareClaimed() {events.push("captured"); return {kind: "unsupported" as const, reason: "owner" as const};}};
  const {custody} = create(owner, events);
  owner.prepareClaimed = async () => {throw new Error("mutated owner must not be used");};
  const opened = await custody.open(openInput);
  const wrong = committedDispatchProofFixture(openInput, opened, {committedOperationRevision: 2});
  await assert.rejects(custody.start(startInput(wrong, events)), /conflicts/u);
  assert.equal(events.includes("captured"), false);
  await custody.start(startInput(committedDispatchProofFixture(openInput, opened), events));
  assert.equal(events.filter(value => value === "captured").length, 1);
});

test("real claim path orders acknowledgement before Host preparation; prevented, replayed and lost-ack paths do not prepare", async t => {
  for (const mode of ["acknowledged", "prevented", "lost-ack", "indeterminate"] as const) {
    await t.test(mode, async () => {
      const fixture = createDependencies({dispatchPrevented: mode === "prevented", claimCommitThenThrow: mode === "lost-ack",
        claimIndeterminate: mode === "indeterminate"});
      const events: string[] = [];
      const {custody} = create({async prepareClaimed(input) {
        events.push("prepare-claimed");
        assert.equal(fixture.current()?.dispatch.kind, "claimed");
        assert.equal(input.committedDispatchProof.operationId, fixture.current()?.operationId);
        assert.equal(events.includes("claim-acknowledged"), true);
        return {kind: "unsupported", reason: "network"};
      }}, events);
      const store = fixture.dependencies.operationStore;
      const feature = createContainedTurnFeature({...fixture.dependencies, custody,
        operationStore: {...store, async accept(candidate, authority) {
          const current = fixture.current();
          return current === undefined ? store.accept(candidate, authority) : {kind: "replayed", operation: current};
        }, async claimPreparedDispatch(input) {
          events.push("claim-requested");
          const result = await store.claimPreparedDispatch(input);
          events.push("claim-acknowledged"); return result;
        }},
      });
      const input = {commandId: "command:one", expectedProvider: "codex" as const,
        intent: {mode: "analysis" as const, prompt: "synthetic claim boundary"}, scope: {projectId: "project:one", tenantId: "tenant:one"}};
      await feature.submit.execute(input);
      const count = events.filter(event => event === "prepare-claimed").length;
      assert.equal(count, mode === "acknowledged" ? 1 : 0);
      assert.equal(fixture.providerCalls.value, 0);
      if (mode === "acknowledged" || mode === "lost-ack") {
        assert.equal(fixture.current()?.dispatch.kind, "claimed");
        assert.equal(fixture.current()?.terminal.kind, "open");
      }
      await feature.submit.execute(input);
      assert.equal(events.filter(event => event === "prepare-claimed").length, count, "replay must not prepare or execute");
      assert.equal(fixture.providerCalls.value, 0);
    });
  }
});

test("admitted claim bridges synthetic Docker launch/init-ready/owner preparation before journaled exec", async t => {
  const {rm} = await import("node:fs/promises");
  const {FakeDockerEngine} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js");
  const {createDockerHostCustodyLifecycle} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js");
  const {MemoryStorage, disposable, policy, createInput, engineCall, owner} = await import("./support/docker-host-custody-lifecycle-fixture.ts");
  const {installSyntheticInit, initOptions, providerExec} = await import("./support/docker-claim-init-fixture.ts");
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const events: string[] = []; const engine = new FakeDockerEngine(policy(root)); const storage = new MemoryStorage();
  const init = installSyntheticInit(engine, events);
  const lifecycle = createDockerHostCustodyLifecycle({engine, journalStorage: storage, residue: {async proveEmpty() {return "empty";}}});
  let launched: Awaited<ReturnType<typeof lifecycle.launch>> | undefined;
  const prepared = deferred<{kind: "prepared"}>(); const initReady = deferred<void>();
  const {custody} = create({async prepareClaimed(input) {
    events.push("claim-admitted");
    launched = await lifecycle.launch({call: {...engineCall(), signal: input.signal}, create: createInput(root), owner});
    const session = launched.openInitSession({...initOptions(), signal: input.signal});
    assert.equal((await session.ready()).kind, "ready"); events.push("authenticated-init-ready"); initReady.resolve();
    // This synthetic owner has no network effects. No production route readiness is claimed.
    await prepared.promise; events.push("owner-prepared"); return {kind: "prepared"};
  }}, events);
  assert.deepEqual(engine.events, []); const opened = await custody.open(openInput); assert.deepEqual(engine.events, []);
  const input = startInput(committedDispatchProofFixture(openInput, opened), events);
  const pending = custody.start({...input, async execute(start) {
    assert.ok(launched); events.push("kernel-execute");
    const result = await start.createProcess(() => lifecycle.executeProvider({authority: launched!.authority,
      call: engineCall(), key: launched!.key, exec: providerExec}));
    assert.equal(result.evidence.status, "proved"); return {kind: "completed", outcome: "succeeded"};
  }});
  await initReady.promise; assert.equal(events.includes("provider-exec"), false); assert.equal(init.attaches, 1);
  prepared.resolve({kind: "prepared"}); assert.equal((await pending).kind, "indeterminate");
  assert.deepEqual(events.filter(event => ["claim-admitted", "attach", "host-handshake", "authenticated-init-ready", "owner-prepared", "kernel-execute", "provider-exec"].includes(event)),
    ["claim-admitted", "attach", "host-handshake", "authenticated-init-ready", "owner-prepared", "kernel-execute", "provider-exec"]);
  assert.ok(launched); await lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});
});
