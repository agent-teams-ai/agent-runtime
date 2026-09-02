import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  HostStderrIngress,
  HostStdoutIngress,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-stdio.js";
import {
  containCustody,
  snapshotEvidence,
  strictClosure,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-evidence.js";
import { collect } from "../../host-custody-test-fixture.ts";

test("guardian loss remains distinct from provider exit when residue closure proves containment", async () => {
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  const stdout = new HostStdoutIngress(64, 1_024, () => {assert.fail("stdout must remain bounded");});
  const stderr = new HostStderrIngress(1_024, 1_024, () => {assert.fail("stderr must remain bounded");});
  stdout.attach(stdoutSource, Promise.resolve("complete"));
  stderr.attach(stderrSource, Promise.resolve("complete"));
  const output = collect(stdout);
  stdoutSource.end("provider-streams-complete");
  stderrSource.end();
  await Promise.all([stdout.done, stderr.done]);
  assert.equal((await output).toString("utf8"), "provider-streams-complete");

  const guardianExit = Object.freeze({ code: null, signal: "SIGHUP" as const, status: "observed" as const });
  const neverObservesProviderExit = new Promise<never>(() => {});
  const live = {
    attemptId: "attempt:guardian-exit-distinct",
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: performance.now() + 1_000,
    custodyRef: "custody:guardian-exit-distinct",
    evidenceSealed: false,
    exit: neverObservesProviderExit,
    fingerprint: { fingerprintSha256: "fingerprint:guardian-exit-distinct" },
    guardian: {
      guardianExit: Promise.resolve(guardianExit),
      guardianExitObservation: guardianExit,
      providerExit: undefined,
      async signalGroup() {return "unproven" as const;},
      async signalProvider() {return "unproven" as const;},
    } as never,
    identity: { status: "proved" },
    opening: Promise.resolve(),
    operationId: "operation:guardian-exit-distinct",
    privateRootClosure: { identitySha256: "private-root:guardian-exit-distinct", status: "active" as const },
    residueAuthority: {
      async attachGuardian() {return true;},
      async close() {return true;},
      async killAll() {return true;},
      async proveEmpty() {return "empty" as const;},
    },
    sealed: true,
    signalAuthorized: false,
    spawnStatus: "acknowledged" as const,
    stderr,
    stdout,
  };
  const request = {attemptId: live.attemptId, custodyRef: live.custodyRef, operationId: live.operationId};

  const outcome = await containCustody(live, request, {
    containmentAfterMs: 1_000,
    drainAfterMs: 10,
    forceKillAfterMs: 10,
    hostLifecycleGenerationSha256: "host-generation:guardian-exit-distinct",
    monotonicNow: () => performance.now(),
    terminateAfterMs: 10,
  });
  const evidence = snapshotEvidence(live);

  assert.equal(outcome.kind, "contained", JSON.stringify(outcome));
  assert.deepEqual(evidence.guardianExit, { code: null, signal: "SIGHUP", status: "observed" });
  assert.deepEqual(evidence.providerExit, { status: "unobserved" });
  assert.equal(evidence.stdout.status, "complete");
  assert.equal(evidence.stderr.status, "complete");
  assert.equal(evidence.sealed, true);
});
