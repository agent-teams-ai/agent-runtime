import assert from "node:assert/strict";
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
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./docker-linux-post-claim-preparation.js" && context.parentURL?.endsWith("docker-codex-host-kernel-owner.js")) {
      return {url: "synthetic:docker-native-plan-join", shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== "synthetic:docker-native-plan-join") {return next(url, context);}
    return {format: "module", shortCircuit: true, source: `
      export const createDockerLinuxPostClaimOwner = (_dependencies, join) => ({
        preparation: {async prepareClaimed(claimed) {
          await join.finishClaimed({claimed});
          throw new Error("synthetic probe must refuse");
        }}, cutoff() {}, async cleanup() {return {kind: "quarantined"};}
      });`};
  },
});
const {createDockerCodexHostKernelOwner} = await import("../../../dist/features/contained-agent-turn/composition/docker-codex-host-kernel-owner.js");
hooks.deregister();

test("component evidence: kernel privately retains the original finalizable plan before resource selection", async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  let selections = 0; let finishes = 0;
  const seen: unknown[] = [];
  const options = {
    cleanupMilliseconds: 100, hostBootId: "host-boot:docker", hostInstanceId: "host-instance:docker",
    platformTarget: f.options.platformTarget, effectCustody: f.options.effectCustody,
    launchRecords: {async resolve() {return {boundary: f.options.boundary, executablePath: f.options.plan.executablePath,
      privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir,
      credentialOutputInventory: f.options.credentialOutputInventory};}},
    workspaceOwner: {async withLaunchAuthority(_input: unknown, consume: (authority: never) => unknown) {
      return consume({canonicalPath: f.options.plan.workspaceRef, descriptorPath: f.options.plan.workspaceRef,
        identity: {dev: 1n, ino: 2n, mountId: "synthetic"}} as never);
    }},
    preparation() {selections += 1; return {deadlines: {routeLifetimeMs: 1000}};},
    finishClaimed(input: {originalPlan: unknown}) {
      assert.equal(this, options); finishes += 1; seen.push(input.originalPlan);
      throw new Error("synthetic probe ends before any finalization effect");
    },
  };
  const owner = createDockerCodexHostKernelOwner(options as never); t.after(() => owner.dispose());
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
  assert.equal((await owner.custody.start(start)).kind, "indeterminate");
  assert.equal(selections, 1); assert.equal(finishes, 1);
  assert.ok(isIssuedCodexAppServerLaunchPlan(seen[0]));
  const plan = seen[0]; const recipe = hostLaunchFinalizationRecipe(plan);
  assert.ok(recipe); assert.notEqual(plan, f.options.plan);
  assert.equal(plan.codexHome, f.options.boundary.codexHome);
  assert.equal(recipe.providerAccess.credentialGeneration, open.providerAccessSnapshot.credentialGeneration);
  await assert.rejects(owner.custody.start(start)); assert.equal(finishes, 1);
});
