import assert from "node:assert/strict";
import {dirname} from "node:path";
import {registerHooks} from "node:module";
import test from "node:test";
import {connectionFixture} from "./support/docker-codex-kernel-fixture.ts";
import {postClaimFixture} from "./support/docker-linux-post-claim-fixture.ts";
import {withWorkspaceAuthority} from "./support/docker-workspace-authority-fixture.ts";
import {committedDispatchProofFixture} from "./support/committed-dispatch-proof-fixture.ts";
import {imageLock} from "../../fixtures/docker-image-init-fixture.ts";
import {containedTurnIdentity as id} from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {containedTurnOperationCutoffRevision} from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {physicalEvidenceIsClosed, executionEvidenceIsClosed, noStartEvidenceIsClosed}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-projections.js";

// Run the actual Host kernel, post-claim owner, evidence, network/V4 journal,
// and concrete residue lifecycle. Only the unrelated root/image preparation
// boundary is omitted here. No private-root or image qualification is claimed.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "synthetic:early-root" || specifier === "./docker-host-reservation-owners.js" &&
      /docker-codex-host-kernel-owner\.(?:js|ts)$/u.test(context.parentURL ?? "")) {
      return {url: "synthetic:early-root", shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== "synthetic:early-root") {return next(url, context);}
    return {format: "module", shortCircuit: true, source: `
      export let retained;
      export const createDockerHostReservationOwners = input => {
        retained = input;
        return {hooks: {}, capturedRoot() {throw Error("unexpected init");},
          attach(owner) {input.raw.installCleanup(input.custodyRef, owner);}};
      };`};
  },
});
const {createDockerCodexHostKernelOwner} = await import("../../../dist/features/contained-agent-turn/composition/docker-codex-host-kernel-owner.js");
// @ts-expect-error Test-owned synthetic module supplied by the hook above.
const capture = await import("synthetic:early-root");
hooks.deregister();

const unused = () => {throw new Error("must not reach provider IO/finalization");};

for (const pending of ["none", "listener", "removal", "cutoff", "cutoff-removal", "cutoff-settlement"] as const) {
  test(`kernel early listener decoration failure retains physical closure without provider IO: pending=${pending}`,
    {skip: process.platform !== "linux", timeout: 15_000}, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    let selected: Awaited<ReturnType<typeof postClaimFixture>>;
    let executions = 0;
    const owner = createDockerCodexHostKernelOwner({cleanupMilliseconds: 1000, imageInitLock: imageLock(),
      finishClaimed: async () => unused(), hostBootId: "host-boot:docker", hostInstanceId: "host-instance:docker",
      platformTarget: f.options.platformTarget,
      launchRecords: {async resolve() {return {boundary: f.options.boundary, executablePath: f.options.plan.executablePath,
        privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir,
        credentialOutputInventory: f.options.credentialOutputInventory};}},
      workspaceOwner: {withLaunchAuthority(input, consume) {
        return withWorkspaceAuthority(f.options.plan.workspaceRef, input.operationId, consume);
      }},
      preparation() {return {...selected.dependencies,
        workspaceBackingTreeOwnership: {kind: "exclusive-host-owned-disposable-tree", evidenceRef: "urn:test:early-listener"},
        nativeFiles: {bindRoot: unused, install: unused, cutoff() {}, async quiesce() {}, snapshot: unused}};},
    });
    t.after(() => owner.dispose());
    const open = {...f.options.attempt, intentMode: f.options.attempt.intent.mode,
      commandId: id("command", "command:early-listener"), preparationToken: id("preparation", "preparation:early-listener"),
      operationCutoffRevision: containedTurnOperationCutoffRevision(0), operationRevision: 1};
    const opened = await owner.custody.open(open);
    const proof = committedDispatchProofFixture(open, opened);
    selected = await postClaimFixture(t, undefined, {root: dirname(dirname(f.options.plan.workspaceRef)), proof});
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    t.after(() => gate.resolve());
    const listener = selected.listener;
    const bind = listener.open.bind(listener);
    t.mock.method(listener, "open", async (...args: Parameters<typeof bind>) => {
      await bind(...args); // The bind succeeded; its decorator fails before allocation is published.
      if (pending === "listener") {entered.resolve(); await gate.promise;}
      throw new Error("synthetic firewall decoration failed after bind");
    });
    let actualLaunch: Awaited<ReturnType<typeof selected.lifecycle.launch>> | undefined;
    if (pending.startsWith("cutoff")) {
      const launch = selected.lifecycle.launch.bind(selected.lifecycle);
      t.mock.method(selected.lifecycle, "launch", async (...args: Parameters<typeof launch>) => {
        const actual = await launch(...args); actualLaunch = actual;
        const {raw, custodyRef} = capture.retained;
        // Cut the actual kernel-owned preparation between launch resolution and afterLaunch.
        void raw.requestContainment({custodyRef, operationId: open.operationId, attemptId: open.attemptId});
        return actual;
      });
    }
    if (pending === "removal" || pending === "cutoff-removal") {
      const remove = selected.engine.remove.bind(selected.engine);
      t.mock.method(selected.engine, "remove", async (...args: Parameters<typeof remove>) => {
        entered.resolve(); await gate.promise; return remove(...args);
      });
    }
    if (pending === "cutoff-settlement") {
      selected.network.state.before = async label => {
        if (label.startsWith("DELETE /v1.47/networks/")) {
          entered.resolve(); await gate.promise; // Physical closure is not preparation settlement.
        }
      };
    }
    const start = {attemptId: open.attemptId, custodyId: open.custodyId, operationId: open.operationId,
      workspaceId: open.workspaceId, intentMode: open.intentMode, committedDispatchProof: proof,
      async execute() {executions += 1; return {kind: "completed" as const, outcome: "succeeded" as const};}};
    const starting = owner.custody.start(start);
    if (pending === "listener" || pending === "removal" || pending === "cutoff-removal" || pending === "cutoff-settlement") {
      await entered.promise;
      const {raw, custodyRef} = capture.retained;
      assert.equal(raw.evidence(custodyRef).sealed, false);
      assert.equal(raw.evidence(custodyRef).closure.status, pending === "cutoff-settlement" ? "closed" : "unproven");
      await assert.rejects(owner.custody.start(start)); // Overlap cannot seal the original flight.
      assert.equal(raw.evidence(custodyRef).sealed, false);
      gate.resolve();
    }
    assert.equal((await starting).kind, "indeterminate");
    const {raw, custodyRef} = capture.retained;
    const evidence = raw.evidence(custodyRef);
    assert.equal(selected.physical.opens, pending.startsWith("cutoff") ? 0 : 1, JSON.stringify(selected.events));
    assert.equal(selected.physical.closes, pending.startsWith("cutoff") ? 0 : 1);
    assert.equal(selected.physical.consumption, 0);
    assert.equal(selected.events.includes("host-handshake"), false);
    assert.equal(selected.events.includes("provider-exec"), false);
    assert.equal(executions, 0);
    assert.equal(selected.routeAdmissions.length, 0);
    if (actualLaunch !== undefined) {
      const observed = selected.lifecycle.observeLaunch(actualLaunch);
      assert.equal(observed.journal.state, "closed");
      assert.notEqual(observed.recursiveEmpty, null);
      assert.notEqual(observed.removal, null);
      assert.equal(observed.attachCleanup, "complete");
      assert.equal(observed.execution, null);
    }
    assert.equal(evidence.closure.status, "closed");
    assert.equal(evidence.sealed, true);
    assert.equal(physicalEvidenceIsClosed(evidence), true);
    assert.equal(executionEvidenceIsClosed(evidence), false);
    assert.equal(noStartEvidenceIsClosed(evidence), false);
    assert.equal(evidence.spawn, "ambiguous");
    assert.equal(evidence.identity.status, "unproven");
    assert.equal(evidence.providerExit.status, "unobserved");
    assert.equal(evidence.stdout.status, "incomplete");
    assert.equal(evidence.stderr.status, "incomplete");
    assert.equal(evidence.privateRoot.status, "unproven");
    const request = {custodyRef, operationId: open.operationId, attemptId: open.attemptId};
    assert.equal((await raw.requestContainment(request)).kind, "contained");
    await assert.rejects(owner.custody.start(start));
    await raw.reservation(custodyRef).workspace.close();
  });
}
