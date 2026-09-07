import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {dirname, join} from "node:path";
import test from "node:test";
import {DockerKernelHostCustody} from "../../../dist/features/contained-agent-turn/composition/docker-kernel-host-custody.js";
import {createHostPrivateRootOwnerFactory} from "../../../dist/features/contained-agent-turn/composition/host-private-root-owner.js";
import {DockerHostCustodyLifecycle} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {DockerCustodyJournal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal.js";
import {createDockerImageInitOwner} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-image-init-owner.js";
import {prepareDockerProviderProcessIo, createDockerProviderProcessBridge} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {createCodexAppServerLaunchPlan} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {createCodexAppServerPermissionBoundary} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {DockerCustodyFrameDecoder} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {ObservationChannel, instance, tick} from "./support/docker-provider-observation-fixture.ts";
import {MemoryStorage, owner, digest} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {initOptions, providerExec} from "./support/docker-claim-init-fixture.ts";
import {imageInitFixture, INIT_HOST} from "../../fixtures/docker-image-init-fixture.ts";
import {call, disposable} from "../../fixtures/docker-engine-test-fixture.ts";

const retainedRoots = new Set<object>();

for (const image of ["same-generation", "wrong-generation", "missing"] as const) {
  test(`kernel identity joins factory root, exact image witness and finalized native spawn sample: ${image}`, async t => {
    const directory = await disposable(); t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const f = await imageInitFixture(directory);
    const create = {...f.input, operationNonceSha256: digest("operation"), launchFingerprintSha256: digest("launch")};
    const codexHome = join(create.privateRootSource, "home"); const tmpDir = join(create.privateRootSource, "tmp");
    for (const path of [dirname(create.privateRootSource), create.privateRootSource]) {await fs.chmod(path, 0o700);}
    for (const path of [codexHome, tmpDir]) {await fs.mkdir(path, {mode: 0o700});}
    const boundary = createCodexAppServerPermissionBoundary({codexHome, workspaceRef: create.workspaceSource, intentMode: "analysis"});
    const plan = createCodexAppServerLaunchPlan({boundary, executablePath: "/usr/local/bin/codex", intentMode: "analysis",
      platformTarget: {platform: "linux", architecture: "x64"}, privateRootPath: create.privateRootSource, tmpDir});
    const raw = new DockerKernelHostCustody(5000);
    const handle = await raw.reserve({operationId: owner.operationId, attemptId: owner.attemptId, workspaceRef: create.workspaceSource,
      intentMode: "analysis", launchPlan: plan,
      providerBinding: {provider: "codex", binaryRevision: plan.binaryRevision, adapterRevision: "synthetic",
        capabilityManifestRevision: "synthetic", credentialBindingDigest: "synthetic", providerRouteRef: "synthetic"},
      workspaceAuthority: {canonicalPath: create.workspaceSource, descriptorPath: create.workspaceSource,
        identity: {dev: 1n, ino: 2n, mountId: "synthetic"}}});
    const roots = createHostPrivateRootOwnerFactory(owner);
    const root = roots.create({rootPath: create.privateRootSource, workspacePath: create.workspaceSource,
      operationId: owner.operationId, attemptId: owner.attemptId, custodyRef: handle.custodyRef},
    {cutoff() {}, async cleanup() {return {kind: "quarantined"};}});
    retainedRoots.add(root);
    const evidence = raw.reservation(handle.custodyRef).evidence;
    evidence.attachPrivateRoot(root);
    const binding = await root.capture();
    const host = {...INIT_HOST, hostLifecycleGenerationSha256: image === "wrong-generation" ? "9".repeat(64) : binding.hostLifecycleGenerationSha256};
    const imageOwner = createDockerImageInitOwner({engine: f.engine, lock: f.lock, host});
    const channel = new ObservationChannel();
    const attach = f.engine.attachCustody.bind(f.engine);
    t.mock.method(f.engine, "attachCustody", async (...args: Parameters<typeof attach>) => {
      const retained = await attach(...args); t.after(() => retained.close()); return channel;
    });
    const lifecycle = new DockerHostCustodyLifecycle(f.engine, new DockerCustodyJournal(new MemoryStorage()), {async proveEmpty() {return "unknown";}});
    const launch = await lifecycle.launch({call: call(), owner, create,
      ...(image === "missing" ? {} : {imageInit: {owner: imageOwner, host}})});
    t.after(() => lifecycle.contain({authority: launch.authority, key: launch.key, call: call()}));
    const template = initOptions();
    const init = {...template, authority: {...template.authority,
      expectedIdentity: {...template.authority.expectedIdentity, containerImageSha256: "e".repeat(64)}}};
    const decoder = new DockerCustodyFrameDecoder();
    channel.input.on("data", bytes => {
      for (const message of decoder.push(bytes)) {
        if (message.kind === "host-handshake") {channel.push({kind: "init-ready", protocol: message.protocol,
          nonce: message.nonce, launchFingerprintSha256: message.launchFingerprintSha256, observedIdentity: message.expectedIdentity});}
        if (message.kind === "provider-exec") {
          channel.push({kind: "provider-exec-ack", observation: "started", requestId: message.requestId});
          channel.push({...instance(message), executableMapping: {kind: "linux-procfs-exe-v1", scope: "spawn-observation",
            device: "1", inode: "2", startTimeTicks: "3"}} as never);
        }
      }
    });
    const processInput = {launch, init, expected: {authority: launch.authority, custodyRef: launch.key.custodyId,
      generation: init.authority.generation, workspaceAuthorityPath: create.workspaceSource},
      exec: {...providerExec, executableSha256: plan.executableSha256}, call: call()};
    const io = prepareDockerProviderProcessIo(processInput);
    evidence.attach(lifecycle, launch, io); evidence.finalize(plan, processInput.exec);
    await createDockerProviderProcessBridge().open({...processInput, preparedIo: io}); await tick();
    const snapshot = evidence.snapshot();
    assert.equal(snapshot.spawn, "acknowledged");
    assert.equal(snapshot.identity.status, image === "same-generation" ? "proved" : "unproven");
    assert.equal(snapshot.identity.hostLifecycleGenerationSha256, binding.hostLifecycleGenerationSha256);
    assert.equal(snapshot.privateRoot.status, "active");
    assert.equal(snapshot.closure.status, "unproven");
    assert.equal(channel.readers, 1);
    await channel.close();
  });
}
