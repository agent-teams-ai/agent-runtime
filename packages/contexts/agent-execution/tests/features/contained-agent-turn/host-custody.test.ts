import assert from "node:assert/strict";
import { access, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test as nodeTest } from "node:test";

import { NodeProviderProcessCustody as BaseNodeProviderProcessCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
import {
  binding,
  childrenToStop,
  claudeBinding,
  collect,
  createCustody,
  disposableRoot,
  launchPlan,
  nextText,
  qualifiedIdentityObserver,
  sha256,
  syntheticResidueAuthorityFactory,
  waitForEvidence,
  waitForProvedIdentity,
} from "../../host-custody-test-fixture.ts";

const test = process.platform === "linux" ? nodeTest : nodeTest.skip;

class NodeProviderProcessCustody extends BaseNodeProviderProcessCustody {
  public constructor(options: ConstructorParameters<typeof BaseNodeProviderProcessCustody>[0]) {
    super({
      identityObservationAfterMs: 60_000,
      residueAuthorityFactory: syntheticResidueAuthorityFactory,
      spawnAcknowledgementAfterMs: 60_000,
      ...options,
    });
  }

  public override open(input: Parameters<BaseNodeProviderProcessCustody["open"]>[0]) {
    return super.open({ intentMode: "analysis", ...input });
  }
}

test("concurrent open publishes one reservation before one acknowledged spawn", async () => {
  const workspaceRef = await disposableRoot();
  const { custody } = await createCustody({ workspaceRef });
  const request = {
    attemptId: "attempt:concurrent-open",
    operationId: "operation:concurrent-open",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const [left, right, third] = await Promise.all([
    custody.open(request),
    custody.open(request),
    custody.open(request),
  ]);
  assert.deepEqual(left, right);
  assert.deepEqual(right, third);
  assert.ok(custody.get(left.custodyRef));
  const evidence = custody.evidence(left.custodyRef);
  assert.equal(evidence?.spawn, "acknowledged");
  assert.equal(evidence?.identity.status, "proved");
  assert.equal(evidence?.identity.childProcessInstanceSha256.length, 64);
  assert.equal(evidence?.fingerprint.binaryRevision, binding.binaryRevision);
  assert.equal(evidence?.fingerprint.workspaceSha256, sha256(workspaceRef));
  assert.equal(evidence?.fingerprint.containmentProfile, "strict-linux-cgroup-v2");
  assert.equal(evidence?.fingerprint.executablePathSha256, sha256(await realpath(process.execPath)));
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(workspaceRef, "u"));
  assert.equal(evidence?.fingerprint.spawnMode, "eager");
  assert.equal(evidence?.fingerprint.providerBindingSha256.length, 64);
  assert.deepEqual(evidence?.fingerprint.privatePathEnvironmentKeys, ["CODEX_HOME", "HOME", "TMPDIR"]);
  assert.equal(evidence?.fingerprint.privateRootPathSha256.length, 64);
  assert.equal("environmentValueSha256" in (evidence?.fingerprint ?? {}), false);
  assert.equal(evidence?.fingerprint.fingerprintSha256.length, 64);
  const closed = await custody.requestContainment({ ...request, custodyRef: left.custodyRef });
  assert.equal(closed.kind, "contained");
});

test("containment winning during eager open seals the reservation before spawn", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan({ workspaceRef });
  let releasePlan: (() => void) | undefined;
  const planGate = new Promise<void>(resolve => {releasePlan = resolve;});
  const custody = new NodeProviderProcessCustody({
    launchPlans: {async resolve() {await planGate; return entry.plan;}},
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = {
    attemptId: "attempt:containment-during-open",
    operationId: "operation:containment-during-open",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opening = custody.open(request);
  const containment = custody.requestContainment(request);
  releasePlan?.();
  const opened = await opening;
  const outcome = await containment;
  assert.equal(outcome.kind, "contained");
  assert.equal(custody.get(opened.custodyRef), undefined);
  assert.equal(custody.evidence(opened.custodyRef)?.spawn, "never-started");
  assert.equal(custody.evidence(opened.custodyRef)?.closure.status, "not-started");
});
test("same attempt with a different complete launch fingerprint conflicts", async () => {
  const workspaceRef = await disposableRoot();
  let searchPath = "/usr/bin:/bin";
  const resolver = {
    async resolve() {
      return (await launchPlan({ searchPath, workspaceRef })).plan;
    },
  };
  const custody = new NodeProviderProcessCustody({
    launchPlans: resolver,
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = {
    attemptId: "attempt:fingerprint",
    operationId: "operation:fingerprint",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  searchPath = "/bin:/usr/bin";
  await assert.rejects(custody.open(request), { message: /fingerprint conflict/u, name: "HostCustodyFingerprintConflictError" });
  assert.equal(custody.evidence(opened.custodyRef)?.spawn, "acknowledged");
  await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
});
test("wrong executable digest rejects before any provider effect", async () => {
  const workspaceRef = await disposableRoot();
  const marker = join(workspaceRef, "wrong-digest-provider-effect");
  const entry = await launchPlan({
    script: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "effect")`,
    workspaceRef,
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([{
      ...entry,
      plan: Object.freeze({ ...entry.plan, executableSha256: "0".repeat(64) }),
    }]),
  });
  const request = {
    attemptId: "attempt:wrong-executable-digest",
    operationId: "operation:wrong-executable-digest",
    providerBinding: binding,
    workspaceRef,
  } as const;
  await assert.rejects(custody.open(request), { name: "HostCustodyLaunchRejectedError" });
  await assert.rejects(access(marker), { code: "ENOENT" });
});
test("identity failure is contained by the stable guardian before eager open rejects", async () => {
  const workspaceRef = await disposableRoot();
  let groupObservations = 0;
  const { custody } = await createCustody({
    options: {
      processGroupStatus: pid => {
        groupObservations += 1;
        try {process.kill(-pid, 0); return "present";} catch {return "absent";}
      },
    },
    qualifiedIdentity: false,
    script: `process.stdout.write("pid:" + process.pid + "\\n"); setInterval(() => {}, 1000);`,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:no-observer",
    operationId: "operation:no-observer",
    providerBinding: binding,
    workspaceRef,
  } as const;
  let failure: unknown;
  try {await custody.open(request);} catch (error) {failure = error;}
  assert.equal(Reflect.get(failure as object, "name"), "HostCustodyStartError");
  const custodyRef = String(Reflect.get(failure as object, "custodyRef"));
  const outcome = await custody.requestContainment({ ...request, custodyRef });
  assert.equal(outcome.kind, "contained");
  assert.equal(groupObservations, 0);
  assert.equal(custody.evidence(custodyRef)?.identity.status, "ambiguous");
});
test("stable guardian containment does not reauthorize a recycled process-group identifier", async () => {
  const workspaceRef = await disposableRoot();
  let observations = 0;
  const processIdentityObserver = {
    async observe(input: Parameters<typeof qualifiedIdentityObserver.observe>[0]) {
      observations += 1;
      if (observations > 1) {return { status: "ambiguous" as const };}
      return qualifiedIdentityObserver.observe(input);
    },
  };
  const { custody } = await createCustody({
    options: { processIdentityObserver },
    script: `process.stdout.write("pid:" + process.pid + "\\n"); setInterval(() => {}, 1000);`,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:identity-became-ambiguous",
    operationId: "operation:identity-became-ambiguous",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  await nextText(processHandle.stdout);
  const first = custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  const second = custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(first, second);
  const outcome = await first;
  assert.equal(outcome.kind, "contained");
  assert.equal(observations, 1);
  assert.equal(custody.evidence(opened.custodyRef)?.identity.status, "proved");
});
test("concurrent containment is one idempotent strict Linux cgroup closure", async () => {
  const workspaceRef = await disposableRoot();
  const { custody } = await createCustody({ workspaceRef });
  const request = {
    attemptId: "attempt:containment-flight",
    operationId: "operation:containment-flight",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const first = custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  const second = custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  const third = custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(first, second);
  assert.equal(second, third);
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(a.kind, "contained");
  assert.match(a.kind === "contained" ? a.receiptRef : "", /host-strict-closure/u);
  const evidence = custody.evidence(opened.custodyRef);
  assert.equal(evidence?.closure.profile, "strict-linux-cgroup-v2");
  assert.equal(evidence?.closure.status, "closed");
  assert.deepEqual(evidence?.closure.limitations, []);
});
test("a signal-terminated root is observed as exited before group closure", async () => {
  const workspaceRef = await disposableRoot();
  const { custody } = await createCustody({
    script: `process.stdout.write("ready\\n"); process.stdin.once("data", () => process.kill(process.pid, "SIGTERM"));`,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:signal-exit",
    operationId: "operation:signal-exit",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  await nextText(processHandle.stdout);
  await processHandle.write(Buffer.from("exit"));
  assert.equal((await processHandle.waitForExit()).signal, "SIGTERM");
  const outcome = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(outcome.kind, "contained");
});
test("delegated SDK start is single-flight and wrapper owns group-signal state", async () => {
  const workspaceRef = await disposableRoot();
  const deferred = await createCustody({ binding: claudeBinding, spawnMode: "sdk-delegated", workspaceRef });
  const request = {
    attemptId: "attempt:delegated-flight",
    operationId: "operation:delegated-flight",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await deferred.custody.open(request);
  const exact = {
    arguments: deferred.arguments,
    command: deferred.executablePath,
    cwd: "/proc/self/fd/4",
    environment: deferred.environment,
    signal: new AbortController().signal,
  } as const;
  const driftedStarts = [
    { ...exact, command: "/bin/false" },
    { ...exact, arguments: ["-e", "setInterval(() => {}, 1)"] },
    { ...exact, cwd: undefined },
    { ...exact, environment: { ...deferred.environment, EXTRA: "1" } },
  ];
  for (const drifted of driftedStarts) {
    assert.throws(() => deferred.custody.start(opened.custodyRef, drifted), /fingerprint conflict/u);
    assert.equal(deferred.custody.get(opened.custodyRef), undefined);
  }
  const first = deferred.custody.start(opened.custodyRef, exact);
  const second = deferred.custody.start(opened.custodyRef, exact);
  assert.equal(first, second);
  assert.equal(first.killed, false);
  assert.equal(first.kill("SIGCONT"), false);
  assert.equal(first.killed, false);
  await waitForProvedIdentity(deferred.custody, opened.custodyRef);
  assert.equal(first.kill("SIGCONT"), false);
  assert.equal(first.killed, false);
  assert.equal(first.kill("SIGTERM"), false);
  assert.equal(first.killed, true);
  const closed = await deferred.custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closed.kind, "contained", JSON.stringify(closed));
});
test("delegated launch authority binds the exact immutable operation mode", async () => {
  const workspaceRef = await disposableRoot();
  const analysis = ["-e", "process.stdout.write('analysis'); setInterval(() => {}, 1000)"];
  const workspaceWrite = ["-e", "process.stdout.write('workspace-write'); setInterval(() => {}, 1000)"];
  const entry = await launchPlan({
    binding: claudeBinding,
    script: analysis[1] ?? "",
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    residueAuthorityFactory: syntheticResidueAuthorityFactory,
  });
  const request = {
    attemptId: "attempt:delegated-authority-set",
    intentMode: "analysis",
    operationId: "operation:delegated-authority-set",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  assert.equal(entry.plan.intentMode, request.intentMode);
  await assert.rejects(custody.open({
    ...request,
    attemptId: "attempt:write-mode-escalation",
    intentMode: "workspace-write",
  }), { name: "HostCustodyUnsupportedError" });
  const opened = await custody.open(request);
  assert.equal(custody.evidence(opened.custodyRef)?.fingerprint.intentMode, "analysis");
  const exact = {
    arguments: analysis,
    command: entry.plan.executablePath,
    cwd: "/proc/self/fd/4",
    environment: entry.plan.environment,
    signal: new AbortController().signal,
  } as const;
  assert.throws(
    () => custody.start(opened.custodyRef, { ...exact, arguments: workspaceWrite }),
    /fingerprint conflict/u,
  );
  const child = custody.start(opened.custodyRef, exact);
  assert.match(await nextText(child.stdout as AsyncIterable<Uint8Array>), /analysis/u);
  assert.equal((await custody.requestContainment({ ...request, custodyRef: opened.custodyRef })).kind, "contained");
});
test("delegated spawn error is acknowledged as never-started and is never retried", async () => {
  const workspaceRef = await disposableRoot();
  const badExecutable = join(workspaceRef, "bad-interpreter");
  await writeFile(badExecutable, "#!/no/such/synthetic/interpreter\nexit 0\n", { mode: 0o500 });
  const entry = await launchPlan({
    binding: claudeBinding,
    executablePath: badExecutable,
    script: "",
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = {
    attemptId: "attempt:spawn-error",
    operationId: "operation:spawn-error",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const controller = new AbortController();
  const child = custody.start(opened.custodyRef, {
    arguments: entry.plan.arguments,
    command: entry.plan.executablePath,
    cwd: "/proc/self/fd/4",
    environment: entry.plan.environment,
    signal: controller.signal,
  });
  await new Promise<void>(resolve => {child.once("error", () => resolve());});
  assert.equal(custody.evidence(opened.custodyRef)?.spawn, "error-before-start");
  assert.equal(custody.start(opened.custodyRef, {
    arguments: entry.plan.arguments,
    command: entry.plan.executablePath,
    cwd: "/proc/self/fd/4",
    environment: entry.plan.environment,
    signal: controller.signal,
  }), child);
  const closure = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closure.kind, "contained");
  assert.equal(custody.evidence(opened.custodyRef)?.closure.status, "not-started");
  assert.equal(custody.evidence(opened.custodyRef)?.sealed, true);
});
test("lost spawn acknowledgement is typed ambiguous and cannot be retried", async () => {
  const workspaceRef = await disposableRoot();
  const deferred = await createCustody({
    binding: claudeBinding,
    options: { spawnAcknowledgementObserver: async () => ({ status: "ambiguous" }) },
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:lost-ack",
    operationId: "operation:lost-ack",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await deferred.custody.open(request);
  const exact = {
    arguments: deferred.arguments,
    command: deferred.executablePath,
    cwd: "/proc/self/fd/4",
    environment: deferred.environment,
    signal: new AbortController().signal,
  } as const;
  const child = deferred.custody.start(opened.custodyRef, exact);
  await waitForEvidence(deferred.custody, opened.custodyRef, evidence =>
    evidence.spawn === "ambiguous" && evidence.identity.status === "ambiguous");
  assert.equal(child.kill("SIGKILL"), false);
  const outcome = await deferred.custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(outcome.kind, "contained", JSON.stringify({
    evidence: deferred.custody.evidence(opened.custodyRef),
    outcome,
  }));
  assert.throws(() => deferred.custody.start(opened.custodyRef, exact), /reservation is sealed/u);
});
test("eager lost acknowledgement rejects with typed safe reconciliation evidence", async () => {
  const workspaceRef = await disposableRoot();
  const { custody } = await createCustody({
    options: { spawnAcknowledgementObserver: async () => ({ status: "ambiguous" }) },
    script: "process.stdout.write('self-closing')",
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:eager-lost-ack",
    operationId: "operation:eager-lost-ack",
    providerBinding: binding,
    workspaceRef,
  } as const;
  let failure: unknown;
  try {
    await custody.open(request);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(failure.name, "HostCustodyStartError");
  assert.equal(Reflect.get(failure, "status"), "ambiguous");
  assert.match(String(Reflect.get(failure, "custodyRef")), /^urn:agent-runtime:host-custody:/u);
  assert.match(String(Reflect.get(failure, "evidenceRef")), /spawn-acknowledgement-ambiguous/u);
  assert.doesNotMatch(JSON.stringify(failure), /synthetic-secret-value/u);
  await assert.rejects(custody.open(request), (error: unknown) => error === failure);
  const closure = await custody.requestContainment(request);
  assert.equal(closure.kind, "contained");
});
test("error-before-start evidence mismatched with a real child cannot produce no-start closure", async () => {
  const workspaceRef = await disposableRoot();
  const { custody } = await createCustody({
    options: {
      spawnAcknowledgementObserver: async input => ({
        child: input.child,
        childProcessInstanceSha256: input.childProcessInstanceSha256,
        status: "error-before-start",
      }),
    },
    script: `process.stdout.write("pid:" + process.pid + "\\n"); setInterval(() => {}, 1000);`,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:false-no-start",
    operationId: "operation:false-no-start",
    providerBinding: binding,
    workspaceRef,
  } as const;
  let failure: unknown;
  try {await custody.open(request);} catch (error) {failure = error;}
  const custodyRef = String(Reflect.get(failure as object, "custodyRef"));
  const closure = await custody.requestContainment({ ...request, custodyRef });
  assert.equal(closure.kind, "contained");
  assert.notEqual(custody.evidence(custodyRef)?.closure.status, "not-started");
  assert.equal(custody.evidence(custodyRef)?.sealed, true);
});
test("large unconsumed stderr is continuously drained, hashed, and bounded", async () => {
  const workspaceRef = await disposableRoot();
  const stderrBytes = 2 * 1_048_576;
  const script = `process.stderr.write(Buffer.alloc(${stderrBytes}, 120), () => process.stdout.write("ready\\n")); setInterval(() => {}, 1000);`;
  const { custody } = await createCustody({
    options: { maxDiagnosticBytes: 512, maxStderrBytes: stderrBytes + 1 },
    script,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:large-stderr",
    operationId: "operation:large-stderr",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  assert.match(await nextText(processHandle.stdout), /ready/u);
  const closed = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closed.kind, "contained");
  assert.deepEqual(custody.evidence(opened.custodyRef)?.stderr, {
    bytes: stderrBytes,
    sha256: sha256(Buffer.alloc(stderrBytes, 120)),
    status: "complete",
  });
});
test("stdout permits one slow consumer with bounded backpressure and refuses a second", async () => {
  const workspaceRef = await disposableRoot();
  const script = String.raw`
let index = 0;
const timer = setInterval(() => {
  process.stdout.write(Buffer.alloc(4096, 65 + (index % 20)));
  index += 1;
  if (index === 32) { clearInterval(timer); process.stdout.write("done"); }
}, 2);
setInterval(() => {}, 1000);
`;
  const { custody } = await createCustody({
    options: { maxStdoutBytes: 256 * 1024, stdoutHighWaterBytes: 8 * 1024 },
    script,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:slow-stdout",
    operationId: "operation:slow-stdout",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  const consuming = collect(processHandle.stdout, 3);
  assert.throws(() => processHandle.stdout[Symbol.asyncIterator](), /single registered consumer/u);
  assert.throws(
    () => (processHandle.stdout as NodeJS.ReadableStream).on("data", () => {}),
    /single registered consumer/u,
  );
  await waitForEvidence(custody, opened.custodyRef, evidence => evidence.stdout.bytes === (32 * 4096) + 4);
  const closed = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closed.kind, "contained");
  const bytes = await consuming;
  assert.equal(bytes.byteLength, (32 * 4096) + 4);
  assert.equal(custody.evidence(opened.custodyRef)?.stdout.status, "complete");
});

test("stdout ingress overflow stops accounting and triggers bounded containment", async () => {
  const workspaceRef = await disposableRoot();
  const script = `process.stdout.write(Buffer.alloc(65536, 97)); setInterval(() => {}, 1000);`;
  const { custody } = await createCustody({ options: { maxStdoutBytes: 4096 }, script, workspaceRef });
  const request = {
    attemptId: "attempt:stdout-overflow",
    operationId: "operation:stdout-overflow",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  void collect(processHandle.stdout);
  await waitForEvidence(custody, opened.custodyRef, evidence => evidence.stdout.status === "overflow");
  const outcome = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /ingress-overflow/u);
  assert.deepEqual(custody.evidence(opened.custodyRef)?.stdout, {
    bytes: 4096,
    sha256: sha256(Buffer.alloc(4096, 97)),
    status: "overflow",
  });
});
test("stderr flood stops reading and hashing at the cumulative bound", async () => {
  const workspaceRef = await disposableRoot();
  const script = `process.stderr.write(Buffer.alloc(1048576, 98)); setInterval(() => {}, 1000);`;
  const { custody } = await createCustody({ options: { maxStderrBytes: 4096 }, script, workspaceRef });
  const request = {
    attemptId: "attempt:stderr-overflow",
    operationId: "operation:stderr-overflow",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  await waitForEvidence(custody, opened.custodyRef, evidence => evidence.stderr.status === "overflow");
  const outcome = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(outcome.kind, "unproven");
  assert.deepEqual(custody.evidence(opened.custodyRef)?.stderr, {
    bytes: 4096,
    sha256: sha256(Buffer.alloc(4096, 98)),
    status: "overflow",
  });
});

test("cumulative stdin overflow rejects the write and triggers containment", async () => {
  const workspaceRef = await disposableRoot();
  const { custody } = await createCustody({
    options: { maxStdinBytes: 4096 },
    script: `process.stdout.write("ready\\n"); process.stdin.resume(); setInterval(() => {}, 1000);`,
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:stdin-overflow",
    operationId: "operation:stdin-overflow",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  await nextText(processHandle.stdout);
  await processHandle.write(Buffer.alloc(4096));
  await assert.rejects(processHandle.write(Buffer.from([1])), { name: "HostCustodyIngressOverflowError" });
  assert.equal((await custody.requestContainment({ ...request, custodyRef: opened.custodyRef })).kind, "contained");
});

test("delegated SDK stdin shares the cumulative bound and triggers containment", async () => {
  const workspaceRef = await disposableRoot();
  const deferred = await createCustody({
    binding: claudeBinding,
    options: { maxStdinBytes: 4096 },
    script: `process.stdout.write("ready\\n"); process.stdin.resume(); setInterval(() => {}, 1000);`,
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const request = {
    attemptId: "attempt:delegated-stdin-overflow",
    operationId: "operation:delegated-stdin-overflow",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await deferred.custody.open(request);
  const child = deferred.custody.start(opened.custodyRef, {
    arguments: deferred.arguments,
    command: deferred.executablePath,
    cwd: "/proc/self/fd/4",
    environment: deferred.environment,
    signal: new AbortController().signal,
  });
  assert.match(await nextText(child.stdout as AsyncIterable<Uint8Array>), /ready/u);
  const stdin = child.stdin as NodeJS.WritableStream;
  stdin.on("error", () => {});
  const write = (bytes: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
    stdin.write(bytes, error => {if (error) {reject(error);} else {resolve();}});
  });
  await write(Buffer.alloc(4096));
  await assert.rejects(write(Buffer.from([1])), { name: "HostCustodyIngressOverflowError" });
  assert.equal((await deferred.custody.requestContainment({ ...request, custodyRef: opened.custodyRef })).kind, "contained");
});

test("inherited descriptors from a session-escaped descendant make drain unproven", async () => {
  const workspaceRef = await disposableRoot();
  const script = String.raw`
const { spawn } = require("node:child_process");
const child = spawn(process.argv0, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", 1, 2],
});
child.unref();
process.stdout.write("escaped:" + child.pid + "\n");
setTimeout(() => process.exit(0), 100);
`;
  const { custody } = await createCustody({ options: { drainAfterMs: 30 }, script, workspaceRef });
  const request = {
    attemptId: "attempt:escaped-descendant",
    operationId: "operation:escaped-descendant",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  const escapedText = await nextText(processHandle.stdout);
  assert.match(escapedText, /escaped:(\d+)/u);
  const escapedPid = Number(escapedText.match(/escaped:(\d+)/u)?.[1]);
  childrenToStop.add(escapedPid);
  await processHandle.waitForExit();
  assert.doesNotThrow(() => {process.kill(escapedPid, 0);});
  const outcome = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(outcome.kind, "unproven", JSON.stringify(outcome));
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /ingress-incomplete/u);
  assert.equal(custody.evidence(opened.custodyRef)?.closure.status, "unproven");
});

test("stream evidence seals only after final ingress end in an exit/end race", async () => {
  const workspaceRef = await disposableRoot();
  const script = `process.stdout.write("terminal-bytes"); process.stderr.write("diagnostic-bytes"); setInterval(() => {}, 1000);`;
  const { custody } = await createCustody({ script, workspaceRef });
  const request = {
    attemptId: "attempt:end-race",
    operationId: "operation:end-race",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const before = custody.evidence(opened.custodyRef);
  assert.equal(before?.stdout.status, "incomplete");
  assert.equal(before?.stderr.status, "incomplete");
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  const output = collect(processHandle.stdout);
  const diagnostics = collect(processHandle.stderr);
  await waitForEvidence(custody, opened.custodyRef, evidence =>
    evidence.stdout.bytes === Buffer.byteLength("terminal-bytes") &&
    evidence.stderr.bytes === Buffer.byteLength("diagnostic-bytes"));
  const closure = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closure.kind, "contained", JSON.stringify(closure));
  assert.equal((await output).toString("utf8"), "terminal-bytes");
  assert.match((await diagnostics).toString("utf8"), /stderr-bytes:16:sha256:/u);
  assert.deepEqual(custody.evidence(opened.custodyRef)?.stdout, {
    bytes: Buffer.byteLength("terminal-bytes"),
    sha256: sha256(Buffer.from("terminal-bytes")),
    status: "complete",
  });
  assert.deepEqual(custody.evidence(opened.custodyRef)?.stderr, {
    bytes: Buffer.byteLength("diagnostic-bytes"),
    sha256: sha256(Buffer.from("diagnostic-bytes")),
    status: "complete",
  });
  assert.equal(custody.evidence(opened.custodyRef)?.sealed, true);
});
