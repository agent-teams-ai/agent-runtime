import assert from "node:assert/strict";
import {withWorkspaceAuthority} from "./support/docker-workspace-authority-fixture.ts";
import {imageLock} from "../../fixtures/docker-image-init-fixture.ts";
import {registerHooks} from "node:module";
import test from "node:test";
import {connectionFixture} from "./support/docker-codex-kernel-fixture.ts";
import {committedDispatchProofFixture} from "./support/committed-dispatch-proof-fixture.ts";
import {containedTurnIdentity as id} from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {containedTurnOperationCutoffRevision} from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {hostLaunchFinalizationRecipe} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {isIssuedCodexAppServerLaunchPlan} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";

// Component wiring evidence: capture the private finalizer call at the post-claim
// boundary without invoking Engine allocation. Native/HTTP integration runs in
// docker-native-finalizer.test.ts; this probe grants no synthetic custody proof.
let constructorUrl: string;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./docker-linux-post-claim-preparation.js" && /docker-codex-host-kernel-owner\.(?:js|ts)$/u.test(context.parentURL ?? "")) {
      return {url: "synthetic:docker-native-plan-join", shortCircuit: true};
    }
    if (specifier === "./docker-codex-current-kernel-owner.js" && /docker-codex-host-kernel-owner\.(?:js|ts)$/u.test(context.parentURL ?? "")) {
      constructorUrl = next(specifier, context).url;
      return {url: "synthetic:host-constructor-observer", shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/docker-codex-host-kernel-owner\.(?:js|ts)$/u.test(url)) {
      const loaded = next(url, context);
      return {...loaded, source: `${loaded.source}\nexport {createProvider as hostProviderProbe};`};
    }
    if (url === "synthetic:host-constructor-observer") {
      const actual = constructorUrl;
      return {format: "module", shortCircuit: true, source: `
        export * from ${JSON.stringify(actual)};
        import {createDockerCodexCurrentKernelOwner as create} from ${JSON.stringify(actual)};
        export let constructorFailure;
        export const createDockerCodexCurrentKernelOwner = options => {
          try {return create(options);} catch (error) {constructorFailure = error; throw error;}
        };`};
    }
    if (url !== "synthetic:docker-native-plan-join") {return next(url, context);}
    return {format: "module", shortCircuit: true, source: `
      export const createDockerLinuxPostClaimOwner = (_dependencies, join) => ({
        preparation: {async prepareClaimed(claimed) {
          const probe = _dependencies.postFinalizerProbe;
          if (probe !== undefined) {
            // The test lifecycle is deliberately not concrete Linux residue custody.
            try {_dependencies.openLifecycle({});} catch (error) {probe.lifecycleRefused(error);}
            // The actual IO hook retains its process before the unattached evidence
            // owner refuses. This probe never manufactures successful custody.
            try {join.prepareProviderIo({launch: probe.launch, init: probe.init});}
            catch (error) {probe.refused(error);}
            return await join.finishClaimed({claimed, launch: probe.badMount ? {...probe.launch} : probe.launch});
          }
          await join.finishClaimed({claimed});
          throw new Error("synthetic probe must refuse");
        }}, cutoff() {}, async cleanup() {return {kind: "quarantined"};}
      });`};
  },
});
// Expose the actual private wrapper only in this test module graph. The observer
// delegates to the real constructor and retains its rejection solely for identity checks.
const hostModule = await import("../../../dist/features/contained-agent-turn/composition/docker-codex-host-kernel-owner.js");
const {createDockerCodexHostKernelOwner} = hostModule;
const {hostProviderProbe} = hostModule as typeof hostModule & {
  hostProviderProbe(records: Map<string, unknown>, options: unknown, isDisposed: () => boolean): {
    execute(input: unknown): Promise<unknown>;
  };
};
const constructorObserver = await import("synthetic:host-constructor-observer");
hooks.deregister();

test("component evidence: kernel retains the original finalizer receiver, callback and finalizable plan", {skip: process.platform !== "linux"}, async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  let selections = 0; let finishes = 0;
  const seen: unknown[] = [];
  const options = {
    imageInitLock: imageLock(), cleanupMilliseconds: 100, hostBootId: "host-boot:docker", hostInstanceId: "host-instance:docker",
    platformTarget: f.options.platformTarget, effectCustody: f.options.effectCustody,
    launchRecords: {async resolve() {return {boundary: f.options.boundary, executablePath: f.options.plan.executablePath,
      privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir,
      credentialOutputInventory: f.options.credentialOutputInventory};}},
    workspaceOwner: {async withLaunchAuthority(_input: unknown, consume: (authority: never) => unknown) {
      return withWorkspaceAuthority(f.options.plan.workspaceRef, f.options.attempt.operationId, consume);
    }},
    preparation() {selections += 1; return {deadlines: {routeLifetimeMs: 1000},
      workspaceBackingTreeOwnership: {kind: "exclusive-host-owned-disposable-tree", evidenceRef: "urn:synthetic:finalizer-wiring"},
      nativeFiles: {bindRoot() {throw new Error("no root capture in wiring probe");},
        install() {throw new Error("no installation in wiring probe");}, cutoff() {}, async quiesce() {},
        snapshot() {throw new Error("no material evidence in wiring probe");}}};},
    finishClaimed(input: {originalPlan: unknown}) {
      assert.equal(this, options); finishes += 1; seen.push(input.originalPlan);
      throw new Error("synthetic probe ends before any finalization effect");
    },
  };
  const owner = createDockerCodexHostKernelOwner(options as never); t.after(() => owner.dispose());
  assert.equal(selections, 0); assert.equal(finishes, 0);
  let mutationReads = 0;
  const mutation = () => {mutationReads += 1; throw new Error("mutated invocation property");};
  for (const property of ["bind", "call", "apply", "name", "length"]) {
    Object.defineProperty(options.finishClaimed, property, {get: mutation});
  }
  // Replacing the original method cannot redirect the retained callback.
  options.finishClaimed = () => {throw new Error("mutated callback");};
  const open = {...f.options.attempt, intentMode: f.options.attempt.intent.mode,
    commandId: id("command", "command:docker"), preparationToken: id("preparation", "preparation:docker"),
    operationCutoffRevision: containedTurnOperationCutoffRevision(0), operationRevision: 1};
  const opened = await owner.custody.open(open);
  assert.equal(selections, 0); assert.equal(finishes, 0);
  const start = {attemptId: open.attemptId, custodyId: open.custodyId, operationId: open.operationId,
    workspaceId: open.workspaceId, intentMode: open.intentMode,
    committedDispatchProof: committedDispatchProofFixture(open, opened),
    async execute() {throw new Error("no provider effect in wiring probe");}};
  const originalApply = Reflect.apply;
  let result;
  try {
    Reflect.apply = mutation;
    result = await owner.custody.start(start);
  } finally {Reflect.apply = originalApply;}
  assert.equal(result.kind, "indeterminate");
  assert.equal(mutationReads, 0);
  assert.equal(selections, 1); assert.equal(finishes, 1);
  assert.ok(isIssuedCodexAppServerLaunchPlan(seen[0]));
  const plan = seen[0]; const recipe = hostLaunchFinalizationRecipe(plan);
  assert.ok(recipe); assert.notEqual(plan, f.options.plan);
  assert.equal(plan.codexHome, f.options.boundary.codexHome);
  assert.equal(recipe.providerAccess.credentialGeneration, open.providerAccessSnapshot.credentialGeneration);
  await assert.rejects(owner.custody.start(start)); assert.equal(finishes, 1);
});

import {nativeStartDiagnostic, retainNativeStartDiagnostic, linkNativeStartDiagnostic, nativeStartStep, recordNativeStart} from "../../../dist/features/contained-agent-turn/composition/docker-native-start-diagnostic.js";
import {brokerFixture} from "../../fixtures/codex-native-broker-0.153.4/fixture.ts";

for (const fault of ["native-plan-recognition", "mount-path-projection", "reservation-evidence-finalize"] as const) {
  // Workspace authority uses Linux directory descriptors before reaching this probe.
  test(`actual Host post-finalizer wrapper attributes ${fault} before cutoff`, {skip: process.platform !== "linux"}, async t => {
    const f = await connectionFixture(brokerFixture(t)); t.after(() => f.contain());
    let finishes = 0; let ioRefusals = 0; let ioFailure: unknown; let lifecycleFailure: unknown;
    const files = {bindRoot() {}, install() {}, async quiesce() {}, snapshot() {return {};}, cutoff() {recorder.cutoff();}};
    const recorder = retainNativeStartDiagnostic(files);
    const options = {
      imageInitLock: imageLock(), cleanupMilliseconds: 100, hostBootId: "host-boot:docker", hostInstanceId: "host-instance:docker",
      platformTarget: f.options.platformTarget,
      launchRecords: {async resolve() {return {boundary: f.options.boundary, executablePath: f.options.plan.executablePath,
        privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir,
        credentialOutputInventory: f.options.credentialOutputInventory};}},
      workspaceOwner: {async withLaunchAuthority(_input: unknown, consume: (authority: never) => unknown) {
        return withWorkspaceAuthority(f.options.plan.workspaceRef, f.options.attempt.operationId, consume);
      }},
      preparation() {return {deadlines: {routeLifetimeMs: 1000}, enginePolicy: {user: "1000:1000"},
        workspaceBackingTreeOwnership: {kind: "exclusive-host-owned-disposable-tree", evidenceRef: "urn:synthetic:diagnostic-wiring"},
        nativeFiles: files, openLifecycle() {return f.lifecycle;}, postFinalizerProbe: {launch: f.options.process.launch, init: f.options.process.init,
          badMount: fault === "mount-path-projection", lifecycleRefused(error: unknown) {lifecycleFailure = error;}, refused(error: unknown) {
            ioFailure = error; ioRefusals++;
          }}};},
      async finishClaimed() {
        finishes++; recorder.begin("return"); recorder.complete();
        return {plan: fault === "native-plan-recognition" ? {...f.options.plan} : f.options.plan};
      },
    };
    const owner = createDockerCodexHostKernelOwner(options as never); t.after(() => owner.dispose());
    const open = {...f.options.attempt, intentMode: f.options.attempt.intent.mode,
      commandId: id("command", "command:diagnostic"), preparationToken: id("preparation", "preparation:diagnostic"),
      operationCutoffRevision: containedTurnOperationCutoffRevision(0), operationRevision: 1};
    const opened = await owner.custody.open(open);
    const start = {attemptId: open.attemptId, custodyId: open.custodyId, operationId: open.operationId,
      workspaceId: open.workspaceId, intentMode: open.intentMode, committedDispatchProof: committedDispatchProofFixture(open, opened),
      async execute() {throw new Error("probe must never admit execution");}};
    assert.equal((await owner.custody.start(start)).kind, "indeterminate");
    assert.ok(lifecycleFailure instanceof TypeError);
    assert.match(lifecycleFailure.message, /concrete Linux residue owner/u);
    assert.ok(ioFailure instanceof TypeError);
    assert.match(ioFailure.message, /Docker provider IO attachment unavailable/u);
    assert.equal(finishes, 1); assert.equal(ioRefusals, 1);
    assert.deepEqual(nativeStartDiagnostic(files), {phase: fault, failingPhase: fault, cutoff: true, errorCode: "unknown",
      lastCompleted: fault === "native-plan-recognition" ? "return" :
        fault === "mount-path-projection" ? "native-plan-recognition" : "process-input-projection"});
    await assert.rejects(owner.custody.start(start));
    assert.equal(finishes, 1); assert.equal(f.events.includes("provider-exec"), false);
  });
}

for (const earlierFailure of [false, true]) {
  test(`actual Host constructor inventory rejection preserves throw and first failure: ${earlierFailure}`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    const files = {}; const recorder = retainNativeStartDiagnostic(files);
    recorder.begin("return"); recorder.complete();
    linkNativeStartDiagnostic(f.options.process, files);
    if (earlierFailure) {
      nativeStartStep(files, "process-input-tmpdir", () => {});
      recordNativeStart(files, "begin", "process-input-executable");
      recordNativeStart(files, "fail");
    }
    const first = nativeStartDiagnostic(files);
    let takes = 0;
    const retained = {kernel: {...f.input, intentMode: f.input.intent.mode},
      nativeFiles: files, used: false, claimed: {}, process: f.options.process,
      effectOwner: {authority: f.options.effectCustody},
      record: {boundary: f.options.boundary, credentialOutputInventory: {}},
      owner: {takePrepared() {takes++; return {plan: f.options.plan};}}};
    const provider = hostProviderProbe(new Map([[f.input.custodyId, retained]]),
      {platformTarget: f.options.platformTarget}, () => false);
    await assert.rejects(provider.execute(f.input), error => {
      assert.equal(error, constructorObserver.constructorFailure);
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /credential output inventory must have an exact bounded shape/u);
      return true;
    });
    assert.equal(takes, 1);
    assert.deepEqual(nativeStartDiagnostic(files), earlierFailure ? first : {
      phase: "prepared-handoff", failingPhase: "prepared-handoff", lastCompleted: "process-input-projection",
      cutoff: false, errorCode: "unknown"});
    assert.equal(f.events.includes("provider-exec"), false);
  });
}
