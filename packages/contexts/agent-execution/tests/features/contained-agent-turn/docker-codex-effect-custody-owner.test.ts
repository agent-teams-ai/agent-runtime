import assert from "node:assert/strict";
import {test} from "node:test";
import {chmod, readFile} from "node:fs/promises";
import {dirname} from "node:path";
import {createDockerCodexEffectCustodyOwner} from "../../../dist/features/contained-agent-turn/composition/docker-codex-effect-custody-owner.js";
import {createHostPrivateRootOwnerFactory} from "../../../dist/features/contained-agent-turn/composition/host-private-root-owner.js";
import {captureDockerWorkspaceCustody} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/node-linux-docker-residue-custody.js";
import {residueFixture} from "./support/linux-docker-residue-fixture.ts";
import {createInput, engineCall, owner} from "./support/docker-host-custody-lifecycle-fixture.ts";

for (const variant of ["valid", "workspace", "private", "mode", "generation", "execution", "ownership", "reservation"] as const) {
test(`concrete workspace custody join: ${variant}`, {skip: process.platform !== "linux"}, async t => {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const f = await residueFixture(t, "systemd", {bootId});
  const create = createInput(f.root);
  for (const path of [dirname(create.privateRootSource), create.privateRootSource]) {await chmod(path, 0o700);}
  const roots = createHostPrivateRootOwnerFactory(owner);
  const root = roots.create({rootPath: create.privateRootSource, workspacePath: create.workspaceSource,
    operationId: owner.operationId, attemptId: owner.attemptId, custodyRef: "reservation:test"},
  {cutoff() {}, async cleanup() {return {kind: "released"};}});
  const binding = await root.capture();
  // Local descriptor cleanup only, after synthetic containment below.
  t.after(() => root.quarantineAndDelete({deadlineEpochMs: Date.now() + 5000}));
  const launch = await f.launch();
  const observed = f.lifecycle.observeLaunch(launch);
  const pid = observed.initial.state.hostPid;
  f.io.file(`/proc/${pid}/mountinfo`, "1 0 0:1 / / ro - overlay overlay ro\n" +
    "20 1 0:5 /owned/workspace /workspace rw - ext4 disk rw\n" +
    "21 1 0:5 /owned/private /agent-private rw - ext4 disk rw\n", 65532);
  f.io.directory("/mounted"); f.io.directory("/namespace");
  const workspace = f.io.directory("/mounted/workspace");
  const privateRoot = f.io.directory("/mounted/agent-private");
  workspace.facts = {...workspace.facts, dev: binding.workspaceIdentity.dev, ino: binding.workspaceIdentity.ino};
  privateRoot.facts = {...privateRoot.facts, dev: binding.identity.dev, ino: binding.identity.ino};
  if (variant === "workspace") {workspace.facts = {...workspace.facts, ino: workspace.facts.ino + 1n};}
  if (variant === "private") {privateRoot.facts = {...privateRoot.facts, ino: privateRoot.facts.ino + 1n};}
  Object.assign(f.io, {
    async procObject(_process: object, name: string) {
      const directory = await f.io.open("/");
      try {return await f.io.child(directory, name === "root" ? "mounted" : "namespace", true);}
      finally {await f.io.close(directory);}
    },
    async mountId(file: {fd: number}) {
      const path = f.io.handles.get(file.fd)!.path;
      return path.endsWith("workspace") ? "20" : path.endsWith("agent-private") ? "21" : "1";
    },
  });
  Object.defineProperty(f.lifecycle, "observeLaunch", {value() {throw new Error("Caller-substituted readback must not run");}});
  await assert.rejects(captureDockerWorkspaceCustody(f.lifecycle, {...launch}, engineCall()));
  const proof = await captureDockerWorkspaceCustody(f.lifecycle, launch, engineCall());
  await assert.rejects(captureDockerWorkspaceCustody(f.lifecycle, launch, engineCall()));
  const execution = {operationId: owner.operationId, attemptId: owner.attemptId,
    custodyRef: owner.custodyId, effectId: "effect:test", workspaceRef: create.workspaceSource};
  const input = {execution, launch, proof, root, reservationCustodyRef: "reservation:test", hostLifecycleGenerationSha256: binding.hostLifecycleGenerationSha256,
    workspaceWritable: true, backingTreeOwnership: {kind: "exclusive-host-owned-disposable-tree" as const, evidenceRef: "urn:test:isolated-tree"}};
  assert.throws(() => createDockerCodexEffectCustodyOwner({...input, proof: {...proof}}));
  if (variant !== "valid") {
    if (variant === "reservation") {input.reservationCustodyRef = "foreign";}
    if (variant === "mode") {input.workspaceWritable = false;}
    if (variant === "generation") {input.hostLifecycleGenerationSha256 = "foreign";}
    if (variant === "execution") {input.execution.attemptId = "foreign";}
    if (variant === "ownership") {input.backingTreeOwnership.evidenceRef = "";}
    assert.throws(() => createDockerCodexEffectCustodyOwner(input));
    await f.contain(launch);
    return;
  }
  const custody = createDockerCodexEffectCustodyOwner(input);
  assert.throws(() => createDockerCodexEffectCustodyOwner(input));
  const request = {...execution, itemId: "one", itemType: "commandExecution" as const,
    phase: "started" as const, endpointObservations: []};
  const first = custody.authority.admit(request)!;
  const second = custody.authority.admit({...request, itemId: "two"})!;
  assert.ok(first); assert.ok(second); assert.notStrictEqual(first, second);
  for (const field of ["operationId", "attemptId", "custodyRef", "effectId", "workspaceRef"] as const) {
    assert.equal(custody.authority.admit({...request, [field]: "foreign", priorAdmission: first}), undefined);
  }
  assert.equal(custody.authority.admit({...request, priorAdmission: second}), undefined);
  assert.equal(custody.authority.admit(request), undefined);
  for (let index = 2; index < 4096; index += 1) {
    assert.ok(custody.authority.admit({...request, itemId: `bounded:${index}`}));
  }
  assert.equal(custody.authority.admit({...request, itemId: "overflow"}), undefined);
  custody.cutoff();
  assert.equal(custody.authority.admit({...request, itemId: "new"}), undefined);
  assert.strictEqual(custody.authority.admit({...request, phase: "completed", priorAdmission: first}), first);
  await f.contain(launch);
});
}
