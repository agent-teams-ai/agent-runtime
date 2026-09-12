import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test as nodeTest } from "node:test";

import { refusals, type LaunchRefusalKind } from "./host-custody-launch-refusal-fakes.ts";

// The guarded launch is the only substitution, installed before the core loads.
const hook = registerHooks({resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/host-custody/") &&
      specifier.endsWith("/node-provider-process-custody-launch.js")) {
    return {url: new URL("./host-custody-launch-refusal-fakes.ts", import.meta.url).href, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}});
after(() => hook.deregister());

const { claudeBinding, createCustody, disposableRoot } = await import("../../host-custody-test-fixture.ts");

const test = process.platform === "linux" ? nodeTest : nodeTest.skip;

const refusedStart = async (kind: LaunchRefusalKind, attempt: string, spawnMode?: "eager" | "sdk-delegated") => {
  refusals.reset(kind);
  const workspaceRef = await disposableRoot();
  const reserved = await createCustody({binding: claudeBinding, ...(spawnMode === undefined ? {} : {spawnMode}), workspaceRef});
  const request = {
    attemptId: `attempt:${attempt}`,
    operationId: `operation:${attempt}`,
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const observedSpawnStatus: string[] = [];
  let custodyRef: string | undefined;
  refusals.onLaunch(observation => {
    custodyRef = observation.live.custodyRef;
    observedSpawnStatus.push(observation.live.spawnStatus);
  });
  if (spawnMode === "sdk-delegated") {
    const opened = await reserved.custody.open(request);
    assert.throws(() => reserved.custody.start(opened.custodyRef, {
      arguments: reserved.arguments,
      command: reserved.executablePath,
      cwd: "/proc/self/fd/4",
      environment: reserved.environment,
      signal: new AbortController().signal,
    }), { name: "HostCustodyLaunchRejectedError" });
  } else {await assert.rejects(reserved.custody.open(request));}
  assert.ok(custodyRef);
  assert.equal(refusals.launchCalls(), 1);
  // The admitted-launch mark is still written before the call, never inside it.
  assert.deepEqual(observedSpawnStatus, ["ambiguous"]);
  return {
    ...request,
    closure: await reserved.custody.requestContainment({...request, custodyRef}),
    custody: reserved.custody,
    custodyRef,
  };
};

for (const spawnMode of ["eager", undefined, "sdk-delegated"] as const) {
  test(`a descriptor refusal retracts launch ambiguity (${spawnMode ?? "omitted"})`, async () => {
    const refused = await refusedStart("descriptor-authority", `descriptor-authority-refusal-${spawnMode}`, spawnMode);
    assert.equal(refused.closure.kind, "contained");
    const evidence = refused.custody.evidence(refused.custodyRef)!;
    assert.equal(evidence.spawn, "never-started");
    assert.equal(evidence.closure.status, "not-started");
    assert.equal(evidence.providerExit.status, "not-started");
    assert.equal(evidence.sealed, true);
    // Closure converges: repeating it returns the same proof, never a fresh attempt.
    assert.deepEqual(await refused.custody.requestContainment({
      attemptId: refused.attemptId, custodyRef: refused.custodyRef, operationId: refused.operationId,
    }), refused.closure);
  });

  for (const kind of ["guardian-construction", "unclassified"] as const) {
    test(`a ${kind} refusal keeps ambiguous evidence (${spawnMode ?? "omitted"})`, async () => {
      const refused = await refusedStart(kind, `${kind}-refusal-${spawnMode}`, spawnMode);
      assert.equal(refused.closure.kind, "unproven");
      const evidence = refused.custody.evidence(refused.custodyRef)!;
      assert.equal(evidence.spawn, "ambiguous");
      assert.equal(evidence.closure.status, "unproven");
      assert.notEqual(evidence.providerExit.status, "not-started");
      assert.equal(evidence.sealed, false);
      // Retrying must not promote the unproven closure to a manufactured proof.
      const retried = await refused.custody.requestContainment({
        attemptId: refused.attemptId, custodyRef: refused.custodyRef, operationId: refused.operationId,
      });
      assert.equal(retried.kind, "unproven");
      assert.equal(refused.custody.evidence(refused.custodyRef)?.spawn, "ambiguous");
    });
  }
}
