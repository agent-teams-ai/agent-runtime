import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, pipeline, Writable } from "node:stream";
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
import {
  binding,
  claudeBinding,
  collect,
  createCustody,
  disposableRoot,
  nextText,
  sha256,
  waitForEvidence,
} from "../../host-custody-test-fixture.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;

class HeldWriteSink extends Writable {
  #heldCallback: ((error?: Error | null) => void) | undefined;
  #observeHeld: (() => void) | undefined;
  public readonly held = new Promise<void>(resolve => {this.#observeHeld = resolve;});

  public constructor() {super({ highWaterMark: 1 });}

  public override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#heldCallback = callback;
    this.#observeHeld?.();
  }

  public release(): void {
    const callback = this.#heldCallback;
    this.#heldCallback = undefined;
    callback?.();
  }
}

const completedIngress = async () => {
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  const stdout = new HostStdoutIngress(64, 1_024, () => {assert.fail("stdout must remain bounded");});
  const stderr = new HostStderrIngress(1_024, 1_024, () => {assert.fail("stderr must remain bounded");});
  stdout.attach(stdoutSource, Promise.resolve("complete"));
  stderr.attach(stderrSource, Promise.resolve("complete"));
  stdoutSource.end();
  stderrSource.end();
  await Promise.all([stdout.done, stderr.done]);
  return { stderr, stdout };
};

const finalityFailureLive = async (identity: string, killAll: () => Promise<boolean>,
  proveEmpty: () => Promise<"empty" | "residue" | "unproven">,
  guardianExit?: Promise<{ readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }>,
) => {
  const ingress = await completedIngress();
  const observedGuardianExit = Object.freeze({ code: null, signal: "SIGKILL" as const, status: "observed" as const });
  const providerExit = Object.freeze({ code: 0, signal: null });
  return {
    attemptId: `attempt:${identity}`,
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: performance.now() + 1_000,
    custodyRef: `custody:${identity}`,
    evidenceSealed: false,
    exit: Promise.resolve(providerExit),
    fingerprint: { fingerprintSha256: `fingerprint:${identity}` },
    guardian: {
      guardianExit: guardianExit ?? Promise.resolve(observedGuardianExit),
      guardianExitObservation: guardianExit === undefined ? observedGuardianExit : undefined,
      providerExit,
      async signalGroup() {return "sent" as const;},
      async signalProvider() {return "unproven" as const;},
    } as never,
    identity: { status: "proved" },
    opening: Promise.resolve(),
    operationId: `operation:${identity}`,
    privateRootClosure: { identitySha256: `private-root:${identity}`, status: "active" as const },
    residueAuthority: {
      async attachGuardian() {return true;},
      async close() {return true;},
      killAll,
      proveEmpty,
    },
    sealed: true,
    signalAuthorized: false,
    spawnStatus: "acknowledged" as const,
    ...ingress,
  };
};

const finalityOptions = (forceKillAfterMs = 100) => ({ containmentAfterMs: 1_000, drainAfterMs: 100,
  forceKillAfterMs, hostLifecycleGenerationSha256: "host-generation:finality-failure",
  monotonicNow: () => performance.now(), terminateAfterMs: 100 });

linuxTest("containment before guardian dispatch proves empty streams without raw EOF inference", async () => {
  const workspaceRef = await disposableRoot();
  const deferred = await createCustody({ binding: claudeBinding, spawnMode: "sdk-delegated", workspaceRef });
  const request = {
    attemptId: "attempt:guardian-never-dispatched",
    operationId: "operation:guardian-never-dispatched",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await deferred.custody.open(request);
  deferred.custody.start(opened.custodyRef, {
    arguments: deferred.arguments,
    command: deferred.executablePath,
    cwd: "/proc/self/fd/4",
    environment: deferred.environment,
    signal: new AbortController().signal,
  });

  const outcome = await deferred.custody.requestContainment({ ...request, custodyRef: opened.custodyRef });

  assert.equal(outcome.kind, "contained", JSON.stringify(outcome));
  assert.equal(deferred.custody.evidence(opened.custodyRef)?.spawn, "error-before-start");
  assert.equal(deferred.custody.evidence(opened.custodyRef)?.stdout.status, "complete");
  assert.equal(deferred.custody.evidence(opened.custodyRef)?.stderr.status, "complete");
  assert.equal(deferred.custody.evidence(opened.custodyRef)?.sealed, true);
});

test("containment releases unconsumed stdout backpressure before guarded finality", async () => {
  const output = Buffer.alloc(65_536, 97);
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  let settleStdoutFinal: ((status: "complete") => void) | undefined;
  const stdoutFinal = new Promise<"complete">(resolve => {settleStdoutFinal = resolve;});
  const stdout = new HostStdoutIngress(64, output.byteLength, () => {assert.fail("stdout must remain bounded");});
  const stderr = new HostStderrIngress(1_024, 1_024, () => {assert.fail("stderr must remain bounded");});
  stdout.attach(stdoutSource, stdoutFinal);
  stderr.attach(stderrSource, Promise.resolve("complete"));
  stdoutSource.end(output);
  stderrSource.end();
  await stderr.done;
  assert.equal(stdoutSource.isPaused(), true);
  assert.equal(stdout.settled, false);

  const providerExit = Object.freeze({ code: null, signal: "SIGTERM" as const });
  const guardianExit = Object.freeze({ code: null, signal: "SIGKILL" as const, status: "observed" as const });
  const live = {
    attemptId: "attempt:guardian-closure-backpressure",
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: performance.now() + 1_000,
    custodyRef: "custody:guardian-closure-backpressure",
    evidenceSealed: false,
    exit: Promise.resolve(providerExit),
    fingerprint: { fingerprintSha256: "fingerprint:guardian-closure-backpressure" },
    guardian: {
      guardianExit: Promise.resolve(guardianExit),
      guardianExitObservation: guardianExit,
      providerExit,
      async signalGroup() {
        assert.equal(stdoutSource.isPaused() && !stdoutSource.readableEnded, false);
        settleStdoutFinal?.("complete");
        return "sent" as const;
      },
      async signalProvider() {return "unproven" as const;},
    } as never,
    identity: { status: "proved" },
    opening: Promise.resolve(),
    operationId: "operation:guardian-closure-backpressure",
    privateRootClosure: { identitySha256: "private-root:guardian-closure-backpressure", status: "active" as const },
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
    drainAfterMs: 100,
    forceKillAfterMs: 100,
    hostLifecycleGenerationSha256: "host-generation:guardian-closure-backpressure",
    monotonicNow: () => performance.now(),
    terminateAfterMs: 100,
  });

  assert.equal(outcome.kind, "contained", JSON.stringify(outcome));
  assert.equal((await collect(stdout)).byteLength, output.byteLength);
  assert.deepEqual(stdout.snapshot(), {
    bytes: output.byteLength,
    sha256: sha256(output),
    status: "complete",
  });
});

test("provider exit preserves delayed stream truth before the final residue sweep", async () => {
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  let settleStdoutFinal: ((status: "complete") => void) | undefined;
  let settleStderrFinal: ((status: "complete") => void) | undefined;
  let settleProviderExit: ((exit: { readonly code: number; readonly signal: null }) => void) | undefined;
  let settleGuardianExit: ((exit: { readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }) => void) | undefined;
  let observeProviderSignal: (() => void) | undefined;
  const providerSignal = new Promise<void>(resolve => {observeProviderSignal = resolve;});
  const stdout = new HostStdoutIngress(64, 1_024, () => {assert.fail("stdout must remain bounded");});
  const stderr = new HostStderrIngress(1_024, 1_024, () => {assert.fail("stderr must remain bounded");});
  stdout.attach(stdoutSource, new Promise<"complete">(resolve => {settleStdoutFinal = resolve;}));
  stderr.attach(stderrSource, new Promise<"complete">(resolve => {settleStderrFinal = resolve;}));
  stdoutSource.end("delayed-stream-truth");
  stderrSource.end();
  const providerExit = new Promise<{ readonly code: number; readonly signal: null }>(resolve => {settleProviderExit = resolve;});
  const guardianExit = new Promise<{ readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }>(
    resolve => {settleGuardianExit = resolve;},
  );
  const order: string[] = [];
  let killCalls = 0;
  let proveCalls = 0;
  const live = {
    attemptId: "attempt:delayed-stream-final-before-residue-kill",
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: performance.now() + 1_000,
    custodyRef: "custody:delayed-stream-final-before-residue-kill",
    evidenceSealed: false,
    exit: providerExit,
    fingerprint: { fingerprintSha256: "fingerprint:delayed-stream-final-before-residue-kill" },
    guardian: {
      guardianExit,
      guardianExitObservation: undefined,
      providerExit: undefined,
      async signalGroup() {
        order.push("provider-exit");
        settleProviderExit?.({ code: 0, signal: null });
        observeProviderSignal?.();
        return "sent" as const;
      },
      async signalProvider() {return "unproven" as const;},
    } as never,
    identity: { status: "proved" },
    opening: Promise.resolve(),
    operationId: "operation:delayed-stream-final-before-residue-kill",
    privateRootClosure: { identitySha256: "private-root:delayed-stream-final-before-residue-kill", status: "active" as const },
    residueAuthority: {
      async attachGuardian() {return true;},
      async close() {return true;},
      async killAll() {
        killCalls += 1;
        order.push("kill-all");
        assert.equal(stdout.settled, true);
        assert.equal(stderr.settled, true);
        settleGuardianExit?.({ code: null, signal: "SIGKILL", status: "observed" });
        return true;
      },
      async proveEmpty() {proveCalls += 1; order.push("prove-empty"); return "empty" as const;},
    },
    sealed: true,
    signalAuthorized: false,
    spawnStatus: "acknowledged" as const,
    stderr,
    stdout,
  };
  const request = {attemptId: live.attemptId, custodyRef: live.custodyRef, operationId: live.operationId};
  const outcomePromise = containCustody(live, request, {
    containmentAfterMs: 1_000,
    drainAfterMs: 100,
    forceKillAfterMs: 100,
    hostLifecycleGenerationSha256: "host-generation:delayed-stream-final-before-residue-kill",
    monotonicNow: () => performance.now(),
    terminateAfterMs: 100,
  });

  await providerSignal;
  await new Promise(resolve => {setImmediate(resolve);});
  assert.equal(killCalls, 0);
  order.push("stream-final");
  settleStdoutFinal?.("complete");
  settleStderrFinal?.("complete");
  const outcome = await outcomePromise;

  assert.equal(outcome.kind, "contained", JSON.stringify(outcome));
  assert.equal(killCalls, 1);
  assert.equal(proveCalls, 1);
  assert.deepEqual(order, ["provider-exit", "stream-final", "kill-all", "prove-empty"]);
  assert.equal(stdout.snapshot().status, "complete");
  assert.equal(stderr.snapshot().status, "complete");
});

test("synchronous cgroup kill failure remains unproven and does not skip the final proof", async () => {
  let killCalls = 0;
  let proveCalls = 0;
  const live = await finalityFailureLive(
    "synchronous-kill-failure",
    () => {killCalls += 1; throw new Error("synchronous kill failure");},
    async () => {proveCalls += 1; return "empty";},
  );

  const outcome = await containCustody(live, live, finalityOptions());
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /operation-cgroup-kill-unproven/u);
  assert.deepEqual([killCalls, proveCalls, live.evidenceSealed], [1, 1, false]);
});

test("asynchronous cgroup kill rejection is observed and does not skip the final proof", async () => {
  let killCalls = 0;
  let proveCalls = 0;
  const live = await finalityFailureLive(
    "asynchronous-kill-failure",
    () => {killCalls += 1; return Promise.reject(new Error("asynchronous kill failure"));},
    async () => {proveCalls += 1; return "empty";},
  );

  const outcome = await containCustody(live, live, finalityOptions());
  await new Promise(resolve => {setImmediate(resolve);});
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /operation-cgroup-kill-unproven/u);
  assert.deepEqual([killCalls, proveCalls, live.evidenceSealed], [1, 1, false]);
});

test("cgroup kill phase timeout survives later guardian exit and an empty final proof", async () => {
  let settleGuardianExit: ((exit: { readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }) => void) | undefined;
  const guardianExit = new Promise<{ readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }>(
    resolve => {settleGuardianExit = resolve;},
  );
  let killCalls = 0;
  let proveCalls = 0;
  const live = await finalityFailureLive(
    "kill-timeout-then-empty",
    () => {
      killCalls += 1;
      setTimeout(() => {settleGuardianExit?.({ code: null, signal: "SIGKILL", status: "observed" });}, 10);
      return new Promise<boolean>(() => {});
    },
    async () => {proveCalls += 1; return "empty";},
    guardianExit,
  );

  const outcome = await containCustody(live, live, finalityOptions(5));
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /operation-cgroup-kill-unproven/u);
  assert.deepEqual([killCalls, proveCalls, live.evidenceSealed], [1, 1, false]);
});

test("owner deadline exhaustion remains authoritative after the mandatory failed-kill sweep", async () => {
  let monotonicNow = 0;
  let killCalls = 0;
  let proveCalls = 0;
  const live = await finalityFailureLive(
    "failed-kill-owner-deadline",
    () => {killCalls += 1; throw new Error("synchronous kill failure");},
    async () => {proveCalls += 1; monotonicNow = 101; return "empty";},
  );
  live.containmentDeadline = 100;

  const outcome = await containCustody(live, live, {
    ...finalityOptions(),
    monotonicNow: () => monotonicNow,
  });
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /owner-deadline-exceeded/u);
  assert.deepEqual([killCalls, proveCalls, live.evidenceSealed], [1, 1, false]);
});

test("synchronous and asynchronous empty-proof failures remain observed and unproven", async t => {
  for (const [identity, proveEmpty] of [
    ["synchronous-proof-failure", () => {throw new Error("synchronous proof failure");}],
    ["asynchronous-proof-failure", () => Promise.reject(new Error("asynchronous proof failure"))],
  ] as const) {
    await t.test(identity, async () => {
      let killCalls = 0;
      let proveCalls = 0;
      const live = await finalityFailureLive(
        identity,
        async () => {killCalls += 1; return true;},
        () => {proveCalls += 1; return proveEmpty();},
      );

      const outcome = await containCustody(live, live, finalityOptions());
      await new Promise(resolve => {setImmediate(resolve);});
      assert.equal(outcome.kind, "unproven");
      assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /operation-residue-unproven/u);
      assert.deepEqual([killCalls, proveCalls, live.evidenceSealed], [1, 1, false]);
    });
  }
});

test("escaped residue stays fail closed after preserved stream finality", async () => {
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  const stdout = new HostStdoutIngress(64, 1_024, () => {assert.fail("stdout must remain bounded");});
  const stderr = new HostStderrIngress(1_024, 1_024, () => {assert.fail("stderr must remain bounded");});
  stdout.attach(stdoutSource, Promise.resolve("complete"));
  stderr.attach(stderrSource, Promise.resolve("complete"));
  stdoutSource.end("complete-before-residue-proof");
  stderrSource.end();
  await Promise.all([stdout.done, stderr.done]);
  let settleGuardianExit: ((exit: { readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }) => void) | undefined;
  const guardianExit = new Promise<{ readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }>(
    resolve => {settleGuardianExit = resolve;},
  );
  let killCalls = 0;
  let proveCalls = 0;
  const providerExit = Object.freeze({ code: 0, signal: null });
  const live = {
    attemptId: "attempt:escaped-residue-after-stream-final",
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: performance.now() + 1_000,
    custodyRef: "custody:escaped-residue-after-stream-final",
    evidenceSealed: false,
    exit: Promise.resolve(providerExit),
    fingerprint: { fingerprintSha256: "fingerprint:escaped-residue-after-stream-final" },
    guardian: {
      guardianExit,
      guardianExitObservation: undefined,
      providerExit,
      async signalGroup() {return "sent" as const;},
      async signalProvider() {return "unproven" as const;},
    } as never,
    identity: { status: "proved" },
    opening: Promise.resolve(),
    operationId: "operation:escaped-residue-after-stream-final",
    privateRootClosure: { identitySha256: "private-root:escaped-residue-after-stream-final", status: "active" as const },
    residueAuthority: {
      async attachGuardian() {return true;},
      async close() {return true;},
      async killAll() {
        killCalls += 1;
        settleGuardianExit?.({ code: null, signal: "SIGKILL", status: "observed" });
        return true;
      },
      async proveEmpty() {proveCalls += 1; return "residue" as const;},
    },
    sealed: true,
    signalAuthorized: false,
    spawnStatus: "acknowledged" as const,
    stderr,
    stdout,
  };

  const outcome = await containCustody(live, {
    attemptId: live.attemptId,
    custodyRef: live.custodyRef,
    operationId: live.operationId,
  }, {
    containmentAfterMs: 1_000,
    drainAfterMs: 100,
    forceKillAfterMs: 100,
    hostLifecycleGenerationSha256: "host-generation:escaped-residue-after-stream-final",
    monotonicNow: () => performance.now(),
    terminateAfterMs: 100,
  });

  assert.equal(killCalls, 1);
  assert.equal(proveCalls, 1);
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /operation-residue-remains/u);
});

test("a never-final stream remains unproven at the configured drain bound", async () => {
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  const neverFinal = new Promise<"complete">(() => {});
  const stdout = new HostStdoutIngress(64, 1_024, () => {assert.fail("stdout must remain bounded");});
  const stderr = new HostStderrIngress(1_024, 1_024, () => {assert.fail("stderr must remain bounded");});
  stdout.attach(stdoutSource, neverFinal);
  stderr.attach(stderrSource, neverFinal);
  stdoutSource.end("transport-eof-is-not-stream-final");
  stderrSource.end();
  let settleGuardianExit: ((exit: { readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }) => void) | undefined;
  const guardianExit = new Promise<{ readonly code: null; readonly signal: "SIGKILL"; readonly status: "observed" }>(
    resolve => {settleGuardianExit = resolve;},
  );
  let killCalls = 0;
  let proveCalls = 0;
  const providerExit = Object.freeze({ code: 0, signal: null });
  const live = {
    attemptId: "attempt:never-final-stream-bound",
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: performance.now() + 1_000,
    custodyRef: "custody:never-final-stream-bound",
    evidenceSealed: false,
    exit: Promise.resolve(providerExit),
    fingerprint: { fingerprintSha256: "fingerprint:never-final-stream-bound" },
    guardian: {
      guardianExit,
      guardianExitObservation: undefined,
      providerExit,
      async signalGroup() {return "sent" as const;},
      async signalProvider() {return "unproven" as const;},
    } as never,
    identity: { status: "proved" },
    opening: Promise.resolve(),
    operationId: "operation:never-final-stream-bound",
    privateRootClosure: { identitySha256: "private-root:never-final-stream-bound", status: "active" as const },
    residueAuthority: {
      async attachGuardian() {return true;},
      async close() {return true;},
      async killAll() {
        killCalls += 1;
        settleGuardianExit?.({ code: null, signal: "SIGKILL", status: "observed" });
        return true;
      },
      async proveEmpty() {proveCalls += 1; return "empty" as const;},
    },
    sealed: true,
    signalAuthorized: false,
    spawnStatus: "acknowledged" as const,
    stderr,
    stdout,
  };
  const started = performance.now();
  const outcome = await containCustody(live, {
    attemptId: live.attemptId,
    custodyRef: live.custodyRef,
    operationId: live.operationId,
  }, {
    containmentAfterMs: 1_000,
    drainAfterMs: 20,
    forceKillAfterMs: 20,
    hostLifecycleGenerationSha256: "host-generation:never-final-stream-bound",
    monotonicNow: () => performance.now(),
    terminateAfterMs: 20,
  });

  assert.equal(killCalls, 1);
  assert.equal(proveCalls, 1);
  assert.ok(performance.now() - started < 500);
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /ingress-incomplete/u);
  assert.equal(stdout.snapshot().status, "incomplete");
  assert.equal(stderr.snapshot().status, "incomplete");
});

linuxTest("real guardian containment drains an actually backpressured stdout path", { timeout: 30_000 }, async () => {
  const workspaceRef = await disposableRoot();
  const outputBytes = 1_048_576;
  const { custody } = await createCustody({
    options: {
      containmentAfterMs: 15_000,
      drainAfterMs: 5_000,
      forceKillAfterMs: 2_000,
      identityObservationAfterMs: 15_000,
      maxStdoutBytes: outputBytes,
      spawnAcknowledgementAfterMs: 15_000,
      stdoutHighWaterBytes: 64,
      terminateAfterMs: 2_000,
    },
    script: `process.stdout.write(Buffer.alloc(${outputBytes}, 97)); setInterval(() => {}, 1000);`,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:real-guardian-closure-backpressure",
    operationId: "operation:real-guardian-closure-backpressure",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  await waitForEvidence(
    custody,
    opened.custodyRef,
    evidence => evidence.stdout.bytes > 0 && evidence.stdout.bytes < outputBytes,
  );
  const before = custody.evidence(opened.custodyRef)?.stdout.bytes ?? 0;

  const outcome = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  const evidence = custody.evidence(opened.custodyRef);

  assert.equal(outcome.kind, "contained", JSON.stringify(outcome));
  assert.ok(before > 0 && before < outputBytes);
  assert.ok((evidence?.stdout.bytes ?? 0) >= before);
  assert.ok((evidence?.stdout.bytes ?? outputBytes + 1) <= outputBytes);
  assert.equal(evidence?.stdout.status, "complete");
  assert.equal(evidence?.sealed, true);
});

test("raw EOF waits for guarded stream truth and preserves a reported stream error", async () => {
  let settleStdout: ((status: "complete" | "error" | "incomplete") => void) | undefined;
  let settleStderr: ((status: "complete" | "error" | "incomplete") => void) | undefined;
  const stdoutFinal = new Promise<"complete" | "error" | "incomplete">(resolve => {settleStdout = resolve;});
  const stderrFinal = new Promise<"complete" | "error" | "incomplete">(resolve => {settleStderr = resolve;});
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  const stdout = new HostStdoutIngress(64, 1_024, () => {assert.fail("stdout must remain bounded");});
  const stderr = new HostStderrIngress(1_024, 1_024, () => {assert.fail("stderr must remain bounded");});
  stdout.attach(stdoutSource, stdoutFinal);
  stderr.attach(stderrSource, stderrFinal);
  const output = collect(stdout);
  const stdoutEnded = once(stdoutSource, "end");
  const stderrEnded = once(stderrSource, "end");
  stdoutSource.end("partial-output");
  stderrSource.end("bounded-diagnostic");
  await Promise.all([stdoutEnded, stderrEnded]);

  assert.equal(stdout.settled, false);
  assert.equal(stderr.settled, false);
  assert.equal(stdout.snapshot().status, "incomplete");
  assert.equal(stderr.snapshot().status, "incomplete");

  settleStdout?.("error");
  settleStderr?.("complete");
  await Promise.all([stdout.done, stderr.done]);

  assert.equal((await output).toString("utf8"), "partial-output");
  assert.deepEqual(stdout.snapshot(), {
    bytes: Buffer.byteLength("partial-output"),
    sha256: sha256(Buffer.from("partial-output")),
    status: "error",
  });
  assert.deepEqual(stderr.snapshot(), {
    bytes: Buffer.byteLength("bounded-diagnostic"),
    sha256: sha256(Buffer.from("bounded-diagnostic")),
    status: "complete",
  });
});

test("raw EOF cannot settle while an actual writable callback remains held", async () => {
  const providerSource = new PassThrough();
  const transportSource = new PassThrough();
  const heldSink = new HeldWriteSink();
  let pipelineSettled = false;
  const providerFinal = new Promise<"complete" | "error">(resolve => {
    pipeline(providerSource, heldSink, error => {
      pipelineSettled = true;
      resolve(error === undefined ? "complete" : "error");
    });
  });
  const stdout = new HostStdoutIngress(64, 1_024, () => {assert.fail("stdout must remain bounded");});
  stdout.attach(transportSource, providerFinal);
  const output = collect(stdout);
  const providerEnded = once(providerSource, "end");
  const transportEnded = once(transportSource, "end");

  providerSource.end("held-terminal-bytes");
  transportSource.end("held-terminal-bytes");
  await Promise.all([providerEnded, transportEnded, heldSink.held]);

  assert.equal(pipelineSettled, false);
  assert.equal(stdout.settled, false);
  assert.equal(stdout.snapshot().status, "incomplete");

  heldSink.release();
  await stdout.done;
  assert.equal(pipelineSettled, true);
  assert.equal((await output).toString("utf8"), "held-terminal-bytes");
  assert.equal(stdout.snapshot().status, "complete");
});

test("an await that consumes the owner deadline cannot mint a containment receipt", async () => {
  let monotonicNow = 0;
  let closeCalls = 0;
  const live = {
    attemptId: "attempt:absolute-deadline",
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: 1,
    custodyRef: "custody:absolute-deadline",
    evidenceSealed: false,
    fingerprint: { fingerprintSha256: "fingerprint:absolute-deadline" },
    identity: { status: "not-started" },
    opening: Promise.resolve(),
    operationId: "operation:absolute-deadline",
    privateRootClosure: { identitySha256: "private-root:absolute-deadline", status: "active" },
    residueAuthority: {
      async attachGuardian() {return true;},
      async close() {closeCalls += 1; monotonicNow = 2; return true;},
      async killAll() {return true;},
      async proveEmpty() {return "empty" as const;},
    },
    sealed: true,
    signalAuthorized: false,
    spawnStatus: "never-started",
  };
  const input = {
    attemptId: live.attemptId,
    custodyRef: live.custodyRef,
    operationId: live.operationId,
  };

  const outcome = await containCustody(live, input, {
    containmentAfterMs: 1,
    drainAfterMs: 1,
    forceKillAfterMs: 1,
    hostLifecycleGenerationSha256: "host-generation:absolute-deadline",
    monotonicNow: () => monotonicNow,
    terminateAfterMs: 1,
  });

  assert.equal(closeCalls, 1);
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /owner-deadline-exceeded/u);
  assert.equal(live.evidenceSealed, false);
  assert.equal("contained" in live, false);
});

test("unproven guardian TERM dispatch still escalates provider and cgroup termination", async () => {
  let providerKillCalls = 0;
  let residueKillCalls = 0;
  const neverExits = new Promise<never>(() => {});
  const live = {
    attemptId: "attempt:guardian-term-unproven",
    closureEvidence: strictClosure("unproven"),
    containmentDeadline: 100,
    custodyRef: "custody:guardian-term-unproven",
    evidenceSealed: false,
    exit: neverExits,
    fingerprint: { fingerprintSha256: "fingerprint:guardian-term-unproven" },
    guardian: {
      guardianExit: neverExits,
      guardianExitObservation: undefined,
      providerExit: undefined,
      async signalGroup() {return "unproven" as const;},
      async signalProvider() {providerKillCalls += 1; return "sent" as const;},
    } as never,
    identity: { status: "ambiguous" },
    opening: Promise.resolve(),
    operationId: "operation:guardian-term-unproven",
    privateRootClosure: { identitySha256: "private-root:guardian-term-unproven", status: "active" },
    residueAuthority: {
      async attachGuardian() {return true;},
      async close() {return true;},
      async killAll() {residueKillCalls += 1; return true;},
      async proveEmpty() {return "unproven" as const;},
    },
    sealed: true,
    signalAuthorized: false,
    spawnStatus: "acknowledged" as const,
  };
  const input = {
    attemptId: live.attemptId,
    custodyRef: live.custodyRef,
    operationId: live.operationId,
  };

  const outcome = await containCustody(live, input, {
    containmentAfterMs: 100,
    drainAfterMs: 5,
    forceKillAfterMs: 5,
    hostLifecycleGenerationSha256: "host-generation:guardian-term-unproven",
    monotonicNow: () => 0,
    terminateAfterMs: 5,
  });

  assert.equal(providerKillCalls, 1);
  assert.equal(residueKillCalls, 1);
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /stable-guardian-exit-unproven/u);
  assert.equal(live.closureEvidence.status, "unproven");
  assert.equal(live.evidenceSealed, false);
});

linuxTest("guardian EOF without guarded stream finality keeps output drain unproven", async () => {
  const workspaceRef = await disposableRoot();
  const script = String.raw`
process.stdout.write("unacknowledged-terminal-bytes\n");
process.stdin.once("data", () => process.kill(process.ppid, "SIGKILL"));
setInterval(() => {}, 1000);
`;
  const { custody } = await createCustody({ script, workspaceRef });
  const request = {
    attemptId: "attempt:guardian-eof-without-stream-final",
    operationId: "operation:guardian-eof-without-stream-final",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  assert.equal(await nextText(processHandle.stdout), "unacknowledged-terminal-bytes\n");
  await processHandle.write(Buffer.from("lose-guardian"));
  await waitForEvidence(custody, opened.custodyRef, evidence => evidence.guardianExit.status === "observed");

  const outcome = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  const evidence = custody.evidence(opened.custodyRef);
  assert.equal(outcome.kind, "unproven", JSON.stringify(outcome));
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /ingress-incomplete/u);
  assert.deepEqual(evidence?.guardianExit, { code: null, signal: "SIGKILL", status: "observed" });
  assert.deepEqual(evidence?.providerExit, { status: "unobserved" });
  assert.equal(evidence?.stdout.status, "incomplete");
  assert.equal(evidence?.stderr.status, "incomplete");
  assert.equal(evidence?.sealed, false);
});

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
