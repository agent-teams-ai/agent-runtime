import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  createCodexAppServerPermissionBoundary,
  createCodexCurrentKernelOwner,
  NodeProviderProcessCustody,
} from "../../dist/composition.js";
import { CODEX_APP_SERVER_BINARY_SHA256 } from "../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT } from "../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import { digestContainedTurnCanonicalValue } from "../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const requiredEnvironment = name => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {throw new Error(`missing ${name}`);}
  return value;
};
const contains = (parent, candidate) => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
const assertRegularFile = async path => {
  const entry = await lstat(path);
  assert.equal(entry.isFile() && !entry.isSymbolicLink(), true);
};
const assertPrivateDirectory = async path => {
  const [entry, directory, canonical] = await Promise.all([lstat(path), stat(path), realpath(path)]);
  assert.equal(entry.isDirectory() && !entry.isSymbolicLink(), true);
  assert.equal(canonical, path);
  assert.equal(typeof process.getuid, "function");
  assert.equal(directory.uid, process.getuid());
  assert.equal(directory.mode & 0o077, 0);
};
const mountId = async descriptor => {
  const fdinfo = await readFile(`/proc/self/fdinfo/${descriptor}`, "utf8");
  const matches = [...fdinfo.matchAll(/^mnt_id:\s*(\d+)$/gmu)];
  assert.equal(matches.length, 1);
  return matches[0][1];
};
const workspaceOwner = workspaceRef => Object.freeze({
  async withLaunchAuthority(_input, consume) {
    const descriptor = await open(workspaceRef, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const identity = await descriptor.stat({bigint: true});
      assert.equal(identity.isDirectory(), true);
      return await consume(Object.freeze({
        canonicalPath: workspaceRef,
        descriptorPath: `/proc/self/fd/${descriptor.fd}`,
        identity: Object.freeze({dev: identity.dev, ino: identity.ino, mountId: await mountId(descriptor.fd)}),
      }));
    } finally {await descriptor.close();}
  },
});

const cgroupV2Factory = delegatedRoot => Object.freeze({
  async create(custodyRef) {
    const operationRoot = join(delegatedRoot, `operation-${sha256(custodyRef).slice(0, 32)}`);
    await mkdir(operationRoot, {mode: 0o700});
    let closed = false;
    const populated = async () => {
      const events = await readFile(join(operationRoot, "cgroup.events"), "utf8");
      const match = /^populated\s+([01])$/mu.exec(events);
      if (match === null) {throw new Error("operation cgroup has no exact populated state");}
      return match[1] === "1";
    };
    return Object.freeze({
      async attachGuardian(pid) {
        if (closed || !Number.isSafeInteger(pid) || pid <= 0) {return false;}
        await writeFile(join(operationRoot, "cgroup.procs"), `${pid}\n`, {encoding: "utf8"});
        const members = (await readFile(join(operationRoot, "cgroup.procs"), "utf8")).trim().split("\n");
        return members.includes(String(pid));
      },
      async close() {
        if (closed) {return true;}
        if (await populated()) {return false;}
        await rmdir(operationRoot);
        closed = true;
        return true;
      },
      async killAll() {
        if (closed) {return false;}
        await writeFile(join(operationRoot, "cgroup.kill"), "1\n", {encoding: "utf8"});
        return true;
      },
      async proveEmpty(deadline, monotonicNow) {
        while (monotonicNow() < deadline) {
          if (!await populated()) {return "empty";}
          await new Promise(resolve => {setImmediate(resolve);});
        }
        return await populated() ? "residue" : "empty";
      },
    });
  },
});

const run = async () => {
  assert.equal(`${process.platform}-${process.arch}`, "linux-x64");
  const canaryRoot = await realpath(requiredEnvironment("AR_CODEX_CANARY_ROOT"));
  const workspaceRef = await realpath(requiredEnvironment("AR_CODEX_CANARY_WORKSPACE"));
  const privateRootPath = await realpath(requiredEnvironment("AR_CODEX_CANARY_PRIVATE_ROOT"));
  const codexHome = await realpath(requiredEnvironment("AR_CODEX_CANARY_CODEX_HOME"));
  const tmpDir = await realpath(join(privateRootPath, "tmp"));
  const executablePath = await realpath(requiredEnvironment("AR_CODEX_BINARY"));
  const suppliedExecutableSha256 = requiredEnvironment("AR_CODEX_BINARY_SHA256");
  const delegatedCgroupRoot = await realpath(requiredEnvironment("AR_CODEX_CANARY_CGROUP_ROOT"));

  await assertRegularFile(join(canaryRoot, ".agent-runtime-test-sandbox"));
  await Promise.all([privateRootPath, codexHome, tmpDir].map(assertPrivateDirectory));
  await Promise.all([join(codexHome, "auth.json"), join(codexHome, "config.toml")].map(assertRegularFile));
  assert.equal(contains(canaryRoot, workspaceRef) && workspaceRef !== canaryRoot, true);
  assert.equal(contains(canaryRoot, privateRootPath) && privateRootPath !== canaryRoot, true);
  assert.equal(contains(privateRootPath, codexHome) && codexHome !== privateRootPath, true);
  assert.equal(contains(privateRootPath, tmpDir) && tmpDir !== privateRootPath, true);
  assert.equal(contains(privateRootPath, workspaceRef) || contains(workspaceRef, privateRootPath), false);
  assert.equal((await statfs(delegatedCgroupRoot)).type, 0x63677270);
  assert.equal(suppliedExecutableSha256, CODEX_APP_SERVER_BINARY_SHA256);
  assert.equal(sha256(await readFile(executablePath)), CODEX_APP_SERVER_BINARY_SHA256);

  const credentialBindingDigest = `sha256:${sha256(await readFile(join(codexHome, "auth.json")))}`;
  const snapshot = CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT;
  const providerAccessSnapshot = Object.freeze({
    accessRef: "access:codex-live-canary", credentialBindingDigest,
    credentialBindingRef: "credential-binding:codex-live-canary", credentialGeneration: 1,
    ownerAuthorityDigest: digestContainedTurnCanonicalValue({owner: "codex-live-canary"}),
    projectId: "project:disposable-live-canary", provider: "codex",
    providerAccountRef: "account:codex-live-canary",
    providerRouteRef: "route:codex-live-canary:subscription", revision: 1,
    tenantId: "tenant:disposable-live-canary",
  });
  const authorityVectorDigest = digestContainedTurnCanonicalValue({provider: "codex", workspace: "disposable"});
  const ids = Object.freeze({
    attemptId: containedTurnIdentity("attempt", "attempt:codex-live-canary"),
    custodyId: containedTurnIdentity("custody", "custody:codex-live-canary"),
    effectId: containedTurnIdentity("effect", "effect:codex-live-canary"),
    operationId: containedTurnIdentity("operation", "operation:codex-live-canary"),
    workspaceId: containedTurnIdentity("workspace", "workspace:codex-live-canary"),
  });
  const hostCustody = new NodeProviderProcessCustody({
    containmentAfterMs: 30_000, drainAfterMs: 10_000, forceKillAfterMs: 5_000,
    launchPlans: Object.freeze({resolve: async () => {throw new Error("ambient launch-plan resolution is forbidden");}}),
    residueAuthorityFactory: cgroupV2Factory(delegatedCgroupRoot), terminateAfterMs: 5_000,
  });
  const owner = createCodexCurrentKernelOwner({
    effectCustody: Object.freeze({admit() {throw new Error("analysis canary forbids provider effects");}}),
    hostBootId: "host-boot:codex-live-canary", hostCustody,
    hostInstanceId: "host-instance:codex-live-canary",
    launchRecords: Object.freeze({resolve: async input => {
      assert.equal(input.intentMode, "analysis");
      assert.equal(input.workspaceAuthority.canonicalPath, workspaceRef);
      return Object.freeze({
        boundary: createCodexAppServerPermissionBoundary({codexHome, workspaceRef}),
        executablePath, privateRootPath, tmpDir,
      });
    }}),
    workspaceOwner: workspaceOwner(workspaceRef),
  });
  const intent = Object.freeze({
    mode: "analysis",
    prompt: "Reply with exactly AR_CODEX_CANARY_OK. Do not invoke tools, spawn agents, or modify files.",
  });
  const kernelIdentity = Object.freeze({...ids, adapterSnapshot: snapshot, authorityVectorDigest, providerAccessSnapshot});
  const output = [];
  let finalCursor = 0;
  let physicalContainment;
  try {
    const opened = await owner.custody.open({...kernelIdentity, intentMode: intent.mode});
    assert.equal(opened.custodyId, ids.custodyId);
    const started = await owner.custody.start({
      attemptId: ids.attemptId, custodyId: ids.custodyId,
      execute: start => owner.provider.execute({
        ...kernelIdentity,
        emit: async chunk => {
          assert.equal(chunk.cursor, finalCursor);
          finalCursor += 1;
          output.push(chunk.text);
        },
        intent, isCancellationRequested: async () => false, start,
      }),
      intent, operationId: ids.operationId,
      startAuthority: `start-authority:${authorityVectorDigest}`, workspaceId: ids.workspaceId,
    });
    assert.equal(started.kind, "execution_started");
    const outcome = await started.execution;
    assert.deepEqual(outcome, {kind: "completed", outcome: "succeeded"});
    assert.equal(output.join(""), "AR_CODEX_CANARY_OK");
    const closure = await owner.custody.attestExecutionClosure({
      attemptId: ids.attemptId, custodyId: ids.custodyId, finalCursor, operationId: ids.operationId,
    });
    assert.equal(closure.kind, "proved");
  } finally {
    physicalContainment = await owner.custody.requestPhysicalContainment({
      attemptId: ids.attemptId, custodyId: ids.custodyId, operationId: ids.operationId,
    });
    owner.dispose();
  }
  assert.equal(physicalContainment.kind, "contained");
  return Object.freeze({
    binarySha256: CODEX_APP_SERVER_BINARY_SHA256,
    containmentProofDigest: sha256(physicalContainment.proof.proofId),
    outputDigest: sha256(output.join("")), outputEvents: finalCursor,
    provider: "codex-app-server-current-kernel", status: "succeeded",
  });
};

try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  const failure = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  process.stdout.write(`${JSON.stringify({errorDigest: sha256(failure), provider: "codex-app-server-current-kernel", status: "failed"})}\n`);
  process.exitCode = 1;
}
