import assert from "node:assert/strict";
import test from "node:test";
import {
  ContainedTurnKernelCustodyAdapter,
  type ContainedTurnHostCustodyPort,
  type ContainedTurnKernelCustodyAdapterOptions,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js";
import type { ContainedTurnKernelCustodyPort } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnCleanupPermit } from "../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnOperationCutoffRevision } from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {
  adapterSnapshot, attemptId, authorityDigest, commandId, custodyId, effectId,
  operationId, preparationToken, providerAccessSnapshot, workspaceId,
} from "../../contained-turn-kernel-fixtures.ts";

const input: Parameters<ContainedTurnKernelCustodyPort["open"]>[0] = Object.freeze({
  adapterSnapshot, attemptId, authorityVectorDigest: authorityDigest, commandId, custodyId, effectId,
  intentMode: "analysis", operationId, operationCutoffRevision: containedTurnOperationCutoffRevision(0),
  operationRevision: 1, preparationToken, providerAccessSnapshot, workspaceId,
});
const release = Object.freeze({ attemptId, custodyId, operationId, workspaceId, reason: "open_failed" as const });
const permit = containedTurnCleanupPermit({
  ...input, kind: "active", preparedOperationRevision: input.operationRevision,
  providerAccessGrantRequestId: null, runtimeSecurityGrantRequestId: null,
}, "cleanup-nonce:open-failure");
const plan = Object.freeze({
  arguments: Object.freeze([]), binaryRevision: adapterSnapshot.binaryRevision,
  containmentProfile: "strict-linux-cgroup-v2" as const, environment: Object.freeze({}),
  executablePath: "/synthetic/provider", executableSha256: "3".repeat(64),
  intentMode: "analysis" as const, privateRootPath: "/synthetic/private",
  provider: "codex" as const, spawnMode: "sdk-delegated" as const,
});
const target = Object.freeze({ canonicalPath: "/synthetic/workspace", descriptorPath: "/proc/self/fd/99",
  identity: Object.freeze({ dev: 1n, ino: 2n, mountId: "synthetic" }) });
const failure = new Error("synthetic open failure");
const harness = (phase: "prepare" | "reserve" | "malformed" | "retain" | "success",
  prepare = async () => plan,
  workspaceOwner?: ContainedTurnKernelCustodyAdapterOptions["workspaceOwner"],
  retire = () => {}) => {
  const counts = { prepares: 0, reserves: 0, retires: 0, releases: 0 };
  const raw: ContainedTurnHostCustodyPort = {
    evidence: () => {},
    open: async () => {throw new Error("unexpected generic open");},
    reserve: async () => {
      counts.reserves += 1;
      if (phase === "reserve") {throw failure;}
      return { custodyRef: phase === "malformed" ? "" : "synthetic:reserved" };
    },
    requestContainment: async () => ({ kind: "contained", receiptRef: "synthetic:contained" }),
    release: async () => {counts.releases += 1; return { kind: "released" };},
  };
  const create = () => new ContainedTurnKernelCustodyAdapter(raw, {
    postClaimPreparation: "current-owner", hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
    attemptOwner: {
      prepare: async () => {counts.prepares += 1; if (phase === "prepare") {throw failure;} return prepare();},
      retain: () => {if (phase === "retain") {throw failure;}},
      retire: () => {counts.retires += 1; retire();},
    },
    workspaceOwner: workspaceOwner ?? { withLaunchAuthority: async (_input, consume) => consume(target) },
  });
  return { custody: create(), create, counts };
};

test("exact pre-acquisition failure releases locally and under its retired permit without raw cleanup", async () => {
  const h = harness("prepare");
  await assert.rejects(h.custody.open(input), error => error === failure);
  await h.custody.releaseReservation(release);
  await h.custody.releaseReservation(release);
  assert.equal((await h.custody.releaseRetiredReservation({ cleanupPermit: permit })).kind, "already_released");
  await assert.rejects(h.custody.open(input), /already consumed/u);
  for (const field of ["attemptId", "custodyId", "operationId", "workspaceId"] as const) {
    await assert.rejects(h.custody.releaseReservation({ ...release, [field]: `${release[field]}:other` }), /unavailable/u);
    assert.equal((await h.custody.releaseRetiredReservation({
      cleanupPermit: { ...permit, [field]: `${permit[field]}:other` },
    })).kind, "indeterminate");
  }
  for (const changed of [
    { preparationToken: `${preparationToken}:other` as typeof preparationToken },
    { preparedOperationRevision: 2 }, { operationCutoffRevision: containedTurnOperationCutoffRevision(1) },
  ]) {
    assert.equal((await h.custody.releaseRetiredReservation({ cleanupPermit: { ...permit, ...changed } })).kind, "indeterminate");
  }
  assert.deepEqual(h.counts, { prepares: 1, reserves: 0, retires: 1, releases: 0 });
  const restarted = h.create();
  await assert.rejects(restarted.releaseReservation(release), /unavailable/u);
  assert.equal((await restarted.releaseRetiredReservation({ cleanupPermit: permit })).kind, "indeterminate");
});

for (const phase of ["reserve", "malformed", "retain"] as const) {
  test(`${phase} failure can have acquired resources and never attests absence`, async () => {
    const h = harness(phase);
    await assert.rejects(h.custody.open(input));
    await assert.rejects(h.custody.releaseReservation(release), /unavailable/u);
    assert.equal((await h.custody.releaseRetiredReservation({ cleanupPermit: permit })).kind, "indeterminate");
    await assert.rejects(h.custody.open(input), /already consumed/u);
    assert.equal(h.counts.reserves, 1);
    assert.equal(h.counts.releases, 0);
  });
}

test("pending and mismatched opens cannot authorize cleanup or duplicate raw acquisition", async () => {
  let finish!: (value: typeof plan) => void;
  const h = harness("success", () => new Promise(resolve => {finish = resolve;}));
  const opening = h.custody.open(input);
  await assert.rejects(h.custody.releaseReservation(release), /unavailable/u);
  assert.equal((await h.custody.releaseRetiredReservation({ cleanupPermit: permit })).kind, "indeterminate");
  for (const changed of [{}, { intentMode: "workspace-write" as const },
    { custodyId: `${custodyId}:other` as typeof custodyId }]) {
    await assert.rejects(h.custody.open({ ...input, ...changed }), /already consumed/u);
  }
  finish(plan);
  const opened = await opening;
  assert.deepEqual(await h.custody.open(input), opened);
  await assert.rejects(h.custody.open({ ...input, operationRevision: 2 }), /identity conflict/u);
  await h.custody.releaseReservation(release);
  assert.deepEqual(h.counts, { prepares: 1, reserves: 1, retires: 1, releases: 1 });
});

test("workspace rejection fences a still-pending preparation before retirement and raw reserve", async () => {
  let finish!: (value: typeof plan) => void;
  let late!: () => Promise<unknown>;
  const h = harness("success", () => new Promise(resolve => {finish = resolve;}), {
    withLaunchAuthority: async (_input, consume) => {
      late = () => consume(target);
      void consume(target).catch(() => {});
      throw failure;
    },
  });
  const opening = h.custody.open(input);
  await assert.rejects(h.custody.releaseReservation(release), /unavailable/u);
  assert.equal(h.counts.retires, 0);
  finish(plan);
  await assert.rejects(opening, error => error === failure);
  await h.custody.releaseReservation(release);
  assert.throws(late, /already consumed/u);
  assert.deepEqual(h.counts, { prepares: 1, reserves: 0, retires: 1, releases: 0 });
});

test("retirement failure cannot attest successful pre-acquisition cleanup", async () => {
  const h = harness("prepare", undefined, undefined, () => {throw new Error("retirement unavailable");});
  await assert.rejects(h.custody.open(input), /retirement unavailable/u);
  await assert.rejects(h.custody.releaseReservation(release), /unavailable/u);
  assert.equal((await h.custody.releaseRetiredReservation({ cleanupPermit: permit })).kind, "indeterminate");
});

test("a workspace failure before consuming launch authority cannot acquire later", async () => {
  let late!: () => Promise<unknown>;
  const h = harness("success", undefined, {
    withLaunchAuthority: async (_input, consume) => {late = () => consume(target); throw failure;},
  });
  await assert.rejects(h.custody.open(input), error => error === failure);
  await h.custody.releaseReservation(release);
  assert.throws(late, /already consumed/u);
  assert.deepEqual(h.counts, { prepares: 0, reserves: 0, retires: 1, releases: 0 });
});


test("owner lifetime admission bound retains fences and refuses before workspace acquisition", async () => {
  let callbacks = 0;
  const h = harness("prepare", undefined, {
    withLaunchAuthority: async (_input, consume) => {callbacks += 1; return consume(target);},
  });
  for (let index = 0; index < 1024; index += 1) {
    await assert.rejects(h.custody.open({ ...input,
      custodyId: index === 0 ? custodyId : `${custodyId}:${index}` as typeof custodyId,
      attemptId: index === 0 ? attemptId : `${attemptId}:${index}` as typeof attemptId,
    }), error => error === failure);
  }
  const refused = { ...input, custodyId: `${custodyId}:refused` as typeof custodyId,
    attemptId: `${attemptId}:refused` as typeof attemptId };
  await assert.rejects(h.custody.open(refused), /owner lifetime open attempt limit reached/u);
  await h.custody.releaseReservation(release);
  assert.equal((await h.custody.releaseRetiredReservation({ cleanupPermit: permit })).kind, "already_released");
  await assert.rejects(h.custody.open(input), /already consumed/u);
  await assert.rejects(h.custody.open({ ...input, custodyId: refused.custodyId }), /already consumed/u);
  await assert.rejects(h.custody.open(refused), /owner lifetime open attempt limit reached/u);
  await assert.rejects(h.custody.releaseReservation({ ...release, ...refused }), /unavailable/u);
  assert.equal((await h.custody.releaseRetiredReservation({
    cleanupPermit: { ...permit, custodyId: refused.custodyId, attemptId: refused.attemptId },
  })).kind, "indeterminate");
  assert.equal(callbacks, 1024);
  assert.deepEqual(h.counts, { prepares: 1024, reserves: 0, retires: 1024, releases: 0 });
  const fresh = h.create();
  await assert.rejects(fresh.releaseReservation(release), /unavailable/u);
  assert.equal((await fresh.releaseRetiredReservation({ cleanupPermit: permit })).kind, "indeterminate");
});
