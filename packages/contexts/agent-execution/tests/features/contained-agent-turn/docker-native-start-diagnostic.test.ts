import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import test from "node:test";
import {nativeFinalizerFixture} from "./support/docker-native-finalizer-fixture.ts";
import {nativeStartDiagnostic} from "../../../src/features/contained-agent-turn/composition/docker-native-start-diagnostic.ts";
import {createDeferredCodexNativeBrokerFiles} from "../../../src/features/contained-agent-turn/composition/deferred-codex-native-broker-files.ts";
import {createDockerCodexNativeBrokerFinalizer} from "../../../src/features/contained-agent-turn/composition/docker-codex-native-broker-finalizer.ts";

for (const failure of ["preflight", "install", "after-install", "files-prepare-validate", "recipe-build", "bind-session", "return-validate", "success"] as const) {
  test(`native start readback: ${failure}, no thrown payload retained`, async t => {
    const f = await nativeFinalizerFixture(t);
    const secret = "SECRET-config-env-credential-error-payload";
    let reads = 0;
    const error = new Error(secret);
    Object.defineProperty(error, "code", {get() {reads++; throw new Error(secret);}});
    const install = f.input.nativeFiles.install;
    f.input.nativeFiles.install = async recipe => {
      const during = nativeStartDiagnostic(f.input.nativeFiles)!;
      assert.equal(during.phase, "install"); assert.equal(during.lastCompleted, "ingress-open");
      if (failure === "install") {throw error;}
      await install(recipe);
      if (failure === "after-install") {f.f.controller.abort();}
      if (failure === "files-prepare-validate") {writeFileSync(`${f.codexHome}/models.json`, secret);}
    };
    const running = f.start(undefined, input => {
      if (failure === "preflight") {return {...input, originalPlan: {...input.originalPlan}};}
      return {...input, http: {...input.http, openIngress() {
        const ingress = input.http.openIngress();
        if (failure === "recipe-build") {return {...ingress, nativeBearerToken() {throw error;}};}
        return ingress;
      }, bindSession(dependencies) {
        if (failure === "bind-session") {throw error;}
        const session = input.http.bindSession(dependencies);
        if (failure === "return-validate") {writeFileSync(`${f.codexHome}/models.json`, secret);}
        return session;
      }}};
    });
    assert.equal(nativeStartDiagnostic(f.input.nativeFiles)!.lastCompleted, null);
    const result = await running.prepare();
    const observed = nativeStartDiagnostic(f.input.nativeFiles)!;
    assert.equal(result.kind === "prepared", failure === "success");
    assert.equal(observed.failingPhase, failure === "success" ? null : failure);
    const previous = {preflight: null, install: "ingress-open", "after-install": "install",
      "files-prepare-validate": "after-install", "recipe-build": "after-files", "bind-session": "recipe-validate",
      "return-validate": "bind-session", success: "return"};
    assert.equal(observed.lastCompleted, previous[failure]);
    assert.equal(observed.cutoff, failure !== "success");
    assert.equal(observed.errorCode, failure === "success" ? null : "native-start-rejected");
    assert.equal(JSON.stringify(observed).includes(secret), false); assert.equal(reads, 0);
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(f.f.events.includes("provider-exec"), false);
    running.finalizer.cutoff();
    assert.equal(nativeStartDiagnostic(f.input.nativeFiles)!.cutoff, true);
    assert.equal(observed.cutoff, failure !== "success"); // Immutable point-in-time readback.
  });
}

test("existing deferred native file snapshot carries private start evidence", async t => {
  const f = await nativeFinalizerFixture(t);
  const files = createDeferredCodexNativeBrokerFiles({boundary: f.boundary, ownerUid: 0, ownerGid: 0,
    catalogSource: Buffer.from("synthetic")});
  assert.equal(files.snapshot().nativeStart, undefined);
  const owner = createDockerCodexNativeBrokerFinalizer({...f.input, nativeFiles: files});
  await assert.rejects(owner.finishClaimed({} as never), /Docker Codex native broker finalization unavailable/);
  assert.deepEqual(files.snapshot().nativeStart, {phase: "preflight", lastCompleted: null,
    failingPhase: "preflight", cutoff: true, errorCode: "native-start-rejected"});
});

import {linkNativeStartDiagnostic, nativeStartStep, recordNativeStart, retainNativeStartDiagnostic,
  type NativeStartPhase} from "../../../src/features/contained-agent-turn/composition/docker-native-start-diagnostic.ts";
import {captureDockerCodexProcessInput} from "../../../src/features/contained-agent-turn/composition/docker-codex-current-kernel-owner.ts";
import {createCodexDockerPathProjection} from "../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.ts";
import {dockerProviderProcessMountFacts} from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.ts";
import {connectionFixture, installProtocol} from "./support/docker-codex-kernel-fixture.ts";
import {rmSync} from "node:fs";

const postPhases: readonly NativeStartPhase[] = ["native-plan-recognition", "mount-path-projection",
  "process-input-projection", "process-input-tmpdir", "process-input-executable", "reservation-evidence-finalize",
  "plan-publication", "prepared-handoff", "plan-root-validation", "bridge-open"];
for (const [index, phase] of postPhases.entries()) {
  test(`first ${phase} failure survives later phase, settlement and finalizer cutoff`, () => {
    const files = {}; const capture = {}; const process = {};
    const recorder = retainNativeStartDiagnostic(files);
    recorder.begin("return"); recorder.complete();
    linkNativeStartDiagnostic(capture, files); linkNativeStartDiagnostic(process, capture);
    for (const previous of postPhases.slice(0, index)) {nativeStartStep(process, previous, () => {});}
    let reads = 0;
    const failure = new Proxy({}, {get() {reads++; throw new Error("SECRET");},
      getPrototypeOf() {reads++; throw new Error("SECRET");}, ownKeys() {reads++; throw new Error("SECRET");}});
    assert.throws(() => nativeStartStep(process, phase, () => {throw failure;}), error => error === failure);
    const first = nativeStartDiagnostic(files)!;
    assert.deepEqual(first, {phase, lastCompleted: index === 0 ? "return" : postPhases[index - 1],
      failingPhase: phase, cutoff: false, errorCode: "unknown"});
    recordNativeStart(capture, "begin", "bridge-open"); recordNativeStart(capture, "complete");
    recordNativeStart(capture, "fail"); recorder.fail(); recorder.cutoff();
    assert.deepEqual(nativeStartDiagnostic(files), {...first, cutoff: true});
    assert.equal(reads, 0); assert.equal(first.cutoff, false);
  });
}

test("diagnostic allocation failure neither rejects admission nor replaces a thrown value", () => {
  const files = {}; const recorder = retainNativeStartDiagnostic(files); const result = {}; const failure = {};
  const freeze = Object.freeze;
  try {
    Object.freeze = () => {throw failure;};
    assert.equal(nativeStartStep(files, "prepared-handoff", () => result), result);
    assert.throws(() => nativeStartStep(files, "plan-publication", () => {throw result;}), value => value === result);
    recorder.cutoff();
    retainNativeStartDiagnostic({});
  } finally {Object.freeze = freeze;}
  assert.equal(nativeStartStep({}, "prepared-handoff", () => result), result);
});

for (const fault of ["input", "tmpdir", "executable"] as const) {
  test(`actual process capture distinguishes ${fault} without reading thrown payload`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    const files = {}; const recorder = retainNativeStartDiagnostic(files);
    recorder.begin("return"); recorder.complete();
    linkNativeStartDiagnostic(f.options.process, files);
    const paths = createCodexDockerPathProjection(dockerProviderProcessMountFacts(f.options.process.launch), f.options.boundary);
    const plan = {...f.options.plan, ...(fault === "tmpdir" ? {tmpDir: "/outside-private-root"} : {}),
      ...(fault === "executable" ? {executablePath: "/outside-image"} : {})};
    if (fault === "input") {f.options.process.init = {...f.options.process.init, isCurrentGeneration: undefined as never};}
    assert.throws(() => captureDockerCodexProcessInput(f.options.process, plan, paths, new AbortController().signal, () => true));
    assert.deepEqual(nativeStartDiagnostic(files), {phase: fault === "input" ? "process-input-projection" : `process-input-${fault}`,
      failingPhase: fault === "input" ? "process-input-projection" : `process-input-${fault}`,
      lastCompleted: fault === "executable" ? "process-input-tmpdir" : "return", cutoff: false, errorCode: "unknown"});
    assert.equal(f.events.includes("provider-exec"), false);
  });
}

for (const fault of ["none", "publication-abort", "unissued-plan"] as const) {
  test(`actual postclaim publication ${fault} preserves first evidence before settlement`, async t => {
    const f = await nativeFinalizerFixture(t);
    const finalizer = createDockerCodexNativeBrokerFinalizer(f.input);
    const running = f.start({...finalizer, async finishClaimed(input) {
      const result = await finalizer.finishClaimed(input);
      const plan = fault === "unissued-plan" ? {...result.plan} : result.plan;
      linkNativeStartDiagnostic(plan, f.input.nativeFiles);
      if (fault === "publication-abort") {f.f.controller.abort();}
      return {...result, plan};
    }});
    const result = await running.prepare();
    const diagnostic = nativeStartDiagnostic(f.input.nativeFiles)!;
    assert.equal(result.kind === "prepared", fault === "none");
    assert.deepEqual(diagnostic, {phase: "plan-publication", lastCompleted: fault === "none" ? "plan-publication" : "return",
      failingPhase: fault === "none" ? null : "plan-publication", cutoff: fault === "publication-abort",
      errorCode: fault === "none" ? null : "unknown"});
    finalizer.cutoff();
    assert.deepEqual(nativeStartDiagnostic(f.input.nativeFiles), {...diagnostic, cutoff: true});
    assert.equal(f.f.events.includes("provider-exec"), false);
  });
}

for (const fault of ["handoff", "root", "bridge"] as const) {
  test(`actual current-kernel ${fault} refusal survives swallowed provider rejection`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    const files = {}; const recorder = retainNativeStartDiagnostic(files);
    recorder.begin("return"); recorder.complete(); linkNativeStartDiagnostic(f.options.process, files);
    const owner = f.owner(); t.after(() => owner.dispose());
    if (fault === "root") {rmSync(f.options.plan.tmpDir, {recursive: true});}
    if (fault === "bridge") {
      f.channel.onMessage = message => {
        if (message.kind === "provider-exec") {
          f.channel.push({kind: "provider-exec-ack", observation: "not-started", requestId: message.requestId});
        } else {f.channel.respond(message);}
      };
    }
    const input = fault === "handoff" ? {...f.input, attemptId: "substituted" as never} : f.input;
    assert.equal((await owner.provider.execute(input)).kind, "indeterminate");
    const expected = {handoff: "prepared-handoff", root: "plan-root-validation", bridge: "bridge-open"}[fault];
    const diagnostic = nativeStartDiagnostic(files)!;
    assert.equal(diagnostic.failingPhase, expected); assert.equal(diagnostic.phase, expected);
    assert.equal(diagnostic.lastCompleted, fault === "bridge" ? "plan-root-validation" :
      fault === "root" ? "prepared-handoff" : "process-input-projection");
    assert.equal(diagnostic.errorCode, "unknown");
    owner.dispose(); recorder.cutoff();
    assert.deepEqual(nativeStartDiagnostic(files), {...diagnostic, cutoff: true});
    assert.equal(f.events.includes("provider-input"), false);
    assert.equal(f.events.filter(event => event === "provider-exec").length, fault === "bridge" ? 1 : 0);
  });
}


test("successful actual bridge handoff completes the private diagnostic without affecting protocol", async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  const files = {}; const recorder = retainNativeStartDiagnostic(files);
  recorder.begin("return"); recorder.complete(); linkNativeStartDiagnostic(f.options.process, files);
  const requests = installProtocol(f); const owner = f.owner(); t.after(() => owner.dispose());
  assert.deepEqual(await owner.provider.execute(f.input), {kind: "completed", outcome: "succeeded"});
  assert.deepEqual(nativeStartDiagnostic(files), {phase: "bridge-open", lastCompleted: "bridge-open",
    failingPhase: null, cutoff: false, errorCode: null});
  assert.ok(requests.includes("turn/start"));
});


test("diagnostic lookup failure leaves actions and original throws untouched", () => {
  const files = {}; const recorder = retainNativeStartDiagnostic(files); const result = {};
  const get = WeakMap.prototype.get;
  try {
    WeakMap.prototype.get = () => {throw new Error("synthetic diagnostic lookup failure");};
    assert.equal(nativeStartStep(files, "prepared-handoff", () => result), result);
    assert.throws(() => nativeStartStep(files, "prepared-handoff", () => {throw result;}), value => value === result);
    recorder.begin("return"); recorder.complete(); recorder.fail(); recorder.cutoff();
    assert.equal(nativeStartDiagnostic(files), undefined);
    linkNativeStartDiagnostic({}, files);
  } finally {WeakMap.prototype.get = get;}
});
