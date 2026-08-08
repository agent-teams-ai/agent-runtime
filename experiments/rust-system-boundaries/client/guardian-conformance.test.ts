import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  CURRENT_PROTOCOL_VERSION,
  GuardianClient,
  MAX_FRAME_BYTES,
  RESPONSE_TIMEOUT_MS,
  asInteger,
  asRecord,
  assertResponseMatchesRequest,
  guardianArtifacts,
  execFile,
  inspectRequest,
  observed,
  parseResponse,
  queryRequest,
  repositoryDirectory,
  spawnRequest,
  terminateRequest,
  v1SpawnRequest,
  type OsProcessSnapshot,
  type SyntheticProcessEvidence,
} from "./guardian-test-support.ts";

const inspectProcess = async (pid: number): Promise<OsProcessSnapshot> => {
  if (process.platform === "win32") {
    const { stdout } = await execFile(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { cwd: repositoryDirectory },
    );
    const match = stdout.trim().match(/^"([^"]+)","([0-9]+)"/);
    if (match === null || Number(match[2]) !== pid) {
      return { pid, alive: false, processGroupId: null, state: null, command: null };
    }
    return {
      pid,
      alive: true,
      processGroupId: null,
      state: null,
      command: match[1] ?? null,
    };
  }

  try {
    const { stdout } = await execFile(
      "ps",
      ["-p", String(pid), "-o", "pgid=", "-o", "stat=", "-o", "command="],
      { cwd: repositoryDirectory },
    );
    const match = stdout.trim().match(/^([0-9]+)\s+(\S+)\s+(.+)$/);
    if (match === null) {
      return { pid, alive: false, processGroupId: null, state: null, command: null };
    }
    return {
      pid,
      alive: true,
      processGroupId: Number(match[1]),
      state: match[2] ?? null,
      command: match[3] ?? null,
    };
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === "ESRCH") {
      return { pid, alive: false, processGroupId: null, state: null, command: null };
    }
    throw error;
  }
};

const assertSyntheticIdentity = (snapshot: OsProcessSnapshot): void => {
  if (!snapshot.alive) {
    return;
  }
  const command = snapshot.command ?? "";
  const fixtureName = basename(guardianArtifacts().fixtureChild).toLowerCase();
  const matchesFixture =
    process.platform === "win32"
      ? command.toLowerCase() === fixtureName
      : command.includes(guardianArtifacts().fixtureChild);
  assert.ok(
    matchesFixture,
    `refusing to treat PID ${snapshot.pid} as synthetic fixture: ${command || "unknown command"}`,
  );
};

const inspectSyntheticProcesses = async (
  evidence: SyntheticProcessEvidence,
): Promise<[OsProcessSnapshot, OsProcessSnapshot]> => {
  const [root, descendant] = await Promise.all([
    inspectProcess(evidence.rootPid),
    inspectProcess(evidence.descendantPid),
  ]);
  return [root, descendant];
};

const assertSyntheticProcessesGone = async (
  evidence: SyntheticProcessEvidence,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let snapshots = await inspectSyntheticProcesses(evidence);
  while (snapshots.some((snapshot) => snapshot.alive) && Date.now() < deadline) {
    await delay(25);
    snapshots = await inspectSyntheticProcesses(evidence);
  }
  const survivors = snapshots.filter((snapshot) => snapshot.alive);
  assert.equal(
    survivors.length,
    0,
    `synthetic processes survived teardown: ${survivors
      .map(
        (snapshot) =>
          `pid=${snapshot.pid} pgid=${String(snapshot.processGroupId)} state=${String(
            snapshot.state,
          )} command=${String(snapshot.command)}`,
      )
      .join("; ")}`,
  );
};

const waitForSyntheticProcessEvidence = async (
  stateRoot: string,
  operationId: string,
): Promise<SyntheticProcessEvidence> => {
  const custodyPath = join(stateRoot, "custody", `${operationId}.json`);
  const descendantPath = join(stateRoot, "operations", operationId, "descendant.pid");
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const custody = asRecord(
        JSON.parse(await readFile(custodyPath, "utf8")) as unknown,
        "durable custody witness",
      );
      assert.equal(custody.state, "live");
      assert.equal(custody.spawn_attempts, 1);
      const rootPid = asInteger(custody.pid, "custody root pid");
      const recordedProcessGroupId =
        custody.process_group_id === null
          ? null
          : asInteger(custody.process_group_id, "custody process group id");
      const descendantPid = Number((await readFile(descendantPath, "utf8")).trim());
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

      // The fixture emits its bounded-output burst immediately after publishing
      // the descendant PID. Keep Guardian's pipe readers alive until it finishes.
      await delay(200);
      const evidence = { rootPid, descendantPid, recordedProcessGroupId };
      const [root, descendant] = await inspectSyntheticProcesses(evidence);
      assert.equal(root.alive, true, "synthetic root must be live before Guardian crash");
      assert.equal(descendant.alive, true, "synthetic descendant must be live before Guardian crash");
      assertSyntheticIdentity(root);
      assertSyntheticIdentity(descendant);
      if (process.platform !== "win32") {
        assert.equal(recordedProcessGroupId, rootPid, "recorded PGID must identify the root");
        assert.equal(root.processGroupId, recordedProcessGroupId, "root must be in recorded PGID");
        assert.equal(
          descendant.processGroupId,
          recordedProcessGroupId,
          "descendant must initially inherit the recorded PGID",
        );
      }
      return evidence;
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  throw new Error("synthetic fixture did not publish complete live PID evidence", {
    cause: lastError,
  });
};

const requestGuardianTermination = async (
  preferredClient: GuardianClient | undefined,
  stateRoot: string,
  operationId: string,
  opaqueFence: string,
): Promise<void> => {
  let client = preferredClient;
  let ownsClient = false;
  try {
    if (client === undefined || client.exited) {
      client = await GuardianClient.start(stateRoot);
      ownsClient = true;
    }
    const response = await client.request(
      terminateRequest("cleanup-terminate", operationId, opaqueFence),
    );
    if (response.result.status !== "terminated" && response.result.status !== "reconcile_gone") {
      throw new Error(`cleanup did not reach a terminal custody state: ${response.result.status}`);
    }
  } catch (firstError) {
    if (client !== undefined && !client.exited) {
      await client.crash().catch(() => {});
    }
    const recovery = await GuardianClient.start(stateRoot);
    try {
      const response = await recovery.request(
        terminateRequest("cleanup-recovery-terminate", operationId, opaqueFence),
      );
      if (response.result.status !== "terminated" && response.result.status !== "reconcile_gone") {
        throw new Error(
          `recovery cleanup did not reach a terminal custody state: ${response.result.status}`,
          { cause: firstError },
        );
      }
    } catch (recoveryError) {
      throw new Error("Guardian cleanup did not produce a terminal response", {
        cause: recoveryError,
      });
    } finally {
      await recovery.close().catch(() => {});
    }
  } finally {
    if (ownsClient && client !== undefined) {
      await client.close().catch(() => {});
    }
  }
};

const cleanupSyntheticOperation = async (
  preferredClient: GuardianClient | undefined,
  stateRoot: string,
  operationId: string,
  opaqueFence: string,
  evidence: SyntheticProcessEvidence,
): Promise<void> => {
  const failures: unknown[] = [];
  try {
    await requestGuardianTermination(preferredClient, stateRoot, operationId, opaqueFence);
  } catch (error) {
    failures.push(error);
  }
  try {
    await assertSyntheticProcessesGone(evidence, 1_000);
    return;
  } catch (error) {
    failures.push(error);
  }
  throw new AggregateError(
    failures,
    `Guardian cleanup failed closed; synthetic evidence retained at ${stateRoot}`,
  );
};

test("TypeScript response decoder rejects schema drift", () => {
  const valid = {
    protocol_version: CURRENT_PROTOCOL_VERSION,
    request_id: "inspect",
    result: {
      status: "containment",
      report: {
        mechanism: "unix_process_group",
        qualified_for_bounded_fixture: true,
        limitation: null,
      },
    },
  };

  assert.equal(parseResponse(JSON.stringify(valid)).result.status, "containment");
  assert.throws(
    () => parseResponse(JSON.stringify({ ...valid, unexpected: true })),
    /closed-world schema/,
  );
  assert.throws(
    () =>
      parseResponse(
        JSON.stringify({
          ...valid,
          result: { ...valid.result, unexpected: true },
        }),
      ),
    /closed-world schema/,
  );

  const mismatchedCorrelatedResponse = parseResponse(
    JSON.stringify({
      ...valid,
      protocol_version: 1,
    }),
  );
  assert.throws(
    () =>
      assertResponseMatchesRequest(
        inspectRequest("inspect", CURRENT_PROTOCOL_VERSION),
        mismatchedCorrelatedResponse,
      ),
    /must use the request protocol version/,
  );
});

test(
  "frozen N-1 TypeScript request shape runs against the current Guardian",
  { timeout: 90_000 },
  async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agent-runtime-guardian-v1-client-"));
    const operationId = `ts-v1-${process.pid}-${Date.now()}`;
    const opaqueFence = `v1-fence-${process.pid}-${Date.now()}`;
    let client: GuardianClient | undefined;
    let evidence: SyntheticProcessEvidence | undefined;
    let testError: unknown;

    try {
      client = await GuardianClient.start(stateRoot);
      const spawned = await client.request(
        v1SpawnRequest("v1-spawn", operationId, opaqueFence),
      );
      assert.equal(spawned.protocol_version, 1);
      observed(spawned.result, "spawned");
      evidence = await waitForSyntheticProcessEvidence(stateRoot, operationId);

      const terminated = await client.request(
        terminateRequest("v1-terminate", operationId, opaqueFence, 1),
      );
      assert.equal(terminated.protocol_version, 1);
      observed(terminated.result, "terminated");
      await assertSyntheticProcessesGone(evidence);
    } catch (error) {
      testError = error;
    }

    let cleanupError: unknown;
    if (evidence !== undefined) {
      try {
        await cleanupSyntheticOperation(
          client,
          stateRoot,
          operationId,
          opaqueFence,
          evidence,
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    await client?.close().catch(() => {});
    if (cleanupError === undefined) {
      await rm(stateRoot, { recursive: true, force: true });
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "N-1 test and exact synthetic cleanup failed",
      );
    }
    if (testError !== undefined) {
      throw testError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  },
);

test(
  "TypeScript caller preserves one operation identity across Guardian process loss",
  { timeout: 60_000 },
  async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agent-runtime-guardian-client-"));
    const operationId = `ts-ambiguous-${process.pid}-${Date.now()}`;
    const opaqueFence = `opaque-fence-${process.pid}-${Date.now()}`;
    let firstGuardian: GuardianClient | undefined;
    let restartedGuardian: GuardianClient | undefined;
    let processEvidence: SyntheticProcessEvidence | undefined;
    let spawned = false;
    let livenessProven = false;
    let testError: unknown;

    try {
      firstGuardian = await GuardianClient.start(stateRoot);

      const current = await firstGuardian.request(inspectRequest("inspect-n", 2));
      assert.equal(current.protocol_version, 2);
      assert.equal(current.result.status, "containment");

      const previous = await firstGuardian.request(inspectRequest("inspect-n-minus-1", 1));
      assert.equal(previous.protocol_version, 1);
      assert.equal(previous.result.status, "containment");

      const newer = await firstGuardian.request(inspectRequest("inspect-n-plus-1", 3));
      assert.equal(newer.request_id, null);
      assert.equal(newer.result.status, "protocol_rejected");
      if (newer.result.status === "protocol_rejected") {
        assert.equal(newer.result.code, "unsupported_version");
      }

      await firstGuardian.sendRaw(
        '{"protocol_version":2,"request_id":"malformed","unexpected":true,"command":{"kind":"inspect_containment"}}',
      );
      const malformed = await firstGuardian.nextResponse(RESPONSE_TIMEOUT_MS, "malformed response");
      assert.equal(malformed.request_id, null);
      assert.equal(malformed.result.status, "protocol_rejected");
      if (malformed.result.status === "protocol_rejected") {
        assert.equal(malformed.result.code, "malformed_frame");
      }

      await firstGuardian.sendRaw("x".repeat(MAX_FRAME_BYTES + 1));
      const oversized = await firstGuardian.nextResponse(RESPONSE_TIMEOUT_MS, "oversized response");
      assert.equal(oversized.request_id, null);
      assert.equal(oversized.result.status, "protocol_rejected");
      if (oversized.result.status === "protocol_rejected") {
        assert.equal(oversized.result.code, "frame_too_large");
      }

      const transportStillHealthy = await firstGuardian.request(
        inspectRequest("inspect-after-rejections", CURRENT_PROTOCOL_VERSION),
      );
      assert.equal(transportStillHealthy.result.status, "containment");

      spawned = true;
      await firstGuardian.send(
        spawnRequest("spawn-lost-response", operationId, opaqueFence, true),
      );
      await assert.rejects(
        firstGuardian.nextResponse(250, "intentionally dropped spawn response"),
        /timed out/,
      );

      processEvidence = await waitForSyntheticProcessEvidence(stateRoot, operationId);

      await firstGuardian.crash();
      restartedGuardian = await GuardianClient.start(stateRoot);

      const reconciled = await restartedGuardian.request(
        queryRequest("reconcile-after-guardian-crash", operationId),
      );
      // KILL_ON_JOB_CLOSE reaps Windows fixtures with the Guardian; POSIX process
      // groups outlive the Guardian and must be reconciled by the replacement.
      const expectedReconciliation =
        process.platform === "win32" ? "reconcile_gone" : "reconcile_verified_live";
      const reconciledObservation = observed(reconciled.result, expectedReconciliation);
      assert.equal(reconciledObservation.operation_id, operationId);
      assert.equal(reconciledObservation.spawn_attempts, 1);
      assert.equal(reconciledObservation.pid, processEvidence.rootPid);

      const retry = await restartedGuardian.request(
        spawnRequest("would-be-retry", operationId, opaqueFence, false),
      );
      const retryObservation = observed(retry.result, "operation_already_exists");
      assert.equal(retryObservation.custody_id, reconciledObservation.custody_id);
      assert.equal(retryObservation.pid, reconciledObservation.pid);
      assert.equal(retryObservation.spawn_attempts, 1);

      const terminated = await restartedGuardian.request(
        terminateRequest("terminate-matching-fence", operationId, opaqueFence),
      );
      const expectedTermination = process.platform === "win32" ? "reconcile_gone" : "terminated";
      const terminatedObservation = observed(terminated.result, expectedTermination);
      assert.equal(terminatedObservation.custody_id, reconciledObservation.custody_id);
      if (process.platform !== "win32") {
        assert.equal(terminatedObservation.state, "terminated");
      }
      await assertSyntheticProcessesGone(processEvidence);
      livenessProven = true;
    } catch (error) {
      testError = error;
    }

    let cleanupError: unknown;
    if (spawned) {
      try {
        processEvidence ??= await waitForSyntheticProcessEvidence(stateRoot, operationId);
        if (!livenessProven) {
          await cleanupSyntheticOperation(
            restartedGuardian ?? firstGuardian,
            stateRoot,
            operationId,
            opaqueFence,
            processEvidence,
          );
        }
        await assertSyntheticProcessesGone(processEvidence, 1_000);
      } catch (error) {
        cleanupError = error;
      }
    }

    await restartedGuardian?.close().catch(() => {});
    await firstGuardian?.close().catch(() => {});
    if (cleanupError === undefined) {
      await rm(stateRoot, { recursive: true, force: true });
    }

    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([testError, cleanupError], "test and exact synthetic cleanup failed");
    }
    if (testError !== undefined) {
      throw testError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  },
);
