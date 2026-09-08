import assert from "node:assert/strict";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { after, test as nodeTest } from "node:test";
import { closeSync, observationFault } from "./host-custody-root-observation-fakes.ts";
import { observation, reset } from "./host-custody-post-creation-fixture.ts";
import { HostStdoutIngress } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-stdio.js";

// Observe the actual native guardian; do not substitute launch or its handles.
const hook = registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs" && context.parentURL?.endsWith("/host-custody-private-root.js")) {
    return {url: new URL("./host-custody-root-observation-fakes.ts", import.meta.url).href, shortCircuit: true};
  }
  if (context.parentURL?.endsWith("/node-provider-process-custody-launch.js") &&
      specifier.endsWith("/host-custody-stable-guardian.js")) {
    return {url: new URL("./host-custody-post-creation-fixture.ts", import.meta.url).href, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}});
after(() => hook.deregister());
const { claudeBinding, createCustody, disposableRoot, childrenToStop, syntheticResidueAuthorityFactory } = await import("../../host-custody-test-fixture.ts");
const test = process.platform === "linux" ? nodeTest : nodeTest.skip;

for (const spawnMode of ["eager", undefined, "sdk-delegated"] as const) {
  test(`post-creation stream failure preserves live guardian custody (${spawnMode ?? "omitted"})`, async () => {
    reset();
    observationFault.reset();
    const workspaceRef = await disposableRoot();
    // Hold the native guardian's ready handshake so launch refusal cannot race
    // its own asynchronous shutdown against the live-custody assertions.
    const attachment = Promise.withResolvers<boolean>();
    const reserved = await createCustody({binding: claudeBinding, workspaceRef,
      ...(spawnMode === undefined ? {} : {spawnMode}), script: "setInterval(() => {}, 1000)",
      options: {residueAuthorityFactory: {async create() {
        const authority = await syntheticResidueAuthorityFactory.create();
        return {...authority, async attachGuardian(pid: number) {
          await authority.attachGuardian(pid);
          return attachment.promise;
        }};
      }}},
    });
    const request = {attemptId: `attempt:post-creation-${spawnMode}`, operationId: `operation:post-creation-${spawnMode}`,
      providerBinding: claudeBinding, workspaceRef, intentMode: "analysis" as const};
    const root = dirname(reserved.environment.HOME!);
    const originalAttach = HostStdoutIngress.prototype.attach;
    let injected = false;
    HostStdoutIngress.prototype.attach = function () {
      assert.ok(observation.guardian?.child.pid);
      process.kill(observation.guardian.child.pid, 0);
      injected = true;
      throw new Error("TEST post-native-creation stream attachment failure");
    };
    try {
      if (spawnMode === "sdk-delegated") {
        const opened = await reserved.custody.open(request);
        assert.throws(() => reserved.custody.start(opened.custodyRef, {
          arguments: reserved.arguments, command: reserved.executablePath, cwd: "/proc/self/fd/4",
          environment: reserved.environment, signal: new AbortController().signal,
        }), {name: "HostCustodyLaunchRejectedError"});
      } else {
        await assert.rejects(reserved.custody.open(request));
      }
      assert.equal(injected, true);
      assert.ok(observation.guardian?.child.pid);
      for (let retry = 0; retry < 2; retry += 1) {
        const containment = await reserved.custody.requestContainment(request);
        const release = await reserved.custody.release({...request,
          receiptRef: containment.kind === "contained" ? containment.receiptRef : "receipt:unproven-test"});
        const rootPreserved = await access(root).then(() => true, () => false);
        assert.equal(observation.guardian.child.exitCode, null);
        assert.equal(observation.guardian.child.signalCode, null);
        process.kill(observation.guardian.child.pid, 0);
        const stat = await readFile(`/proc/${observation.guardian.child.pid}/stat`, "utf8");
        assert.ok(!["X", "Z"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)));
        assert.deepEqual({containment: containment.kind, release: release.kind, rootPreserved},
          {containment: "unproven", release: "unproven", rootPreserved: true});
      }
    } finally {
      HostStdoutIngress.prototype.attach = originalAttach;
      attachment.resolve(false);
      if (observation.guardian !== undefined) {
        const guardian = observation.guardian;
        const running = guardian.child.exitCode === null && guardian.child.signalCode === null;
        const closed = running ? once(guardian.child, "close", {signal: AbortSignal.timeout(5_000)}) : Promise.resolve();
        if (running && guardian.child.pid !== undefined) {
          // Only this test's detached native guardian group is owned here.
          try {process.kill(-guardian.child.pid, "SIGKILL");} catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
          }
        }
        await closed;
        await guardian.guardianExit;
        guardian.descriptors.close();
        if (guardian.child.pid !== undefined) {childrenToStop.delete(guardian.child.pid);}
      }
      // Reconciliation authority is retained by production; teardown owns its disposal.
      for (const descriptor of observationFault.opened) {closeSync(descriptor);}
      assert.equal(observationFault.opened.size, 0);
    }
  });
}
