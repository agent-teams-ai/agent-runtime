import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {dirname, join} from "node:path";
import test from "node:test";
import {DockerKernelHostCustody} from "../../../dist/features/contained-agent-turn/composition/docker-kernel-host-custody.js";
import {createHostPrivateRootOwnerFactory} from "../../../dist/features/contained-agent-turn/composition/host-private-root-owner.js";
import {createDockerHostReservationOwners} from "../../../dist/features/contained-agent-turn/composition/docker-host-reservation-owners.js";
import {createDockerLinuxPostClaimOwner} from "../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js";
import {prepareDockerProviderProcessIo} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {residueFixture} from "./support/linux-docker-residue-fixture.ts";
import {createInput, engineCall, owner as hostIdentity} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {initOptions, installSyntheticInit} from "./support/docker-claim-init-fixture.ts";
import {postClaimFixture} from "./support/docker-linux-post-claim-fixture.ts";
import {imageLock} from "../../fixtures/docker-image-init-fixture.ts";
import type {HostCustodyReservationInput} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

const input = (operationId: string, attemptId: string, workspaceRef: string, privateRootPath: string): HostCustodyReservationInput => ({
  operationId, attemptId, intentMode: "analysis", workspaceRef,
  workspaceAuthority: {canonicalPath: workspaceRef, descriptorPath: workspaceRef, identity: {dev: 1n, ino: 2n, mountId: "synthetic"}},
  providerBinding: {provider: "codex", binaryRevision: "synthetic", adapterRevision: "synthetic",
    capabilityManifestRevision: "synthetic", credentialBindingDigest: "synthetic", providerRouteRef: "synthetic"},
  launchPlan: {arguments: [], binaryRevision: "synthetic", containmentProfile: "strict-linux-cgroup-v2",
    environment: {}, executablePath: "/synthetic/provider", executableSha256: "a".repeat(64), privateRootPath,
    intentMode: "analysis", provider: "codex", spawnMode: "sdk-delegated"},
});

const linux = {skip: process.platform !== "linux" ? "Requires Linux descriptor custody" : false, timeout: 30_000};
const retainedRoots = new Set<object>();
const unexpected = () => {throw new Error("no late preparation effect");};

for (const debt of [false, true]) {
  test(`containment joins concrete physical cleanup and private root before receipt without release: debt=${debt}`, linux, async t => {
    const f = await residueFixture(t); installSyntheticInit(f.fake);
    const create = createInput(f.root);
    await fs.chmod(dirname(create.privateRootSource), 0o700);
    await fs.chmod(create.privateRootSource, 0o700);
    const raw = new DockerKernelHostCustody(5000);
    const reservation = input(hostIdentity.operationId, hostIdentity.attemptId, create.workspaceSource, create.privateRootSource);
    const handle = await raw.reserve(reservation);
    const roots = createHostPrivateRootOwnerFactory(hostIdentity);
    let launch: Awaited<ReturnType<typeof f.launch>>;
    let cleanups = 0; let cleanup: Promise<{kind: "released" | "quarantined"}> | undefined;
    const preparation = {cutoff() {}, cleanup() {
      return cleanup ??= (async () => {cleanups += 1;
        return {kind: (await f.contain(launch)).kind === "closed" ? "released" as const : "quarantined" as const};
      })();
    }};
    const root = roots.create({rootPath: create.privateRootSource, workspacePath: create.workspaceSource,
      operationId: reservation.operationId, attemptId: reservation.attemptId, custodyRef: handle.custodyRef}, preparation);
    retainedRoots.add(root);
    raw.installCleanup(handle.custodyRef, preparation); raw.installPrivateRoot(handle.custodyRef, root);
    const binding = await root.capture(); await root.revalidate();
    assert.equal(binding.canonicalBindSourcePath, create.privateRootSource);
    launch = await f.launch();
    const init = initOptions();
    const io = prepareDockerProviderProcessIo({launch, init, expected: {authority: launch.authority,
      custodyRef: launch.key.custodyId, generation: init.authority.generation, workspaceAuthorityPath: create.workspaceSource}});
    raw.reservation(handle.custodyRef).evidence.attach(f.lifecycle, launch, io); await io.ready();
    f.controls.descendants = debt;
    const request = {...handle, operationId: reservation.operationId, attemptId: reservation.attemptId};
    const first = raw.requestContainment(request); const second = raw.requestContainment(request);
    assert.strictEqual(first, second);
    const result = await first;
    assert.equal(result.kind, debt ? "unproven" : "contained");
    const evidence = raw.evidence(handle.custodyRef)!;
    assert.equal(evidence.identity.hostLifecycleGenerationSha256, binding.hostLifecycleGenerationSha256);
    assert.equal(evidence.privateRoot.status, debt ? "active" : "deleted");
    assert.equal(evidence.identity.status, "unproven"); // No independently read image in this case.
    if (!debt) {
      await assert.rejects(fs.stat(create.privateRootSource), {code: "ENOENT"});
      assert.equal(root.snapshot().history.filter(event => event === "exact-entry-remove-attempt").length, 1);
      assert.equal(root.snapshot().retainedHandles, 0);
    }
    await raw.requestContainment(request); assert.equal(cleanups, 1);
    if (!debt) {assert.equal(f.io.handles.size, 0);}
  });
}

test("cancel during real root capture retains preparation and cleanup flights; no late network/create", linux, async t => {
  const f = await postClaimFixture(t);
  const base = await fs.mkdtemp("/tmp/ar69-host-root-join-");
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  const privateRootPath = join(base, "private"); const workspace = join(base, "workspace");
  await fs.mkdir(privateRootPath, {mode: 0o700}); await fs.mkdir(workspace, {mode: 0o700});
  const raw = new DockerKernelHostCustody(5000);
  const reservation = input(f.proof.operationId, f.proof.attemptId, workspace, privateRootPath);
  const handle = await raw.reserve(reservation);
  const dependencies = {...f.dependencies, create: {...f.dependencies.create, workspaceSource: workspace, privateRootSource: privateRootPath}};
  const roots = createHostPrivateRootOwnerFactory(f.proof);
  let providerCut = false;
  const resources = createDockerHostReservationOwners({roots, raw, custodyRef: handle.custodyRef, dependencies,
    cutoffProvider() {providerCut = true;}, lock: imageLock(dependencies.create.imageDigest)});
  const preparation = createDockerLinuxPostClaimOwner(dependencies, {...resources.hooks,
    prepareProviderIo: unexpected, finishClaimed: unexpected});
  resources.attach(preparation);
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === "/proc/sys/kernel/random/boot_id") {entered.resolve(); await gate.promise;}
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {gate.resolve(); t.mock.restoreAll(); syncBuiltinESMExports();});
  const preparing = preparation.preparation.prepareClaimed({...f.claimed, underlyingCustodyRef: handle.custodyRef});
  await entered.promise;
  const root = roots.get(handle.custodyRef)!;
  assert.ok(root.snapshot().retainedHandles > 0);
  f.controller.abort();
  const containing = raw.requestContainment({...handle, operationId: reservation.operationId, attemptId: reservation.attemptId});
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(root.snapshot().history.includes("exact-entry-remove-attempt"), false);
  assert.equal(providerCut, true);
  gate.resolve();
  assert.notEqual((await preparing).kind, "prepared"); await containing;
  assert.equal(root.snapshot().evidence.status, "deleted");
  assert.deepEqual(f.network.state.calls, []); assert.equal(f.events.includes("create"), false);
  assert.throws(() => raw.installPrivateRoot(handle.custodyRef, {...root}));
});

test("normal kernel terminal-attestation entrypoint deletes the owned root before observing final evidence", linux, async t => {
  const {ContainedTurnKernelCustodyAdapter} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js");
  const ids = await import("../../contained-turn-kernel-fixtures.ts");
  const {containedTurnOperationCutoffRevision} = await import("../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js");
  const f = await residueFixture(t); installSyntheticInit(f.fake);
  const create = createInput(f.root);
  await fs.chmod(dirname(create.privateRootSource), 0o700); await fs.chmod(create.privateRootSource, 0o700);
  const raw = new DockerKernelHostCustody(5000);
  let custodyRef = "";
  const plan = {...input(ids.operationId, ids.attemptId, create.workspaceSource, create.privateRootSource).launchPlan,
    binaryRevision: ids.adapterSnapshot.binaryRevision};
  const custody = new ContainedTurnKernelCustodyAdapter(raw, {hostBootId: ids.hostBootId, hostInstanceId: ids.hostInstanceId,
    postClaimPreparation: {async prepareClaimed() {throw new Error("terminal observation does not prepare a new launch");}},
    attemptOwner: {async prepare() {return plan;}, retain(retained) {custodyRef = retained.underlyingCustodyRef;}, retire() {}},
    workspaceOwner: {async withLaunchAuthority(_input, consume) {
      return consume({canonicalPath: create.workspaceSource, descriptorPath: create.workspaceSource,
        identity: {dev: 1n, ino: 2n, mountId: "synthetic"}});
    }}});
  await custody.open({adapterSnapshot: ids.adapterSnapshot, providerAccessSnapshot: ids.providerAccessSnapshot,
    attemptId: ids.attemptId, operationId: ids.operationId, custodyId: ids.custodyId, effectId: ids.effectId,
    authorityVectorDigest: ids.authorityDigest, commandId: ids.commandId, preparationToken: ids.preparationToken,
    workspaceId: ids.workspaceId, intentMode: "analysis", operationRevision: 1,
    operationCutoffRevision: containedTurnOperationCutoffRevision(0)});
  const roots = createHostPrivateRootOwnerFactory({hostBootId: ids.hostBootId, hostInstanceId: ids.hostInstanceId});
  let launch: Awaited<ReturnType<typeof f.launch>>;
  let cleanup: Promise<{kind: "released" | "quarantined"}> | undefined;
  const preparation = {cutoff() {}, cleanup() {return cleanup ??= f.contain(launch).then(result =>
    ({kind: result.kind === "closed" ? "released" as const : "quarantined" as const}));}};
  const root = roots.create({rootPath: create.privateRootSource, workspacePath: create.workspaceSource,
    operationId: ids.operationId, attemptId: ids.attemptId, custodyRef}, preparation);
  raw.installCleanup(custodyRef, preparation); raw.installPrivateRoot(custodyRef, root);
  await root.capture();
  launch = await f.lifecycle.launch({call: engineCall(), create,
    owner: {...hostIdentity, hostBootId: ids.hostBootId, hostInstanceId: ids.hostInstanceId,
      operationId: ids.operationId, attemptId: ids.attemptId, custodyId: ids.custodyId}});
  const init = initOptions(); const io = prepareDockerProviderProcessIo({launch, init,
    expected: {authority: launch.authority, custodyRef: launch.key.custodyId, generation: init.authority.generation,
      workspaceAuthorityPath: create.workspaceSource}});
  raw.reservation(custodyRef).evidence.attach(f.lifecycle, launch, io); await io.ready();
  assert.equal(root.snapshot().evidence.status, "active");
  let releases = 0; t.mock.method(raw, "release", async () => {releases += 1; throw new Error("no manual release");});
  const result = await custody.attestExecutionClosure({attemptId: ids.attemptId, operationId: ids.operationId,
    custodyId: ids.custodyId, finalCursor: 0});
  assert.equal(root.snapshot().evidence.status, "deleted");
  assert.equal(raw.evidence(custodyRef)!.privateRoot.status, "deleted");
  // Cleanup cannot invent the missing independent provider-start/completion proof.
  assert.equal(result.kind, "indeterminate"); assert.equal(releases, 0);
  await assert.rejects(fs.stat(create.privateRootSource), {code: "ENOENT"});
});

test("cleanup timeout during beforeLaunch retains the original preparation and network until the hook settles", async t => {
  const f = await postClaimFixture(t);
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  t.after(() => {gate.resolve();});
  let selections = 0;
  const owner = createDockerLinuxPostClaimOwner(f.dependencies, {
    async beforeLaunch() {
      selections += 1; entered.resolve(); await gate.promise;
      throw new TypeError("image selection unavailable after cutoff");
    },
    prepareProviderIo: unexpected, finishClaimed: unexpected,
  });
  const preparing = owner.preparation.prepareClaimed(f.claimed);
  let settled = false;
  void preparing.then(() => {settled = true; return null;});
  await entered.promise;
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 10}), {kind: "quarantined"});
  assert.equal(settled, false);
  assert.equal(f.network.state.calls.some(call => call.startsWith("DELETE ")), false);
  assert.deepEqual(await owner.preparation.prepareClaimed(f.claimed), {kind: "unsupported", reason: "owner"});
  gate.resolve();
  // Once the hook settles, durable no-creation evidence permits exact network
  // release. The earlier timeout must not permanently cache quarantine.
  assert.deepEqual(await preparing, {kind: "unsupported", reason: "broker"});
  assert.deepEqual(await owner.cleanup({deadlineEpochMs: Date.now() + 5000}), {kind: "released"});
  assert.equal(selections, 1);
  assert.equal(f.network.state.calls.filter(call => call.startsWith("DELETE ")).length, 1);
  assert.equal(f.events.includes("create"), false);
  assert.throws(() => owner.takePrepared(f.claimed));
});
