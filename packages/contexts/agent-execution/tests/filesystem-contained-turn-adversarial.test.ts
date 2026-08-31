import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  createNodeContainedTurnArtifacts,
  createNodeContainedTurnWorkspace,
} from "../dist/production.js";
import { consumeWorkspaceLaunchAuthority } from "../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-capability.js";
import { bindContainedTurnRoot } from "../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-filesystem-custody.js";
import { openBoundDirectories } from "../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-filesystem-handles.js";
import {
  assertNoTemporaryResidue,
  cleanupTrackedFilesystemLayouts,
  createSyntheticFilesystemLayout,
  listRelativeResidue,
} from "./filesystem-contained-turn/fixture.ts";

const execFile = promisify(execFileCallback);
const SCOPE = Object.freeze({ projectId: "project:test", tenantId: "tenant:test" });
const LIMITS = Object.freeze({
  maxDepth: 4, maxEntries: 16, maxFileBytes: 1_024, maxTotalBytes: 16 * 1_024,
});
const LINUX_DURABLE_DIRECTORY_REASON =
  "requires qualified Linux /proc descriptor custody, process locks, and renameat2 publication";
const NON_LINUX_REFUSAL_REASON =
  "exercises the typed refusal boundary only on platforms without qualified durable directory custody";

const linuxDurableDirectoryTest = (
  name: string,
  body: (context: TestContext) => Promise<void> | void,
) => test(name, {
  skip: process.platform === "linux" ? false : LINUX_DURABLE_DIRECTORY_REASON,
}, body);
const crashWorker = fileURLToPath(new URL(
  "./filesystem-contained-turn/crash-worker.ts",
  import.meta.url,
));
const contenderWorker = fileURLToPath(new URL(
  "./filesystem-contained-turn/rehydration-contender-worker.ts",
  import.meta.url,
));
const stagingTransactionWorker = fileURLToPath(new URL(
  "./filesystem-contained-turn/staging-transaction-worker.ts",
  import.meta.url,
));

const waitForFile = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {await access(path); return;} catch {await delay(10);}
  }
  throw new Error(`timed out waiting for contender evidence: ${path}`);
};

const startWorker = (
  worker: string,
  input: object,
): Readonly<{ result: Promise<string> }> => {
  const child = spawn(process.execPath, [worker, JSON.stringify(input)], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => {stdout += chunk;});
    child.stderr.setEncoding("utf8").on("data", chunk => {stderr += chunk;});
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(JSON.parse(stdout.trim()) as string);
      } else {
        reject(new Error(`filesystem test worker failed (${code ?? signal}): ${stderr}`));
      }
    });
  });
  return Object.freeze({ result });
};

const startContender = (input: object): Readonly<{ result: Promise<string> }> =>
  startWorker(contenderWorker, input);

const startStagingTransaction = (input: object): Readonly<{ result: Promise<string> }> =>
  startWorker(stagingTransactionWorker, input);

const runKilledWorker = async (input: object): Promise<void> => {
  const child = spawn(process.execPath, [crashWorker, JSON.stringify(input)], {
    env: process.env,
    stdio: "ignore",
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
};

test.after(cleanupTrackedFilesystemLayouts);

test("current kernel declarations expose only opaque workspace identity", async () => {
  const declarations = (await Promise.all([
    readFile(new URL(
      "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.d.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../dist/production.d.ts", import.meta.url), "utf8"),
  ])).join("\n");
  assert.match(declarations, /ContainedTurnWorkspaceId/u);
  assert.doesNotMatch(declarations, /descriptorPath|stable_directory|mountId|readonly dev:|readonly ino:/u);
});

const assertTypedFilesystemUnsupported = (error: unknown): boolean => {
  assert.ok(error instanceof Error && "code" in error);
  assert.equal(error.name, "ContainedTurnFilesystemUnsupportedError");
  assert.equal(error.code, "ERR_CONTAINED_TURN_FILESYSTEM_UNSUPPORTED");
  assert.match(error.message, /filesystem custody is unsupported/u);
  return true;
};

test("non-Linux workspace factory refuses typed unsupported before filesystem mutation", {
  skip: process.platform === "linux" ? NON_LINUX_REFUSAL_REASON : false,
}, async () => {
  const layout = await createSyntheticFilesystemLayout();
  try {
    const before = await listRelativeResidue(layout.campaignRoot);
    await assert.rejects(
      createNodeContainedTurnWorkspace({ ...layout.workspaceOptions, limits: LIMITS }),
      assertTypedFilesystemUnsupported,
    );
    assert.deepEqual(await listRelativeResidue(layout.campaignRoot), before);
  } finally {
    await layout.cleanup();
  }
});

test("non-Linux artifact factory refuses typed unsupported before filesystem mutation", {
  skip: process.platform === "linux" ? NON_LINUX_REFUSAL_REASON : false,
}, async () => {
  const layout = await createSyntheticFilesystemLayout();
  try {
    const before = await listRelativeResidue(layout.campaignRoot);
    await assert.rejects(
      createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS }),
      assertTypedFilesystemUnsupported,
    );
    assert.deepEqual(await listRelativeResidue(layout.campaignRoot), before);
  } finally {
    await layout.cleanup();
  }
});

linuxDurableDirectoryTest("opaque workspace launch authority is scope-bound, stale-aware, and one-use", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const workspace = await createNodeContainedTurnWorkspace({ ...layout.workspaceOptions, limits: LIMITS });
  const operationId = "operation:retained-capability";
  const created = await workspace.create({ operationId, scope: SCOPE });
  const authority = await workspace.verify({ operationId, scope: SCOPE, workspaceRef: created.workspaceRef });
  assert.deepEqual(Object.keys(authority).toSorted(), ["authorityRef", "kind", "version"]);
  await assert.rejects(consumeWorkspaceLaunchAuthority({
    authority, operationId, scope: { ...SCOPE, projectId: "project:other" },
    workspaceRef: created.workspaceRef,
  }, async () => {}), /scope mismatch/u);
  const displaced = `${created.workspaceRef}-displaced`;
  await rename(created.workspaceRef, displaced);
  await mkdir(created.workspaceRef, { mode: 0o700 });
  await assert.rejects(consumeWorkspaceLaunchAuthority({
    authority, operationId, scope: SCOPE, workspaceRef: created.workspaceRef,
  }, async () => {}), /is stale/u);
  await assert.rejects(consumeWorkspaceLaunchAuthority({
    authority, operationId, scope: SCOPE, workspaceRef: created.workspaceRef,
  }, async () => {}), /stale or already consumed/u);

  await rename(created.workspaceRef, `${created.workspaceRef}-unknown`);
  await rename(displaced, created.workspaceRef);
  const second = await workspace.verify({ operationId, scope: SCOPE, workspaceRef: created.workspaceRef });
  const target = await consumeWorkspaceLaunchAuthority({
    authority: second, operationId, scope: SCOPE, workspaceRef: created.workspaceRef,
  }, async resolved => ({ ...resolved, descriptorPath: resolved.descriptorPath }));
  assert.match(target.descriptorPath, /^\/proc\/self\/fd\/\d+$/u);
  await assert.rejects(stat(target.descriptorPath), error =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  );
  await assert.rejects(consumeWorkspaceLaunchAuthority({
    authority: second, operationId, scope: SCOPE, workspaceRef: created.workspaceRef,
  }, async () => {}), /stale or already consumed/u);

  const cancelled = await workspace.verify({
    operationId, scope: SCOPE, workspaceRef: created.workspaceRef,
  });
  let cancelledDescriptor = "";
  await assert.rejects(consumeWorkspaceLaunchAuthority({
    authority: cancelled, operationId, scope: SCOPE, workspaceRef: created.workspaceRef,
  }, async resolved => {
    cancelledDescriptor = resolved.descriptorPath;
    throw new Error("cancelled launch callback");
  }), /cancelled launch callback/u);
  assert.match(cancelledDescriptor, /^\/proc\/self\/fd\/\d+$/u);
  await assert.rejects(stat(cancelledDescriptor), error =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  );
  await layout.cleanup();
});

linuxDurableDirectoryTest("unknown empty rehydration destination is quarantined instead of promoted", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const workspace = await createNodeContainedTurnWorkspace({ ...layout.workspaceOptions, limits: LIMITS });
  const artifacts = await createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS });
  const operationId = "operation:unknown-empty-rehydration";
  const created = await workspace.create({ operationId, scope: SCOPE });
  const sealed = await artifacts.seal({ operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef });
  const digest = sealed.resultRef.split(":").at(-1);
  assert.ok(digest);
  assert.match(digest, /^[a-f\d]{64}$/u);
  const finalPath = join(layout.rehydrationRoot, "results", digest);
  await mkdir(finalPath, { mode: 0o700 });

  assert.equal(await artifacts.rehydrate({ operationId, resultRef: sealed.resultRef, scope: SCOPE }), finalPath);
  const quarantined = await readdir(join(layout.rehydrationRoot, "quarantine"));
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0] ?? "", new RegExp(`^\\.rehydrate-${digest}-.+\\.unknown$`, "u"));
  await layout.cleanup();
});

linuxDurableDirectoryTest("same-UID staging residue is retained in stable no-replace quarantine", async () => {
  const layout = await createSyntheticFilesystemLayout();
  await createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS });
  const residueName = ".ar-stage-v1-cas-00000000-0000-4000-8000-000000000000.tmp";
  await writeFile(join(layout.artifactRoot, "staging", residueName), "ambiguous-owner", { mode: 0o600 });
  await createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS });
  assert.deepEqual(await readdir(join(layout.artifactRoot, "staging")), []);
  const retained = await readdir(join(layout.artifactRoot, "staging-quarantine"));
  assert.equal(retained.length, 1);
  assert.equal(await readFile(join(layout.artifactRoot, "staging-quarantine", retained[0] as string), "utf8"), "ambiguous-owner");
  await layout.cleanup();
});

linuxDurableDirectoryTest("artifact startup scavenging cannot move an active CAS staging file", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const workspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions, limits: LIMITS,
  });
  await createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS });
  const operationId = "operation:active-cas-staging";
  const created = await workspace.create({ operationId, scope: SCOPE });
  await writeFile(join(created.workspaceRef, "result"), "active-cas", { mode: 0o600 });
  const transaction = startStagingTransaction({
    action: "seal",
    artifactOptions: { ...layout.artifactOptions, limits: LIMITS },
    barrierRoot: layout.campaignRoot,
    operationId,
    pausePoint: "artifact.blob.cas.opened",
    scope: SCOPE,
    workspaceRef: created.workspaceRef,
  });
  await waitForFile(join(layout.campaignRoot, "transaction-initialized"));
  await writeFile(join(layout.campaignRoot, "transaction-start"), "start", { flag: "wx" });
  await waitForFile(join(layout.campaignRoot, "transaction-ready"));

  let reportContention = (): void => undefined;
  const contention = new Promise<void>(resolve => {reportContention = resolve;});
  const restarted = createNodeContainedTurnArtifacts({
    ...layout.artifactOptions,
    limits: LIMITS,
    testFaults: {
      checkpoint(point) {
        if (point === "artifact.cas-startup.exclusion-waiting") {reportContention();}
      },
    },
  });
  await contention;
  assert.equal((await readdir(join(layout.artifactRoot, "staging"))).length, 1);
  assert.deepEqual(await readdir(join(layout.artifactRoot, "staging-quarantine")), []);
  await writeFile(join(layout.campaignRoot, "transaction-release"), "release", { flag: "wx" });
  const resultRef = await transaction.result;
  const recovered = await restarted;
  assert.equal((await recovered.verify({ operationId, resultRef, scope: SCOPE })).operationId, operationId);
  assert.deepEqual(await readdir(join(layout.artifactRoot, "staging")), []);
  assert.deepEqual(await readdir(join(layout.artifactRoot, "staging-quarantine")), []);
  await layout.cleanup();
});

linuxDurableDirectoryTest("workspace startup scavenging cannot move an active metadata staging file", async () => {
  const layout = await createSyntheticFilesystemLayout();
  await createNodeContainedTurnWorkspace({ ...layout.workspaceOptions, limits: LIMITS });
  const operationId = "operation:active-workspace-metadata";
  const transaction = startStagingTransaction({
    action: "workspace-create",
    barrierRoot: layout.campaignRoot,
    operationId,
    pausePoint: "workspace.creation.metadata.opened",
    scope: SCOPE,
    workspaceOptions: { ...layout.workspaceOptions, limits: LIMITS },
  });
  await waitForFile(join(layout.campaignRoot, "transaction-initialized"));
  await writeFile(join(layout.campaignRoot, "transaction-start"), "start", { flag: "wx" });
  await waitForFile(join(layout.campaignRoot, "transaction-ready"));

  let reportContention = (): void => undefined;
  const contention = new Promise<void>(resolve => {reportContention = resolve;});
  const restarted = createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions,
    limits: LIMITS,
    testFaults: {
      checkpoint(point) {
        if (point === "workspace.staging-startup.exclusion-waiting") {reportContention();}
      },
    },
  });
  await contention;
  assert.equal((await readdir(join(layout.workspaceRoot, "staging"))).length, 1);
  assert.deepEqual(await readdir(join(layout.workspaceRoot, "staging-quarantine")), []);
  await writeFile(join(layout.campaignRoot, "transaction-release"), "release", { flag: "wx" });
  const workspaceRef = await transaction.result;
  await restarted;
  assert.equal((await stat(workspaceRef)).isDirectory(), true);
  assert.deepEqual(await readdir(join(layout.workspaceRoot, "staging")), []);
  assert.deepEqual(await readdir(join(layout.workspaceRoot, "staging-quarantine")), []);
  await layout.cleanup();
});

linuxDurableDirectoryTest("rehydration recovers every new durable intent and publication crash boundary", async () => {
  const points = [
    "artifact.rehydrate.created",
    "artifact.rehydrate.verified",
    "artifact.rehydrate-record.metadata.published",
    "artifact.rehydrate.intent-recorded",
    "artifact.rehydrate.publish.source-bound",
    "artifact.rehydrate.publish.published",
  ] as const;
  for (const [index, faultPoint] of points.entries()) {
    const layout = await createSyntheticFilesystemLayout();
    const workspace = await createNodeContainedTurnWorkspace({ ...layout.workspaceOptions, limits: LIMITS });
    const artifacts = await createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS });
    const operationId = `operation:rehydration-crash:${index}`;
    const created = await workspace.create({ operationId, scope: SCOPE });
    await writeFile(join(created.workspaceRef, "result"), `result-${index}`, { mode: 0o600 });
    const sealed = await artifacts.seal({
      operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef,
    });
    await runKilledWorker({
      action: "rehydrate",
      artifactOptions: { ...layout.artifactOptions, limits: LIMITS },
      faultPoint,
      operationId,
      resultRef: sealed.resultRef,
      scope: SCOPE,
      workspaceOptions: { ...layout.workspaceOptions, limits: LIMITS },
    });
    const restarted = await createNodeContainedTurnArtifacts({
      ...layout.artifactOptions,
      limits: LIMITS,
    });
    const rehydrated = await restarted.rehydrate({
      operationId, resultRef: sealed.resultRef, scope: SCOPE,
    });
    assert.equal(await readFile(join(rehydrated, "result"), "utf8"), `result-${index}`);
    await layout.cleanup();
  }
});

linuxDurableDirectoryTest("cross-process rehydration contenders converge through shared staging exclusion", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const workspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions, limits: LIMITS,
  });
  const artifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions, limits: LIMITS,
  });
  const operationId = "operation:cross-process-rehydration";
  const created = await workspace.create({ operationId, scope: SCOPE });
  await writeFile(join(created.workspaceRef, "result"), "contended", { mode: 0o600 });
  const sealed = await artifacts.seal({
    operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef,
  });
  const common = {
    artifactOptions: { ...layout.artifactOptions, limits: LIMITS },
    barrierRoot: layout.campaignRoot,
    operationId,
    resultRef: sealed.resultRef,
    scope: SCOPE,
  };
  const owner = startContender({ ...common, role: "owner" });
  const loser = startContender({ ...common, role: "loser" });
  await Promise.all([
    waitForFile(join(layout.campaignRoot, "owner-initialized")),
    waitForFile(join(layout.campaignRoot, "loser-initialized")),
  ]);
  await writeFile(join(layout.campaignRoot, "owner-start"), "start", { flag: "wx" });
  await waitForFile(join(layout.campaignRoot, "owner-ready"));
  await writeFile(join(layout.campaignRoot, "loser-start"), "start", { flag: "wx" });
  await writeFile(join(layout.campaignRoot, "owner-release"), "release", { flag: "wx" });
  const published = await owner.result;
  assert.equal(await loser.result, published);
  assert.equal(await readFile(join(published, "result"), "utf8"), "contended");
  await layout.cleanup();
});

linuxDurableDirectoryTest("startup scavenging waits for staging-to-intent publication in another process", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const workspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions, limits: LIMITS,
  });
  const artifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions, limits: LIMITS,
  });
  const operationId = "operation:startup-during-rehydration";
  const created = await workspace.create({ operationId, scope: SCOPE });
  await writeFile(join(created.workspaceRef, "result"), "live-staging", { mode: 0o600 });
  const sealed = await artifacts.seal({
    operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef,
  });
  const common = {
    artifactOptions: { ...layout.artifactOptions, limits: LIMITS },
    barrierRoot: layout.campaignRoot,
    operationId,
    resultRef: sealed.resultRef,
    scope: SCOPE,
  };
  const owner = startContender({ ...common, role: "owner" });
  await waitForFile(join(layout.campaignRoot, "owner-initialized"));
  await writeFile(join(layout.campaignRoot, "owner-start"), "start", { flag: "wx" });
  await waitForFile(join(layout.campaignRoot, "owner-ready"));

  const restarted = startContender({ ...common, role: "late" });
  await waitForFile(join(layout.campaignRoot, "late-ready"));
  await writeFile(join(layout.campaignRoot, "late-release"), "release", { flag: "wx" });
  await delay(100);
  await assert.rejects(access(join(layout.campaignRoot, "late-initialized")));
  await writeFile(join(layout.campaignRoot, "owner-release"), "release", { flag: "wx" });
  const published = await owner.result;
  await waitForFile(join(layout.campaignRoot, "late-initialized"));
  await writeFile(join(layout.campaignRoot, "late-start"), "start", { flag: "wx" });
  assert.equal(await restarted.result, published);
  assert.equal(await readFile(join(published, "result"), "utf8"), "live-staging");
  assert.deepEqual(await readdir(join(layout.rehydrationRoot, "staging")), []);
  assert.deepEqual(await readdir(join(layout.rehydrationRoot, "quarantine")), []);
  await layout.cleanup();
});

linuxDurableDirectoryTest("rehydration staging exclusion remains held through final publication verification", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const workspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions, limits: LIMITS,
  });
  const artifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions, limits: LIMITS,
  });
  const operationId = "operation:publication-exclusion";
  const created = await workspace.create({ operationId, scope: SCOPE });
  await writeFile(join(created.workspaceRef, "result"), "publication-locked", { mode: 0o600 });
  const sealed = await artifacts.seal({
    operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef,
  });
  const common = {
    artifactOptions: { ...layout.artifactOptions, limits: LIMITS },
    barrierRoot: layout.campaignRoot,
    operationId,
    resultRef: sealed.resultRef,
    scope: SCOPE,
  };
  const owner = startContender({
    ...common,
    pausePoint: "artifact.rehydrate.publish.published",
    role: "owner",
  });
  await waitForFile(join(layout.campaignRoot, "owner-initialized"));
  await writeFile(join(layout.campaignRoot, "owner-start"), "start", { flag: "wx" });
  await waitForFile(join(layout.campaignRoot, "owner-ready"));

  const restarted = startContender({ ...common, role: "late" });
  await waitForFile(join(layout.campaignRoot, "late-ready"));
  await writeFile(join(layout.campaignRoot, "late-release"), "release", { flag: "wx" });
  await delay(100);
  await assert.rejects(access(join(layout.campaignRoot, "late-initialized")));
  await writeFile(join(layout.campaignRoot, "owner-release"), "release", { flag: "wx" });
  const published = await owner.result;
  await waitForFile(join(layout.campaignRoot, "late-initialized"));
  await writeFile(join(layout.campaignRoot, "late-start"), "start", { flag: "wx" });
  assert.equal(await restarted.result, published);
  assert.equal(await readFile(join(published, "result"), "utf8"), "publication-locked");
  await layout.cleanup();
});

linuxDurableDirectoryTest("partial parallel bound-directory acquisition closes every successful descriptor", async () => {
  const layout = await createSyntheticFilesystemLayout();
  await createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS });
  const staging = await bindContainedTurnRoot(join(layout.artifactRoot, "staging"), {
    private: true,
  });
  const quarantine = await bindContainedTurnRoot(
    join(layout.artifactRoot, "staging-quarantine"), { private: true },
  );
  const mismatched = Object.freeze({
    ...quarantine,
    identity: Object.freeze({ ...quarantine.identity, ino: quarantine.identity.ino + 1n }),
  });
  const successful = await openBoundDirectories([staging, quarantine]);
  for (const handle of successful.toReversed()) {await handle.close();}
  for (const handle of successful) {
    await assert.rejects(handle.stat(), error =>
      typeof error === "object" && error !== null && "code" in error && error.code === "EBADF"
    );
  }
  await assert.rejects(openBoundDirectories([staging, quarantine, mismatched]));
  const before = (await readdir("/proc/self/fd")).length;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    await assert.rejects(openBoundDirectories([staging, quarantine, mismatched]));
  }
  assert.equal((await readdir("/proc/self/fd")).length, before);
  await layout.cleanup();
});

linuxDurableDirectoryTest("filesystem fault port fails closed for permission and capacity write denials", async t => {
  for (const code of ["EACCES", "ENOSPC", "EDQUOT"] as const) {
    await t.test(code, async () => {
      const layout = await createSyntheticFilesystemLayout();
      const injected = Object.assign(new Error(`injected ${code}`), { code });
      const faults = code === "EACCES" ? Object.freeze({
        checkpoint: (): void => undefined,
        openFile: async (): Promise<never> => {throw injected;},
      }) : Object.freeze({
        checkpoint: (): void => undefined,
        writeFile: async (): Promise<never> => {throw injected;},
      });
      const workspace = await createNodeContainedTurnWorkspace({
        ...layout.workspaceOptions, limits: LIMITS,
      });
      const faulting = await createNodeContainedTurnArtifacts({
        ...layout.artifactOptions, limits: LIMITS, testFaults: faults,
      });
      const operationId = `operation:filesystem-fault:${code}`;
      const created = await workspace.create({ operationId, scope: SCOPE });
      await writeFile(join(created.workspaceRef, "result"), code, { mode: 0o600 });
      await assert.rejects(
        faulting.seal({
          operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef,
        }),
        error => error === injected && "code" in error && error.code === code,
      );
      await assertNoTemporaryResidue(layout.artifactRoot);
      const restarted = await createNodeContainedTurnArtifacts({
        ...layout.artifactOptions, limits: LIMITS,
      });
      const sealed = await restarted.seal({
        operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef,
      });
      assert.equal((await restarted.verify({
        operationId, resultRef: sealed.resultRef, scope: SCOPE,
      })).operationId, operationId);
      await layout.cleanup();
    });
  }
});

linuxDurableDirectoryTest("no-replace workspace publication preserves inserted destination and detects source replacement", async () => {
  const destinationLayout = await createSyntheticFilesystemLayout();
  let insertedPath = "";
  const destinationWorkspace = await createNodeContainedTurnWorkspace({
    ...destinationLayout.workspaceOptions,
    limits: LIMITS,
    testFaults: {
      async checkpoint(point) {
        if (point !== "workspace.create.publish.source-bound" || insertedPath !== "") {return;}
        const [name] = await readdir(join(destinationLayout.workspaceRoot, "materializing"));
        assert.ok(name);
        insertedPath = join(destinationLayout.workspaceRoot, "active", name);
        await mkdir(insertedPath, { mode: 0o700 });
        await writeFile(join(insertedPath, "unknown"), "inserted", { mode: 0o600 });
      },
    },
  });
  await assert.rejects(
    destinationWorkspace.create({ operationId: "operation:destination-insert", scope: SCOPE }),
    /destination already exists|creation and cleanup failed/u,
  );
  assert.equal(await readFile(join(insertedPath, "unknown"), "utf8"), "inserted");

  const sourceLayout = await createSyntheticFilesystemLayout();
  let displacedPath = "";
  const sourceWorkspace = await createNodeContainedTurnWorkspace({
    ...sourceLayout.workspaceOptions,
    limits: LIMITS,
    testFaults: {
      async checkpoint(point) {
        if (point !== "workspace.create.publish.source-bound" || displacedPath !== "") {return;}
        const parent = join(sourceLayout.workspaceRoot, "materializing");
        const [name] = await readdir(parent);
        assert.ok(name);
        displacedPath = join(parent, `${name}.owned`);
        await rename(join(parent, name), displacedPath);
        await mkdir(join(parent, name), { mode: 0o700 });
      },
    },
  });
  await assert.rejects(
    sourceWorkspace.create({ operationId: "operation:source-replace", scope: SCOPE }),
    /source changed|source identity was replaced|creation and cleanup failed/u,
  );
  assert.equal((await stat(displacedPath)).isDirectory(), true);
  await Promise.all([destinationLayout.cleanup(), sourceLayout.cleanup()]);
});

linuxDurableDirectoryTest("workspace traversal rejects FIFO, socket, and device nodes", async t => {
  const cases = ["fifo", "socket", "device"] as const;
  for (const kind of cases) {
    await t.test(kind, async child => {
      const layout = await createSyntheticFilesystemLayout();
      const workspace = await createNodeContainedTurnWorkspace({ ...layout.workspaceOptions, limits: LIMITS });
      const artifacts = await createNodeContainedTurnArtifacts({ ...layout.artifactOptions, limits: LIMITS });
      const operationId = `operation:special-node:${kind}`;
      const created = await workspace.create({ operationId, scope: SCOPE });
      const path = join(created.workspaceRef, kind);
      let server: ReturnType<typeof createServer> | undefined;
      try {
        if (kind === "fifo") {await execFile("/usr/bin/mkfifo", [path]);}
        if (kind === "device") {
          try {await execFile("/usr/bin/mknod", [path, "c", "1", "3"]);} catch {
            child.skip("the disposable runner cannot create a device fixture");
            return;
          }
        }
        if (kind === "socket") {
          server = createServer();
          const shortSocketPath = join(layout.disposableRoot, "special-node.sock");
          const previousDirectory = process.cwd();
          try {
            process.chdir(layout.disposableRoot);
            await new Promise<void>((resolve, reject) => {
              server?.once("error", reject);
              server?.listen("special-node.sock", resolve);
            });
          } catch (error) {
            process.chdir(previousDirectory);
            if (!(error instanceof Error && "code" in error &&
              (error.code === "EACCES" || error.code === "EPERM"))) {throw error;}
            server = undefined;
            child.skip("the disposable runner cannot create a Unix socket fixture");
            return;
          }
          try {await rename(shortSocketPath, path);} finally {
            process.chdir(previousDirectory);
          }
        }
        await assert.rejects(
          artifacts.seal({ operationId, output: [], scope: SCOPE, workspaceRef: created.workspaceRef }),
          /contained turn workspace contains a non-file entry/u,
        );
      } finally {
        if (server !== undefined) {
          await new Promise<void>(resolve => {
            server.close(() => {resolve();});
          });
        }
        await layout.cleanup();
      }
    });
  }
});
