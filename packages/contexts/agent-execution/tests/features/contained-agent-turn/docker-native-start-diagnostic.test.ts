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
