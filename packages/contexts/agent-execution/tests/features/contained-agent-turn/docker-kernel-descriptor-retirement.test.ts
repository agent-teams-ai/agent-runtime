import assert from "node:assert/strict";
import {mkdtemp, readdir, readlink, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {DockerKernelHostCustody} from "../../../dist/features/contained-agent-turn/composition/docker-kernel-host-custody.js";
import type {HostCustodyReservationInput} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import {withWorkspaceAuthority} from "./support/docker-workspace-authority-fixture.ts";

const inputFor = (workspaceRef: string): Omit<HostCustodyReservationInput, "workspaceAuthority"> => ({
  operationId: "operation:retirement", attemptId: "attempt:retirement", intentMode: "analysis", workspaceRef,
  providerBinding: {provider: "codex", binaryRevision: "synthetic", adapterRevision: "synthetic",
    capabilityManifestRevision: "synthetic", credentialBindingDigest: "synthetic", providerRouteRef: "synthetic"},
  launchPlan: {arguments: [], binaryRevision: "synthetic", containmentProfile: "strict-linux-cgroup-v2",
    environment: {}, executablePath: "/synthetic/provider", executableSha256: "a".repeat(64),
    privateRootPath: join(workspaceRef, "unused-private"), intentMode: "analysis", provider: "codex", spawnMode: "sdk-delegated"},
});
const descriptors = async (path: string) => {
  const targets = await Promise.all((await readdir("/proc/self/fd")).map(async fd => {
    try {return await readlink(`/proc/self/fd/${fd}`);} catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {return;}
      throw error;
    }
  }));
  return targets.filter(target => target === path).length;
};

for (const disposeFirst of [false, true]) {
  test(`unstarted descriptor retires with pending reads and disposeFirst=${disposeFirst}`, {skip: process.platform !== "linux"}, async t => {
    const path = await mkdtemp(join(tmpdir(), "docker-descriptor-retirement-"));
    t.after(() => rm(path, {recursive: true, force: true}));
    const raw = new DockerKernelHostCustody(1000);
    const input = inputFor(path);
    const handle = await withWorkspaceAuthority(path, input.operationId, workspaceAuthority => raw.reserve({...input, workspaceAuthority}));
    const retained = raw.reservation(handle.custodyRef);
    t.after(() => retained.workspace.close());
    assert.equal(await descriptors(path), 1);
    const before = raw.evidence(handle.custodyRef);
    const reads = Promise.allSettled([retained.workspace.revalidate(), retained.workspace.revalidate()]);
    const request = {...handle, operationId: input.operationId, attemptId: input.attemptId};
    if (disposeFirst) {raw.dispose();}
    const first = raw.requestContainment(request);
    assert.equal(raw.requestContainment(request), first);
    assert.throws(() => raw.installCleanup(handle.custodyRef, {cutoff() {}, async cleanup() {return {kind: "released"};}}));
    assert.equal((await first).kind, "unproven");
    await reads;
    assert.equal(await descriptors(path), 0);
    await assert.rejects(retained.workspace.revalidate(), /closed/);
    assert.deepEqual(raw.evidence(handle.custodyRef), before);
    assert.equal((await raw.release({...request, receiptRef: "invented"})).kind, "unproven");
    raw.dispose(); raw.dispose();
    assert.equal((await raw.requestContainment(request)).kind, "unproven");
    assert.equal(await descriptors(path), 0);
    assert.equal(raw.reservation(handle.custodyRef).workspace, retained.workspace);
  });
}

test("installed cleanup debt retains the descriptor across containment and disposal", {skip: process.platform !== "linux"}, async t => {
  const path = await mkdtemp(join(tmpdir(), "docker-descriptor-debt-"));
  t.after(() => rm(path, {recursive: true, force: true}));
  const raw = new DockerKernelHostCustody(1000);
  const input = inputFor(path);
  const handle = await withWorkspaceAuthority(path, input.operationId, workspaceAuthority => raw.reserve({...input, workspaceAuthority}));
  const retained = raw.reservation(handle.custodyRef);
  t.after(() => retained.workspace.close());
  let observations = 0;
  raw.installCleanup(handle.custodyRef, {cutoff() {}, async cleanup() {observations += 1; return {kind: "quarantined"};}});
  const request = {...handle, operationId: input.operationId, attemptId: input.attemptId};
  assert.equal((await raw.requestContainment(request)).kind, "unproven");
  raw.dispose();
  assert.equal((await raw.requestContainment(request)).kind, "unproven");
  assert.equal(observations, 2);
  assert.equal(await descriptors(path), 1);
  await retained.workspace.revalidate();
});

test("dispose racing an in-flight reserve closes the unpublished descriptor", {skip: process.platform !== "linux"}, async t => {
  const path = await mkdtemp(join(tmpdir(), "docker-descriptor-reserve-"));
  t.after(() => rm(path, {recursive: true, force: true}));
  const raw = new DockerKernelHostCustody(1000);
  const input = inputFor(path);
  await withWorkspaceAuthority(path, input.operationId, async workspaceAuthority => {
    const pending = raw.reserve({...input, workspaceAuthority});
    raw.dispose();
    await assert.rejects(pending, {name: "HostCustodyUnsupportedError"});
  });
  assert.equal(await descriptors(path), 0);
});
