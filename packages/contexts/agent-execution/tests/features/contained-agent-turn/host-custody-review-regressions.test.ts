import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { observationFault } from "./host-custody-root-observation-fakes.ts";

const hook = registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs" && context.parentURL?.endsWith("/host-custody-private-root.js")) {
    return {url: new URL("./host-custody-root-observation-fakes.ts", import.meta.url).href, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}});
after(() => hook.deregister());
const { binding, createCustody, disposableRoot } = await import("../../host-custody-test-fixture.ts");
const { unsupportedOperationResidueAuthorityFactory } = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-cgroup-v2.js");

for (const mode of ["reused-inode", "known-nonallocation", "unknown-allocation", "retained-child-change"] as const) {
  test(mode, {skip: process.platform !== "linux"}, async () => {
    observationFault.reset();
    const workspaceRef = await disposableRoot();
    let factoryCalls = 0;
    const factory = mode === "known-nonallocation" ? unsupportedOperationResidueAuthorityFactory : {
      async create() {
        factoryCalls++;
        if (mode === "unknown-allocation") {throw new Error("allocation may have occurred");}
        return {async close() {return true;}, async attachGuardian() {return true;},
          async killAll() {return true;}, async proveEmpty() {return "empty" as const;}};
      },
    };
    const fixture = await createCustody({workspaceRef, spawnMode: "sdk-delegated", options: {residueAuthorityFactory: factory}});
    const root = dirname(fixture.environment.HOME);
    const marker = join(root, "replacement-marker");
    writeFileSync(marker, "preserve");
    const input = {attemptId: `TEST:${mode}`, operationId: `TEST:operation:${mode}`, providerBinding: binding, workspaceRef};
    observationFault.changedCtime = mode === "reused-inode";
    if (mode === "retained-child-change") {
      await fixture.custody.open(input);
      const before = lstatSync(root, {bigint: true}).ctimeNs;
      writeFileSync(join(root, "legitimate-child"), "changes ctime after retention");
      assert.notEqual(lstatSync(root, {bigint: true}).ctimeNs, before);
    } else {
      await assert.rejects(fixture.custody.open(input));
    }
    if (mode === "reused-inode") {
      assert.equal(factoryCalls, 0);
      assert.equal(readFileSync(marker, "utf8"), "actual replacement root");
      assert.equal(observationFault.opened.size, 0);
      assert.equal(observationFault.closed, 1);
    }
    const containment = await fixture.custody.requestContainment(input);
    if (mode === "unknown-allocation") {
      assert.equal(containment.kind, "unproven");
      assert.equal((await fixture.custody.requestContainment(input)).kind, "unproven");
      assert.equal(existsSync(marker), true);
      assert.equal(observationFault.opened.size, 1);
      assert.equal(observationFault.closed, 0);
      const release = await fixture.custody.release({...input, receiptRef: "not-a-receipt"});
      assert.equal(release.kind, "unproven");
      assert.equal(existsSync(marker), true);
      // Test teardown alone closes reconciliation-owned authority.
      const {closeSync} = await import("./host-custody-root-observation-fakes.ts");
      for (const descriptor of observationFault.opened) {closeSync(descriptor);}
      return;
    }
    assert.equal(containment.kind, "contained");
    if (containment.kind !== "contained") {throw new Error("missing containment");}
    const releaseInput = {...input, receiptRef: containment.receiptRef};
    const released = await fixture.custody.release(releaseInput);
    if (mode === "reused-inode") {
      assert.equal(released.kind, "unproven");
      assert.equal(existsSync(marker), true);
      assert.equal(observationFault.opened.size, 0);
    } else {
      assert.equal(released.kind, "released");
      assert.deepEqual(await fixture.custody.release(releaseInput), released);
      assert.equal(existsSync(root), false);
      assert.equal(observationFault.opened.size, 0);
      assert.equal(observationFault.closed, 1);
    }
  });
}
