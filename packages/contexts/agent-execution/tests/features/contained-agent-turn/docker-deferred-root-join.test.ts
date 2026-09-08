import assert from "node:assert/strict";
import test from "node:test";
import {createDockerHostReservationOwners}
  from "../../../dist/features/contained-agent-turn/composition/docker-host-reservation-owners.js";

type Input = Parameters<typeof createDockerHostReservationOwners>[0];
type Preparation = Parameters<ReturnType<typeof createDockerHostReservationOwners>["attach"]>[0];
const fixture = () => {
  const controller = new AbortController();
  const events: string[] = [];
  const writer = Promise.withResolvers<void>();
  const reader = Promise.withResolvers<void>();
  let quiescence: Parameters<Input["roots"]["create"]>[1] | undefined;
  let installed: unknown;
  let creates = 0; let joins = 0;
  const binding = {canonicalBindSourcePath: "/synthetic/private", canonicalWorkspacePath: "/synthetic/workspace",
    hostLifecycleGenerationSha256: "a".repeat(64)};
  const root = {async capture() {events.push("capture"); return binding;}};
  const nativeFiles = {bindRoot(owner: unknown) {assert.strictEqual(owner, installed); events.push("bind");},
    cutoff() {events.push("files-cut");}, quiesce() {joins += 1; return writer.promise;}};
  const roots = {create(_options: unknown, cleanup: typeof quiescence) {
    creates += 1; quiescence = cleanup; events.push("create-root"); return root;
  }};
  const raw = {reservation() {return {input: {operationId: "op", attemptId: "attempt", workspaceRef: binding.canonicalWorkspacePath,
    launchPlan: {privateRootPath: binding.canonicalBindSourcePath}}};},
    installCleanup(_ref: string, cleanup: typeof quiescence) {assert.strictEqual(cleanup, quiescence); events.push("cleanup");},
    installPrivateRoot(_ref: string, owner: unknown) {installed = owner; events.push("root");}};
  const preparation = {cutoff() {events.push("preparation-cut");}, async cleanup() {
    events.push("preparation-join"); await reader.promise; return {kind: "released" as const};
  }};
  const dependencies = {create: {privateRootSource: binding.canonicalBindSourcePath, workspaceSource: binding.canonicalWorkspacePath}};
  const resources = createDockerHostReservationOwners({roots, raw, nativeFiles, dependencies, signal: controller.signal,
    custodyRef: "custody", lock: {}, cutoffProvider() {events.push("provider-cut");}} as unknown as Input);
  return {resources, controller, events, writer, reader, nativeFiles, preparation, root, raw, dependencies,
    cleanup: () => quiescence!, counts: () => ({creates, joins}), attach() {resources.attach(preparation as unknown as Preparation);}};
};

const call = () => ({deadlineEpochMs: Date.now() + 10});

test("reservation binds exactly its installed root after capture and mount validation, once", async () => {
  const f = fixture(); f.attach(); await f.resources.hooks.captureHost();
  assert.deepEqual(f.events, ["create-root", "cleanup", "root", "capture", "bind"]);
  assert.equal(f.counts().creates, 1);
  assert.throws(() => f.attach());
});

test("mount conflict and cancellation during capture cannot bind", async () => {
  for (const scenario of ["mount", "cancel"]) {
    const f = fixture(); f.attach();
    if (scenario === "mount") {f.dependencies.create.workspaceSource = "/synthetic/other";}
    else {
      const capture = f.root.capture;
      f.root.capture = async () => {const binding = await capture(); f.controller.abort(); return binding;};
    }
    await assert.rejects(f.resources.hooks.captureHost());
    assert.equal(f.events.includes("bind"), false);
  }
});

test("binding exception retains attached custody; cancellation inside bind prevents handoff", async () => {
  for (const scenario of ["throw", "cancel"]) {
    const f = fixture(); f.attach();
    f.nativeFiles.bindRoot = () => {
      if (scenario === "throw") {throw new Error("inert constructor failure");}
      f.controller.abort();
    };
    await assert.rejects(f.resources.hooks.captureHost());
    assert.throws(() => f.attach());
    assert.equal(f.counts().creates, 1);
    f.writer.resolve(); f.reader.resolve();
    assert.deepEqual(await f.cleanup().cleanup({deadlineEpochMs: Date.now() + 1000}), {kind: "released"});
  }
});

test("partial attachment is consumed before fallible custody installation", () => {
  const f = fixture(); f.raw.installCleanup = () => {throw new Error("attachment failure");};
  assert.throws(() => f.attach()); assert.throws(() => f.attach());
  assert.equal(f.counts().creates, 1);
});

test("cleanup waits for writer and complete preparation reader, retaining late work across observations", async () => {
  const f = fixture(); f.attach(); await f.resources.hooks.captureHost();
  assert.deepEqual(await f.cleanup().cleanup(call()), {kind: "quarantined"});
  f.writer.resolve();
  assert.deepEqual(await f.cleanup().cleanup(call()), {kind: "quarantined"});
  assert.equal(f.counts().joins, 1);
  f.reader.resolve();
  assert.deepEqual(await f.cleanup().cleanup({deadlineEpochMs: Date.now() + 1000}), {kind: "released"});
  assert.equal(f.counts().joins, 1);
  await assert.rejects(f.resources.hooks.captureHost());
});

test("failed native quiescence and throwing cutoff remain quarantine while every owner is cut", async () => {
  for (const scenario of ["handle", "cutoff"]) {
    const f = fixture(); f.attach(); f.reader.resolve();
    if (scenario === "handle") {f.writer.reject(new Error("ambiguous close"));}
    else {f.writer.resolve(); f.nativeFiles.cutoff = () => {throw new Error("cutoff failed");};}
    for (let observation = 0; observation < 2; observation += 1) {
      assert.deepEqual(await f.cleanup().cleanup({deadlineEpochMs: Date.now() + 1000}), {kind: "quarantined"});
    }
    assert.ok(f.events.includes("provider-cut")); assert.ok(f.events.includes("preparation-cut"));
    assert.equal(f.counts().joins, 1);
  }
});


test("reentrant cancellation during mount validation cannot reach native binding", async () => {
  const f = fixture(); f.attach();
  const workspaceSource = f.dependencies.create.workspaceSource;
  Object.defineProperty(f.dependencies.create, "workspaceSource", {get() {
    f.controller.abort(); return workspaceSource;
  }});
  await assert.rejects(f.resources.hooks.captureHost());
  assert.equal(f.events.includes("bind"), false);
});
