import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, test } from "node:test";

import {
  HostCustodyUnsupportedError,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import { NodeProviderProcessCustody as BaseNodeProviderProcessCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
import { terminateCooperativeProcessGroup } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-stdio.js";
import {
  syntheticResidueAuthorityFactory,
  trackSyntheticProcessGroup,
} from "../../host-custody-test-fixture.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;

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

const roots: string[] = [];

const binding = Object.freeze({
  adapterRevision: "synthetic-adapter:one",
  binaryRevision: "node:synthetic",
  capabilityManifestRevision: "manifest:synthetic",
  credentialBindingDigest: "credential:synthetic",
  provider: "codex" as const,
  providerRouteRef: "route:synthetic",
});

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const digestCache = new Map<string, Promise<string>>();
const executableDigest = (path: string): Promise<string> => {
  const existing = digestCache.get(path);
  if (existing !== undefined) {return existing;}
  const digest = readFile(path).then(bytes => sha256(bytes));
  digestCache.set(path, digest);
  return digest;
};

const disposableRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-runtime-host-custody-lifecycle-")));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

const qualifiedIdentityObserver = Object.freeze({
  async observe(input: {
    readonly binarySha256: string;
    readonly child: object;
    readonly childProcessInstanceSha256: string;
    readonly hostLifecycleGenerationSha256: string;
    readonly pgid: number;
    readonly pid: number;
    readonly planSha256: string;
  }) {
    return Object.freeze({
      child: input.child,
      childProcessInstanceSha256: input.childProcessInstanceSha256,
      pgid: input.pgid,
      pid: input.pid,
      proofRef: `synthetic-qualified-observer:${sha256(JSON.stringify([
        input.pid,
        input.pgid,
        input.binarySha256,
        input.planSha256,
        input.hostLifecycleGenerationSha256,
      ]))}`,
      status: "proved" as const,
    });
  },
});

const launchPlan = async (
  workspaceRef: string,
  searchPath: string,
  script: string,
  options: { readonly arguments?: readonly string[]; readonly executablePath?: string } = {},
) => {
  const executablePath = await realpath(options.executablePath ?? process.execPath);
  const privateRootPath = join(dirname(workspaceRef), `${basename(workspaceRef)}-host-private`);
  const providerConfig = join(privateRootPath, "provider-config");
  const home = join(privateRootPath, "home");
  const temporary = join(privateRootPath, "tmp");
  await Promise.all([
    mkdir(providerConfig, { mode: 0o700, recursive: true }),
    mkdir(home, { mode: 0o700, recursive: true }),
    mkdir(temporary, { mode: 0o700, recursive: true }),
  ]);
  if (!roots.includes(privateRootPath)) {roots.push(privateRootPath);}
  return Object.freeze({
    plan: Object.freeze({
      arguments: Object.freeze(options.arguments ?? ["-e", script]),
      binaryRevision: binding.binaryRevision,
      containmentProfile: "strict-linux-cgroup-v2" as const,
      environment: Object.freeze({
        CODEX_HOME: providerConfig,
        HOME: home,
        LANG: "C.UTF-8",
        PATH: searchPath,
        TMPDIR: temporary,
      }),
      executablePath,
      executableSha256: await executableDigest(executablePath),
      intentMode: "analysis" as const,
      privatePathEnvironmentKeys: Object.freeze(["CODEX_HOME", "HOME", "TMPDIR"]),
      privateRootPath,
      provider: binding.provider,
    }),
    providerBinding: binding,
  });
};

const nextText = async (source: AsyncIterable<Uint8Array>): Promise<string> => {
  const next = await source[Symbol.asyncIterator]().next();
  assert.equal(next.done, false);
  return Buffer.from(next.value).toString("utf8");
};

const settleWithin = <Value>(promise: Promise<Value>, milliseconds: number): Promise<
  | { readonly kind: "fulfilled"; readonly value: Value }
  | { readonly error: unknown; readonly kind: "rejected" }
  | { readonly kind: "timed-out" }
> => new Promise(resolve => {
  let settled = false;
  const settle = (outcome:
    | { readonly kind: "fulfilled"; readonly value: Value }
    | { readonly error: unknown; readonly kind: "rejected" }
    | { readonly kind: "timed-out" }): void => {
    if (settled) {return;}
    settled = true;
    resolve(outcome);
  };
  const timer = setTimeout(() => {settle({ kind: "timed-out" });}, milliseconds);
  void promise.then(
    value => {clearTimeout(timer); return settle({ kind: "fulfilled", value });},
    error => {clearTimeout(timer); return settle({ error, kind: "rejected" });},
  );
});

const waitUntil = async (
  predicate: () => boolean,
  failure: string,
  milliseconds = 5_000,
): Promise<void> => {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) {assert.fail(failure);}
    await new Promise<void>(resolve => {setImmediate(resolve);});
  }
};

linuxTest("TERM-resistant process is stopped within monotonic configured bounds", async () => {
  const workspaceRef = await disposableRoot();
  const script = `process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
  const entry = await launchPlan(workspaceRef, "/usr/bin:/bin", script);
  const custody = new NodeProviderProcessCustody({
    drainAfterMs: 500,
    forceKillAfterMs: 500,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processIdentityObserver: qualifiedIdentityObserver,
    terminateAfterMs: 100,
  });
  const request = {
    attemptId: "attempt:monotonic-stop",
    operationId: "operation:monotonic-stop",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  await nextText(processHandle.stdout);
  const startedAt = performance.now();
  const closure = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  const elapsed = performance.now() - startedAt;
  assert.equal(closure.kind, "contained", JSON.stringify({
    closure,
    evidence: custody.evidence(opened.custodyRef),
  }));
  assert.ok(elapsed < 5_000, `bounded containment including executable re-observation took ${elapsed}ms`);
  assert.equal((await processHandle.waitForExit()).signal, "SIGKILL");
});

linuxTest("an unproven containment result is not memoized over a later safe escalation", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan(
    workspaceRef,
    "/usr/bin:/bin",
    `process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`,
  );
  let guardianPid: number | undefined;
  let killAllCalls = 0;
  const custody = new NodeProviderProcessCustody({
    containmentAfterMs: 1_000,
    drainAfterMs: 100,
    forceKillAfterMs: 25,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processIdentityObserver: qualifiedIdentityObserver,
    residueAuthorityFactory: {
      async create() {
        return Object.freeze({
          async attachGuardian(pid: number) {
            guardianPid = pid;
            trackSyntheticProcessGroup(pid);
            return true;
          },
          async close() {return true;},
          async killAll() {
            killAllCalls += 1;
            if (killAllCalls === 1 || guardianPid === undefined) {return false;}
            try {process.kill(-guardianPid, "SIGKILL"); return true;} catch {return false;}
          },
          async proveEmpty() {return killAllCalls > 1 ? "empty" as const : "unproven" as const;},
        });
      },
    },
    terminateAfterMs: 25,
  });
  const request = {
    attemptId: "attempt:retry-safe-escalation",
    operationId: "operation:retry-safe-escalation",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  await nextText(processHandle.stdout);

  const first = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(first.kind, "unproven");
  assert.match(first.kind === "unproven" ? first.evidenceRef : "", /stable-guardian-exit-unproven/u);
  assert.equal(killAllCalls, 1);

  const second = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(second.kind, "contained", JSON.stringify(second));
  assert.equal(killAllCalls, 2);
  assert.equal(custody.evidence(opened.custodyRef)?.closure.status, "closed");
  assert.equal(custody.evidence(opened.custodyRef)?.sealed, true);
});

linuxTest("hanging identity observation is bounded and launch fails closed", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan(workspaceRef, "/usr/bin:/bin", `setTimeout(() => process.exit(0), 200);`);
  let observerStartedAt = 0;
  const custody = new NodeProviderProcessCustody({
    identityObservationAfterMs: 25,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processIdentityObserver: {async observe() {observerStartedAt = performance.now(); return new Promise(() => {});}},
  });
  const request = {
    attemptId: "attempt:observer-hang",
    operationId: "operation:observer-hang",
    providerBinding: binding,
    workspaceRef,
  } as const;
  await assert.rejects(custody.open(request), { name: "HostCustodyStartError" });
  assert.ok(observerStartedAt > 0);
  assert.ok(performance.now() - observerStartedAt < 1_000);
});

linuxTest("identity proof resolving at the spawn deadline cannot authorize launch", { timeout: 30_000 }, async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan(workspaceRef, "/usr/bin:/bin", "", {
    arguments: ["-c", "read ignored"],
    executablePath: "/bin/sh",
  });
  const spawnDeadline = 10_000;
  let monotonicNow = 0;
  let cleanupStartedAt: number | undefined;
  let custodyRef: string | undefined;
  let releaseObserver: (() => void) | undefined;
  let observeStarted: (() => void) | undefined;
  let observeCompleted: ((completedAt: number) => void) | undefined;
  const observerGate = new Promise<void>(resolve => {releaseObserver = resolve;});
  const observerStarted = new Promise<void>(resolve => {observeStarted = resolve;});
  const observerCompleted = new Promise<number>(resolve => {observeCompleted = resolve;});
  const testClock = (): number => cleanupStartedAt === undefined
    ? monotonicNow
    : spawnDeadline + performance.now() - cleanupStartedAt;
  const custody = new NodeProviderProcessCustody({
    containmentAfterMs: 1_000,
    drainAfterMs: 100,
    forceKillAfterMs: 25,
    identityObservationAfterMs: 20_000,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    monotonicNow: testClock,
    processIdentityObserver: {
      async observe(input) {
        observeStarted?.();
        await observerGate;
        observeCompleted?.(testClock());
        return {
          child: input.child,
          childProcessInstanceSha256: input.childProcessInstanceSha256,
          pgid: input.pgid,
          pid: input.pid,
          proofRef: "proof-at-spawn-deadline",
          status: "proved" as const,
        };
      },
    },
    residueAuthorityFactory: {
      async create(ref) {
        custodyRef = ref;
        return syntheticResidueAuthorityFactory.create(ref);
      },
    },
    spawnAcknowledgementAfterMs: spawnDeadline,
    terminateAfterMs: 25,
  });
  const request = {
    attemptId: "attempt:identity-at-deadline",
    operationId: "operation:identity-at-deadline",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opening = custody.open(request);
  void opening.catch(() => {});
  assert.equal(
    (await settleWithin(observerStarted, 15_000)).kind,
    "fulfilled",
    custodyRef === undefined ? "custody reservation unavailable" : JSON.stringify(custody.evidence(custodyRef)),
  );
  assert.ok(custodyRef);
  assert.equal(custody.evidence(custodyRef)?.spawn, "acknowledged");
  monotonicNow = spawnDeadline;
  releaseObserver?.();
  const completion = await settleWithin(observerCompleted, 5_000);
  assert.equal(completion.kind, "fulfilled");
  assert.equal(completion.kind === "fulfilled" ? completion.value : undefined, spawnDeadline);
  await waitUntil(
    () => custody.evidence(custodyRef)?.spawn === "ambiguous",
    `exact-deadline proof did not fail closed: ${JSON.stringify(custody.evidence(custodyRef))}`,
  );
  assert.equal(testClock(), spawnDeadline);
  assert.equal(custody.evidence(custodyRef)?.identity.status, "unproven");
  cleanupStartedAt = performance.now();

  const settlement = await settleWithin(opening, 10_000);
  assert.notEqual(settlement.kind, "timed-out", JSON.stringify(custody.evidence(custodyRef)));
  assert.equal(settlement.kind, "rejected");
  const failure = settlement.kind === "rejected" ? settlement.error : undefined;
  assert.equal(Reflect.get(failure as object, "name"), "HostCustodyStartError");
  assert.equal(Reflect.get(failure as object, "custodyRef"), custodyRef);
  assert.equal(custody.evidence(custodyRef)?.spawn, "ambiguous");
  assert.equal(custody.evidence(custodyRef)?.identity.status, "unproven");
});

linuxTest("an identity observer completing after spawn timeout cannot overwrite failed-closed evidence", { timeout: 30_000 }, async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan(workspaceRef, "/usr/bin:/bin", "", {
    arguments: ["-c", "read ignored"],
    executablePath: "/bin/sh",
  });
  const spawnDeadline = 10_000;
  let monotonicNow = 0;
  let cleanupStartedAt: number | undefined;
  let custodyRef: string | undefined;
  let releaseObserver: (() => void) | undefined;
  let observeStarted: (() => void) | undefined;
  let observeCompleted: ((completedAt: number) => void) | undefined;
  const observerGate = new Promise<void>(resolve => {releaseObserver = resolve;});
  const observerStarted = new Promise<void>(resolve => {observeStarted = resolve;});
  const observerCompleted = new Promise<number>(resolve => {observeCompleted = resolve;});
  const testClock = (): number => cleanupStartedAt === undefined
    ? monotonicNow
    : monotonicNow + performance.now() - cleanupStartedAt;
  const custody = new NodeProviderProcessCustody({
    containmentAfterMs: 1_000,
    drainAfterMs: 100,
    forceKillAfterMs: 25,
    identityObservationAfterMs: 20_000,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    monotonicNow: testClock,
    processIdentityObserver: {
      async observe(input) {
        observeStarted?.();
        await observerGate;
        observeCompleted?.(testClock());
        return {
          child: input.child,
          childProcessInstanceSha256: input.childProcessInstanceSha256,
          pgid: input.pgid,
          pid: input.pid,
          proofRef: "proof-after-spawn-timeout",
          status: "proved" as const,
        };
      },
    },
    residueAuthorityFactory: {
      async create(ref) {
        custodyRef = ref;
        return syntheticResidueAuthorityFactory.create(ref);
      },
    },
    spawnAcknowledgementAfterMs: spawnDeadline,
    terminateAfterMs: 25,
  });
  const request = {
    attemptId: "attempt:identity-after-timeout",
    operationId: "operation:identity-after-timeout",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opening = custody.open(request);
  void opening.catch(() => {});
  assert.equal(
    (await settleWithin(observerStarted, 15_000)).kind,
    "fulfilled",
    custodyRef === undefined ? "custody reservation unavailable" : JSON.stringify(custody.evidence(custodyRef)),
  );
  assert.ok(custodyRef);
  assert.equal(custody.evidence(custodyRef)?.spawn, "acknowledged");
  monotonicNow = spawnDeadline + 1;
  releaseObserver?.();
  const completion = await settleWithin(observerCompleted, 5_000);
  assert.equal(completion.kind, "fulfilled");
  assert.equal(completion.kind === "fulfilled" ? completion.value : undefined, spawnDeadline + 1);
  await waitUntil(
    () => custody.evidence(custodyRef)?.spawn === "ambiguous",
    `late observer did not preserve failed-closed spawn evidence: ${JSON.stringify(custody.evidence(custodyRef))}`,
  );
  assert.equal(custody.evidence(custodyRef)?.identity.status, "unproven");
  cleanupStartedAt = performance.now();
  const settlement = await settleWithin(opening, 10_000);
  assert.notEqual(settlement.kind, "timed-out", JSON.stringify(custody.evidence(custodyRef)));
  assert.equal(settlement.kind, "rejected");
  assert.equal(
    Reflect.get(settlement.kind === "rejected" ? settlement.error as object : {}, "name"),
    "HostCustodyStartError",
  );
  assert.notEqual(custody.evidence(custodyRef)?.identity.status, "proved");
});

linuxTest("PID and process-group mismatch is rejected before the process handle is published", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan(workspaceRef, "/usr/bin:/bin", `setTimeout(() => process.exit(0), 200);`);
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processIdentityObserver: {
      async observe(input) {
        return {
          child: input.child,
          childProcessInstanceSha256: input.childProcessInstanceSha256,
          pgid: input.pgid + 1,
          pid: input.pid,
          proofRef: "mismatched-group",
          status: "proved" as const,
        };
      },
    },
  });
  await assert.rejects(custody.open({
    attemptId: "attempt:group-mismatch",
    operationId: "operation:group-mismatch",
    providerBinding: binding,
    workspaceRef,
  }), { name: "HostCustodyStartError" });
});

linuxTest("release keeps a secret-free tombstone that prevents same-host replay spawn", async () => {
  const workspaceRef = await disposableRoot();
  const privateRootPath = join(dirname(workspaceRef), `${basename(workspaceRef)}-host-private`);
  const secret = "credential-value-that-must-not-escape";
  let searchPath = "/usr/bin:/bin";
  const script = `/* ${secret} */ setInterval(() => {}, 1000);`;
  const custody = new NodeProviderProcessCustody({
    launchPlans: {async resolve() {return (await launchPlan(workspaceRef, searchPath, script)).plan;}},
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = {
    attemptId: "attempt:tombstone",
    operationId: "operation:tombstone",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const closure = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closure.kind, "contained");
  const receiptRef = closure.kind === "contained" ? closure.receiptRef : assert.fail("expected closure");
  assert.equal((await custody.release({ ...request, custodyRef: opened.custodyRef, receiptRef: "wrong-receipt" })).kind, "unproven");
  assert.ok(custody.get(opened.custodyRef));
  assert.deepEqual(await custody.release({ ...request, custodyRef: opened.custodyRef, receiptRef }), { kind: "released" });
  assert.equal(existsSync(privateRootPath), false);
  assert.equal(custody.evidence(opened.custodyRef)?.privateRoot.status, "deleted");
  assert.equal(custody.get(opened.custodyRef), undefined);
  assert.deepEqual(await custody.release({ ...request, custodyRef: opened.custodyRef, receiptRef }), { kind: "released" });
  const replay = await custody.open(request);
  assert.deepEqual(replay, opened);
  assert.equal(custody.get(replay.custodyRef), undefined);
  assert.deepEqual(
    await custody.requestContainment({ ...request, custodyRef: replay.custodyRef }),
    closure,
  );
  searchPath = "/bin:/usr/bin";
  assert.deepEqual(await custody.open(request), opened);
  const evidenceText = JSON.stringify(custody.evidence(opened.custodyRef));
  assert.doesNotMatch(evidenceText, new RegExp(secret, "u"));
  assert.doesNotMatch(receiptRef, new RegExp(secret, "u"));
});

linuxTest("release pressure fails closed before replay retention can become unbounded", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan(workspaceRef, "/usr/bin:/bin", `setInterval(() => {}, 1000);`);
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    maxTombstones: 1,
  });
  const request = {
    attemptId: "attempt:pressure:one",
    operationId: "operation:pressure:one",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const closure = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closure.kind, "contained");
  assert.deepEqual(await custody.release({
    ...request,
    custodyRef: opened.custodyRef,
    receiptRef: closure.kind === "contained" ? closure.receiptRef : "",
  }), { kind: "released" });
  assert.equal(custody.get(opened.custodyRef), undefined);
  await assert.rejects(custody.open({
    attemptId: "attempt:pressure:two",
    operationId: "operation:pressure:two",
    providerBinding: binding,
    workspaceRef,
  }), HostCustodyUnsupportedError);
});

linuxTest("unsupported binding and missing custody return closed typed results without secrets", async () => {
  const workspaceRef = await disposableRoot();
  const empty = new NodeProviderProcessCustody({ launchPlans: createStaticHostCustodyLaunchPlanResolver([]) });
  await assert.rejects(empty.open({
    attemptId: "attempt:unsupported",
    operationId: "operation:unsupported",
    providerBinding: binding,
    workspaceRef,
  }), HostCustodyUnsupportedError);
  const secret = "secret-material-in-input-identity";
  const outcome = await empty.requestContainment({
    attemptId: `attempt:${secret}`,
    operationId: `operation:${secret}`,
  });
  assert.equal(outcome.kind, "unproven");
  assert.match(outcome.kind === "unproven" ? outcome.evidenceRef : "", /host-custody-unproven:missing/u);
  assert.doesNotMatch(outcome.kind === "unproven" ? outcome.evidenceRef : "", new RegExp(secret, "u"));
});

test("TERM signal failure remains exact typed unproven evidence", async () => {
  const originalKill = process.kill;
  process.kill = (() => {throw new Error("synthetic TERM refusal");}) as typeof process.kill;
  try {
    const outcome = await terminateCooperativeProcessGroup({}, {
      alreadyExitedGroup: "present",
      drainAfterMs: 10,
      forceKillAfterMs: 10,
      monotonicNow: () => performance.now(),
      pid: 2_147_483_646,
      processGroupStatus: () => "present",
      signalProcessGroup: async signal => {
        try {process.kill(-2_147_483_646, signal); return "sent";}
        catch {return "unproven";}
      },
      terminateAfterMs: 10,
    });
    assert.deepEqual(outcome, { kind: "unproven", reason: "term-signal-failed" });
  } finally {
    process.kill = originalKill;
  }
});

test("KILL signal failure remains exact typed unproven evidence", async () => {
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, -2_147_483_646);
    if (signal === "SIGKILL") {throw new Error("synthetic KILL refusal");}
    return true;
  }) as typeof process.kill;
  try {
    const outcome = await terminateCooperativeProcessGroup({ exit: new Promise(() => {}) }, {
      alreadyExitedGroup: "present",
      drainAfterMs: 10,
      forceKillAfterMs: 10,
      monotonicNow: () => performance.now(),
      pid: 2_147_483_646,
      processGroupStatus: () => "present",
      signalProcessGroup: async signal => {
        try {process.kill(-2_147_483_646, signal); return "sent";}
        catch {return "unproven";}
      },
      terminateAfterMs: 10,
    });
    assert.deepEqual(outcome, { kind: "unproven", reason: "kill-signal-failed" });
  } finally {
    process.kill = originalKill;
  }
});

test("TERM and KILL observations share their monotonic phase deadlines", async () => {
  const originalKill = process.kill;
  process.kill = (() => true) as typeof process.kill;
  try {
    const startedAt = performance.now();
    const outcome = await terminateCooperativeProcessGroup({ exit: new Promise(() => {}) }, {
      alreadyExitedGroup: "present",
      drainAfterMs: 50,
      forceKillAfterMs: 50,
      monotonicNow: () => performance.now(),
      pid: 2_147_483_646,
      processGroupStatus: () => "present",
      signalProcessGroup: async signal => {
        try {process.kill(-2_147_483_646, signal); return "sent";}
        catch {return "unproven";}
      },
      terminateAfterMs: 50,
    });
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(outcome, { kind: "unproven", reason: "cooperative-closure-unproven" });
    assert.ok(elapsed < 180, `sequential phase waits exceeded the shared deadlines: ${elapsed}ms`);
  } finally {
    process.kill = originalKill;
  }
});
