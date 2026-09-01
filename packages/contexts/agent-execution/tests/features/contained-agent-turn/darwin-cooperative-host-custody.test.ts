import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { DarwinCooperativeProcessCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-cooperative-process-custody.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
import { createDarwinCooperativeProcessCustodyTestSupport } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-cooperative-process-custody-test-support.js";
import {
  binding,
  claudeBinding,
  disposableRoot,
  launchPlan,
  nextText,
  qualifiedIdentityObserver,
  roots,
  sha256,
  trackSyntheticProcessGroup,
  waitForEvidence,
  waitForProvedIdentity,
} from "../../host-custody-test-fixture.ts";

const cooperativeEntry = async (
  workspaceRef: string,
  spawnMode: "eager" | "sdk-delegated" = "eager",
  script = "process.stdout.write('cooperative\\n'); setInterval(() => {}, 1000);",
) => {
  const entry = await launchPlan({
    script,
    spawnMode,
    workspaceRef,
  });
  return Object.freeze({
    ...entry,
    plan: Object.freeze({
      ...entry.plan,
      containmentProfile: "cooperative-darwin-posix-process-group" as const,
    }),
  });
};

const groupObserver = Object.freeze({
  async observe(pgid: number) {
    try {process.kill(-pgid, 0); return "residue" as const;}
    catch {return "empty" as const;}
  },
});

test("Darwin production custody cannot be enabled by spoofing a public platform option", () => {
  if (process.platform === "darwin") {return;}
  assert.throws(() => new DarwinCooperativeProcessCustody({
    launchPlans: Object.freeze({async resolve() {return;}}),
    platform: "darwin",
  } as ConstructorParameters<typeof DarwinCooperativeProcessCustody>[0] & { readonly platform: string }), {
    code: "platform-profile-unavailable", name: "HostCustodyUnsupportedError",
  });
});

test("Darwin escaped-session descendant survives group closure while custody reconciles and quarantines", async () => {
  const workspaceRef = await disposableRoot();
  const providerOutput = "provider-secret-output-must-not-enter-evidence";
  const entry = await cooperativeEntry(workspaceRef, "eager", String.raw`
const { spawn } = require("node:child_process");
const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
process.stdout.write("escaped:" + detached.pid + ":provider-secret-output-must-not-enter-evidence\n");
setInterval(() => {}, 1000);
`);
  const custody = createDarwinCooperativeProcessCustodyTestSupport({
    drainAfterMs: 2_000,
    forceKillAfterMs: 2_000,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processGroupObserver: groupObserver,
    processIdentityObserver: qualifiedIdentityObserver,
    terminateAfterMs: 50,
  });
  const request = Object.freeze({
    attemptId: "attempt:darwin-eager",
    intentMode: "analysis" as const,
    operationId: "operation:darwin-eager",
    providerBinding: binding,
    workspaceRef,
  });
  let detachedPid: number | undefined;
  try {
    const opened = await custody.open(request);
    await waitForProvedIdentity(custody, opened.custodyRef);
    const provider = custody.get(opened.custodyRef);
    assert.ok(provider);
    const output = await nextText(provider.stdout);
    const match = /escaped:(\d+):/u.exec(output);
    assert.ok(match);
    detachedPid = Number(match[1]);
    trackSyntheticProcessGroup(detachedPid);
    roots.push(`${entry.plan.privateRootPath}.quarantine-${sha256(opened.custodyRef)}`);

    const outcome = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
    assert.equal(outcome.kind, "unproven");
    assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /darwin-cooperative-reconciliation-required/u);
    assert.doesNotThrow(() => {process.kill(detachedPid as number, 0);});
    const evidence = custody.evidence(opened.custodyRef);
    assert.equal(evidence?.closure.profile, "cooperative-darwin-posix-process-group");
    assert.deepEqual(evidence?.closure.limitations, [
      "canonical-executable-path-is-name-bound-at-spawn",
      "canonical-workspace-path-is-name-bound-at-spawn",
      "private-environment-paths-are-name-bound-at-spawn",
      "descendant-may-escape-via-new-session",
    ]);
    assert.equal(evidence?.closure.status, "unproven");
    assert.equal(evidence?.privateRoot.status, "quarantined");
    assert.equal(evidence?.sealed, true);
    const canonicalEvidence = JSON.stringify({ evidence, outcome });
    assert.doesNotMatch(canonicalEvidence, new RegExp(workspaceRef, "u"));
    assert.doesNotMatch(canonicalEvidence, new RegExp(entry.plan.privateRootPath, "u"));
    assert.doesNotMatch(canonicalEvidence, new RegExp(providerOutput, "u"));
  } finally {
    if (detachedPid !== undefined) {
      try {process.kill(-detachedPid, "SIGKILL");} catch {}
      try {process.kill(detachedPid, "SIGKILL");} catch {}
    }
  }
});

test("Darwin delegated custody preserves exact one-start replay and conflicting identity", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await cooperativeEntry(workspaceRef, "sdk-delegated");
  const custody = createDarwinCooperativeProcessCustodyTestSupport({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processGroupObserver: groupObserver,
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = Object.freeze({
    attemptId: "attempt:darwin-delegated",
    intentMode: "analysis" as const,
    operationId: "operation:darwin-delegated",
    providerBinding: binding,
    workspaceRef,
  });
  const workspaceHandle = await open(workspaceRef, "r");
  const workspaceStats = await workspaceHandle.stat({ bigint: true });
  const opened = await custody.reserve({
    ...request,
    launchPlan: entry.plan,
    workspaceAuthority: Object.freeze({
      canonicalPath: workspaceRef,
      descriptorPath: `/proc/self/fd/${workspaceHandle.fd}`,
      identity: Object.freeze({
        dev: workspaceStats.dev,
        ino: workspaceStats.ino,
        mountId: "darwin-statfs:synthetic",
      }),
    }),
  });
  await workspaceHandle.close();
  const input = Object.freeze({
    arguments: entry.plan.arguments,
    command: entry.plan.executablePath,
    cwd: workspaceRef,
    environment: entry.plan.environment,
    signal: new AbortController().signal,
  });
  const first = custody.start(opened.custodyRef, input);
  assert.equal(custody.start(opened.custodyRef, input), first);
  assert.throws(() => custody.start(opened.custodyRef, {
    ...input,
    arguments: [...input.arguments, "conflict"],
  }), { name: "HostCustodyFingerprintConflictError" });
  await waitForProvedIdentity(custody, opened.custodyRef);
  await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
});

test("Darwin delegated reservation proves no-start and releases idempotently", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await cooperativeEntry(workspaceRef, "sdk-delegated");
  const custody = createDarwinCooperativeProcessCustodyTestSupport({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
  });
  const request = Object.freeze({
    attemptId: "attempt:darwin-no-start",
    intentMode: "analysis" as const,
    operationId: "operation:darwin-no-start",
    providerBinding: binding,
    workspaceRef,
  });
  const workspaceHandle = await open(workspaceRef, "r");
  const workspaceStats = await workspaceHandle.stat({ bigint: true });
  const opened = await custody.reserve({
    ...request,
    launchPlan: entry.plan,
    workspaceAuthority: Object.freeze({
      canonicalPath: workspaceRef,
      descriptorPath: `/proc/self/fd/${workspaceHandle.fd}`,
      identity: Object.freeze({
        dev: workspaceStats.dev,
        ino: workspaceStats.ino,
        mountId: "darwin-statfs:synthetic-no-start",
      }),
    }),
  });
  await workspaceHandle.close();
  assert.equal(custody.get(opened.custodyRef), undefined);
  const contained = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(contained.kind, "contained");
  const evidence = custody.evidence(opened.custodyRef);
  assert.equal(evidence?.spawn, "never-started");
  assert.equal(evidence?.closure.profile, "cooperative-darwin-posix-process-group");
  assert.equal(evidence?.closure.status, "not-started");
  assert.equal(evidence?.providerExit.status, "not-started");
  if (contained.kind !== "contained") {return;}
  const releaseInput = {
    ...request,
    custodyRef: opened.custodyRef,
    receiptRef: contained.receiptRef,
  };
  assert.deepEqual(await custody.release(releaseInput), { kind: "released" });
  assert.deepEqual(await custody.release(releaseInput), { kind: "released" });
  assert.equal(custody.evidence(opened.custodyRef)?.privateRoot.status, "deleted");
  assert.equal(existsSync(entry.plan.privateRootPath), false);
});

test("Darwin delegated error-before-start releases only after complete no-start evidence", async () => {
  const workspaceRef = await disposableRoot();
  const badExecutable = join(workspaceRef, "bad-interpreter");
  await writeFile(badExecutable, "#!/no/such/synthetic/interpreter\nexit 0\n", { mode: 0o500 });
  const base = await launchPlan({
    binding: claudeBinding,
    executablePath: badExecutable,
    script: "",
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const entry = Object.freeze({
    ...base,
    plan: Object.freeze({ ...base.plan, containmentProfile: "cooperative-darwin-posix-process-group" as const }),
  });
  const custody = createDarwinCooperativeProcessCustodyTestSupport({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
  });
  const request = Object.freeze({
    attemptId: "attempt:darwin-error-before-start",
    intentMode: "analysis" as const,
    operationId: "operation:darwin-error-before-start",
    providerBinding: claudeBinding,
    workspaceRef,
  });
  const workspaceHandle = await open(workspaceRef, "r");
  const workspaceStats = await workspaceHandle.stat({ bigint: true });
  const opened = await custody.reserve({
    ...request,
    launchPlan: entry.plan,
    workspaceAuthority: Object.freeze({
      canonicalPath: workspaceRef,
      descriptorPath: `/proc/self/fd/${workspaceHandle.fd}`,
      identity: Object.freeze({
        dev: workspaceStats.dev,
        ino: workspaceStats.ino,
        mountId: "darwin-statfs:synthetic-error-before-start",
      }),
    }),
  });
  await workspaceHandle.close();
  const child = custody.start(opened.custodyRef, {
    arguments: entry.plan.arguments,
    command: entry.plan.executablePath,
    cwd: workspaceRef,
    environment: entry.plan.environment,
    signal: new AbortController().signal,
  });
  await new Promise<void>(resolve => {child.once("error", () => resolve());});
  await waitForEvidence(custody, opened.custodyRef, evidence => evidence.spawn === "error-before-start");
  const contained = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(contained.kind, "contained");
  if (contained.kind !== "contained") {return;}
  const releaseInput = { ...request, custodyRef: opened.custodyRef, receiptRef: contained.receiptRef };
  assert.deepEqual(await custody.release(releaseInput), { kind: "released" });
  assert.deepEqual(await custody.release(releaseInput), { kind: "released" });
  assert.equal(custody.evidence(opened.custodyRef)?.privateRoot.status, "deleted");
  assert.equal(existsSync(entry.plan.privateRootPath), false);
});

test("Darwin custody escalates TERM to KILL and fails closed on ambiguous group closure", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await cooperativeEntry(
    workspaceRef,
    "eager",
    "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
  );
  let observation: "empty" | "unproven" = "empty";
  const custody = createDarwinCooperativeProcessCustodyTestSupport({
    containmentAfterMs: 2_000,
    forceKillAfterMs: 500,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processGroupObserver: Object.freeze({async observe() {return observation;}}),
    processIdentityObserver: qualifiedIdentityObserver,
    terminateAfterMs: 25,
  });
  const request = Object.freeze({
    attemptId: "attempt:darwin-escalation",
    intentMode: "analysis" as const,
    operationId: "operation:darwin-escalation",
    providerBinding: binding,
    workspaceRef,
  });
  const opened = await custody.open(request);
  const process = custody.get(opened.custodyRef);
  assert.ok(process);
  await nextText(process.stdout);
  const closed = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closed.kind, "unproven");
  assert.match(closed.kind === "unproven" ? closed.evidenceRef : "", /darwin-cooperative-reconciliation-required/u);
  assert.equal(custody.evidence(opened.custodyRef)?.providerExit.status, "observed");
  assert.equal(custody.evidence(opened.custodyRef)?.providerExit.status === "observed" &&
    custody.evidence(opened.custodyRef)?.providerExit.signal, "SIGKILL");

  const secondWorkspace = await disposableRoot();
  const secondEntry = await cooperativeEntry(secondWorkspace);
  observation = "unproven";
  const ambiguous = createDarwinCooperativeProcessCustodyTestSupport({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([secondEntry]),
    processGroupObserver: Object.freeze({async observe() {return observation;}}),
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const ambiguousRequest = Object.freeze({
    attemptId: "attempt:darwin-ambiguous-group",
    intentMode: "analysis" as const,
    operationId: "operation:darwin-ambiguous-group",
    providerBinding: binding,
    workspaceRef: secondWorkspace,
  });
  const ambiguousOpened = await ambiguous.open(ambiguousRequest);
  const outcome = await ambiguous.requestContainment({
    ...ambiguousRequest,
    custodyRef: ambiguousOpened.custodyRef,
  });
  assert.equal(outcome.kind, "unproven");
  assert.equal(ambiguous.evidence(ambiguousOpened.custodyRef)?.closure.status, "unproven");
});
