import assert from "node:assert/strict";
import test from "node:test";
import {createDockerCodexHostKernelOwner, type CreateDockerCodexHostKernelOwnerOptions}
  from "../../../dist/features/contained-agent-turn/composition/docker-codex-host-kernel-owner.js";
import {connectionFixture} from "./support/docker-codex-kernel-fixture.ts";
import {committedDispatchProofFixture} from "./support/committed-dispatch-proof-fixture.ts";
import {containedTurnIdentity as id} from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {containedTurnOperationCutoffRevision} from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";

const unused = () => {throw new Error("unexpected construction effect");};
const inertOptions = (): CreateDockerCodexHostKernelOwnerOptions => ({
  cleanupMilliseconds: 100, hostBootId: "host-boot:docker", hostInstanceId: "host-instance:docker",
  platformTarget: {platform: "linux", architecture: "x64"}, workspaceOwner: {withLaunchAuthority: unused},
  launchRecords: {resolve: unused}, effectCustody: {admit: unused}, preparation: unused,
});

for (const property of ["bind", "name", "length"] as const) {
  test(`real Docker owner construction does not read frozen finalizer ${property}`, t => {
    let reads = 0; let calls = 0;
    const finishClaimed = () => {calls += 1; throw new Error("unexpected finalization");};
    Object.defineProperty(finishClaimed, property, {get() {
      reads += 1; throw new Error(`unexpected ${property} read`);
    }});
    Object.freeze(finishClaimed);
    const owner = createDockerCodexHostKernelOwner({...inertOptions(), finishClaimed});
    t.after(() => owner.dispose());
    assert.equal(Object.isFrozen(finishClaimed), true);
    assert.equal(reads, 0); assert.equal(calls, 0);
    assert.deepEqual(Object.keys(owner).toSorted(), ["custody", "dispose", "provider"]);
  });
}

test("real Docker owner rejects malformed finalizers without getters, proxy traps or calls", () => {
  let effects = 0;
  const effect = () => {effects += 1; throw new Error("unexpected finalizer effect");};
  const revoked = Proxy.revocable(unused, {}); revoked.revoke();
  const malformed: unknown[] = [null, false, 0, "callback", {}, {bind: effect},
    Object.freeze({get bind() {return effect();}}),
    new Proxy(unused, {get: effect, getOwnPropertyDescriptor: effect, getPrototypeOf: effect, apply: effect}),
    revoked.proxy];
  for (const finishClaimed of malformed) {
    assert.throws(() => createDockerCodexHostKernelOwner({...inertOptions(), finishClaimed} as never), TypeError);
    assert.equal(effects, 0);
  }
  assert.throws(() => createDockerCodexHostKernelOwner({...inertOptions(), get finishClaimed() {return effect();}}), TypeError);
  assert.equal(effects, 0);
});

test("private Docker owner construction is synchronous and inert; provider use cannot bypass claimed preparation", async () => {
  const options = {cleanupMilliseconds: 100, hostBootId: "host-boot:docker", hostInstanceId: "host-instance:docker",
    platformTarget: {platform: "linux", architecture: "x64"}, workspaceOwner: {withLaunchAuthority: unused},
    launchRecords: {resolve: unused}, effectCustody: {admit: unused}, preparation: unused} as CreateDockerCodexHostKernelOwnerOptions;
  const owner = createDockerCodexHostKernelOwner(options);
  assert.deepEqual(Object.keys(owner).toSorted(), ["custody", "dispose", "provider"]);
  assert.equal(owner.provider.adapterSnapshot.provider, "codex");
  await assert.rejects(owner.provider.execute({custodyId: "missing"} as never), /prepared attempt/);
  let reads = 0;
  assert.throws(() => createDockerCodexHostKernelOwner({...options, get preparation() {reads += 1; return unused;}}));
  assert.equal(reads, 0);
  owner.dispose(); owner.dispose();
});

for (const missing of ["finalizer", "image"] as const) {
test(`actual kernel custody refuses missing ${missing} before Docker allocation and fences a second start`, async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  let allocations = 0; let executions = 0;
  const owner = createDockerCodexHostKernelOwner({cleanupMilliseconds: 100,
    hostBootId: "host-boot:docker", hostInstanceId: "host-instance:docker", platformTarget: f.options.platformTarget,
    effectCustody: f.options.effectCustody,
    launchRecords: {async resolve() {return {boundary: f.options.boundary, executablePath: f.options.plan.executablePath,
      privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir,
      credentialOutputInventory: f.options.credentialOutputInventory};}},
    workspaceOwner: {async withLaunchAuthority(_input, consume) {
      return consume({canonicalPath: f.options.plan.workspaceRef, descriptorPath: f.options.plan.workspaceRef,
        identity: {dev: 1n, ino: 2n, mountId: "synthetic"}});
    }}, preparation() {allocations += 1; throw new Error("must refuse before resource selection");}});
  t.after(() => owner.dispose());
  const open = {...f.options.attempt, intentMode: f.options.attempt.intent.mode,
    commandId: id("command", "command:docker"), preparationToken: id("preparation", "preparation:docker"),
    operationCutoffRevision: containedTurnOperationCutoffRevision(0), operationRevision: 1};
  const opened = await owner.custody.open(open);
  const start = {attemptId: open.attemptId, custodyId: open.custodyId, operationId: open.operationId,
    workspaceId: open.workspaceId, intentMode: open.intentMode, committedDispatchProof: committedDispatchProofFixture(open, opened),
    async execute() {executions += 1; return {kind: "completed" as const, outcome: "succeeded" as const};}};
  assert.equal((await owner.custody.start(start)).kind, "indeterminate");
  assert.equal(allocations, 0); assert.equal(executions, 0);
  await assert.rejects(owner.custody.start(start));
  assert.equal(allocations, 0);
});
}
