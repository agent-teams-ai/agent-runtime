import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  createProviderCandidateEvidenceEnvelope,
  resolveCanaryExecutionProvenance,
} from "./provider-candidate-evidence-envelope.mjs";
import {
  requireContainedTurnLiveCanaryAuthorities,
  createDisposableContainedTurnCanaryRuntime,
  submitContainedTurnLiveCanary,
} from "./contained-turn-live-canary-lifecycle.mjs";
import { bindCodexCanaryOutputInventory, readCodexCanaryCredentialInventory } from "./codex-canary-credential-inventory.mjs";

import { observeCustodyReservation, observeProviderCandidateCompletion } from "./provider-candidate-observation.mjs";
import { createCandidateRunObservation } from "./provider-candidate-run-observation.mjs";

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
const exactPlatformTarget = () => {
  const platformRevision = `${process.platform}-${process.arch}`;
  if (platformRevision === "linux-x64") {
    return Object.freeze({architecture: "x64", platform: "linux"});
  }
  if (platformRevision === "darwin-arm64") {
    return Object.freeze({architecture: "arm64", platform: "darwin"});
  }
  throw new Error(`unsupported Codex canary target: ${platformRevision}`);
};
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

const resolveCandidateExecution = () => {
  const canaryId = "codex-contained-turn-live-canary/v1";
  return resolveCanaryExecutionProvenance(Object.freeze({
    buildRootUrl: new URL("../../dist/", import.meta.url).href,
    canaryId,
    canarySourceUrl: import.meta.url,
    claimedSourceSha: requiredEnvironment("AR_SOURCE_SHA"),
    provider: "codex-app-server-current-kernel",
  }));
};

const loadCandidateBuild = async () => {
  const [composition, tuple] = await Promise.all([
    import("../../dist/composition.js"),
    import("../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js"),
  ]);
  return Object.freeze({ ...composition, ...tuple });
};

const prepareCandidateEvidence = (platformTuple, executionProvenance) => {
  const canaryId = "codex-contained-turn-live-canary/v1";
  return Object.freeze({
    binaryRevision: platformTuple.binaryRevision,
    binarySha256: platformTuple.binarySha256,
    packageIdentity: Object.freeze({
      nativeDependencyAliasRevision: platformTuple.nativeDependencyAliasRevision,
      resolvedNativePackageRevision: platformTuple.resolvedNativePackageRevision,
      wrapperPackageRevision: platformTuple.packageRevision,
    }),
    platformTuple,
    provider: "codex-app-server-current-kernel",
    canaryId,
    executionProvenance,
  });
};

const readBoundCredentialOutputInventory = async (codexHome, input, expectedInventory) => {
  // Candidate-only re-observation: route qualification must separately bind the
  // exact material later opened by Codex through custody-owned provisioning.
  const inventory = await readCodexCanaryCredentialInventory(
    join(codexHome, "auth.json"), input.credentialGeneration,
  );
  return bindCodexCanaryOutputInventory(inventory, expectedInventory, input);
};

const run = async () => {
  // This current checkout has no qualified enforced route. Resolve authority
  // before inspecting credential paths, allocating custody, or connecting to PG.
  const authorities = requireContainedTurnLiveCanaryAuthorities();
  const platformTarget = exactPlatformTarget();
  const executionProvenance = await resolveCandidateExecution();
  const candidateBuild = await loadCandidateBuild();
  const {
    createCodexAppServerPermissionBoundary, createCodexCurrentKernelOwner,
    DarwinCooperativeProcessCustody, NodeProviderProcessCustody,
    selectCodexAppServerPlatformTuple,
  } = candidateBuild;
  const platformTuple = selectCodexAppServerPlatformTuple(platformTarget);
  candidateEvidence = prepareCandidateEvidence(platformTuple, executionProvenance);
  const canaryRoot = await realpath(requiredEnvironment("AR_CODEX_CANARY_ROOT"));
  const workspaceRef = await realpath(requiredEnvironment("AR_CODEX_CANARY_WORKSPACE"));
  const privateRootPath = await realpath(requiredEnvironment("AR_CODEX_CANARY_PRIVATE_ROOT"));
  const codexHome = await realpath(requiredEnvironment("AR_CODEX_CANARY_CODEX_HOME"));
  const tmpDir = await realpath(join(privateRootPath, "tmp"));
  const executablePath = await realpath(requiredEnvironment("AR_CODEX_BINARY"));
  const suppliedExecutableSha256 = requiredEnvironment("AR_CODEX_BINARY_SHA256");

  await assertRegularFile(join(canaryRoot, ".agent-runtime-test-sandbox"));
  await Promise.all([privateRootPath, codexHome, tmpDir].map(assertPrivateDirectory));
  await Promise.all([join(codexHome, "auth.json"), join(codexHome, "config.toml")].map(assertRegularFile));
  assert.equal(contains(canaryRoot, workspaceRef) && workspaceRef !== canaryRoot, true);
  assert.equal(contains(canaryRoot, privateRootPath) && privateRootPath !== canaryRoot, true);
  assert.equal(contains(privateRootPath, codexHome) && codexHome !== privateRootPath, true);
  assert.equal(contains(privateRootPath, tmpDir) && tmpDir !== privateRootPath, true);
  assert.equal(contains(privateRootPath, workspaceRef) || contains(workspaceRef, privateRootPath), false);
  assert.equal(suppliedExecutableSha256, platformTuple.binarySha256);
  assert.equal(sha256(await readFile(executablePath)), platformTuple.binarySha256);

  const runtime = await createDisposableContainedTurnCanaryRuntime({
    authorities, canaryRoot, canonicalProjectRoot: workspaceRef,
    databaseUrl: requiredEnvironment("AR_CODEX_CANARY_POSTGRES_URL"),
  });
  let observedCustody;
  try {
    const launchPlans = Object.freeze({
      resolve: async () => {throw new Error("ambient launch-plan resolution is forbidden");},
    });
    let custody;
    if (platformTarget.platform === "linux" && platformTarget.architecture === "x64") {
      const delegatedCgroupRoot = await realpath(requiredEnvironment("AR_CODEX_CANARY_CGROUP_ROOT"));
      assert.equal((await statfs(delegatedCgroupRoot)).type, 0x63677270);
      custody = new NodeProviderProcessCustody({
        containmentAfterMs: 30_000, drainAfterMs: 10_000, forceKillAfterMs: 5_000,
        launchPlans, residueAuthorityFactory: cgroupV2Factory(delegatedCgroupRoot), terminateAfterMs: 5_000,
      });
    } else if (platformTarget.platform === "darwin" && platformTarget.architecture === "arm64") {
      custody = new DarwinCooperativeProcessCustody({
        containmentAfterMs: 30_000, drainAfterMs: 10_000, forceKillAfterMs: 5_000,
        launchPlans, terminateAfterMs: 5_000,
      });
    } else {
      throw new Error("unsupported Codex canary Host Custody target");
    }
    observedCustody = observeCustodyReservation(custody);
    let expectedCredentialInventory;
    const owner = createCodexCurrentKernelOwner({
      effectCustody: Object.freeze({admit() {throw new Error("analysis canary forbids provider effects");}}),
      hostBootId: "host-boot:codex-live-canary", hostCustody: observedCustody.hostCustody,
      hostInstanceId: "host-instance:codex-live-canary",
      launchRecords: Object.freeze({resolve: async input => {
        assert.equal(input.intentMode, "analysis");
        const launchWorkspace = input.workspaceAuthority.canonicalPath;
        if (platformTarget.platform === "linux") {
          assert.match(input.workspaceAuthority.descriptorPath, /^\/proc\/self\/fd\/\d+$/u);
        } else {
          assert.equal(input.workspaceAuthority.descriptorPath, launchWorkspace);
        }
        // Keep the first content observation distinct from accepted PA authority.
        // This remains candidate redaction evidence, not immutable file custody.
        expectedCredentialInventory ??= await readCodexCanaryCredentialInventory(
          join(codexHome, "auth.json"), input.credentialGeneration,
        );
        const credentialOutputInventory = await readBoundCredentialOutputInventory(codexHome, input, expectedCredentialInventory);
        return Object.freeze({
          boundary: createCodexAppServerPermissionBoundary({codexHome, intentMode: input.intentMode, workspaceRef: launchWorkspace}),
          credentialOutputInventory,
          executablePath, privateRootPath, tmpDir,
        });
      }}),
      platformTarget,
      workspaceOwner: runtime.workspaceOwner,
    });
    const intent = Object.freeze({
      mode: "analysis",
      prompt: "Reply with exactly AR_CODEX_CANARY_OK. Do not invoke tools, spawn agents, or modify files.",
    });
    const result = await submitContainedTurnLiveCanary({
      dependencies: runtime.dependencies(owner),
      owner: {dispose: () => runObservation.dispose("ownerDisposal", () => owner.dispose())},
      onObserved: runObservation.result,
      command: {
        commandId: "command:codex-live-canary",
        expectedProvider: "codex", intent,
        scope: {projectId: "project:disposable-live-canary", tenantId: "tenant:disposable-live-canary"},
      },
    });
    const observations = observeProviderCandidateCompletion({
      platform: platformTarget.platform, result, closure: observedCustody.closure(),
      expectedOutput: "AR_CODEX_CANARY_OK",
    });
    runObservation.completed(observations);
  } finally {
    try {runObservation.closure(observedCustody?.closure());}
    finally {await runObservation.dispose("runtimeDisposal", () => runtime.dispose());}
  }
};

const completedEvidence = async () => {
  await run();
  return createProviderCandidateEvidenceEnvelope(Object.freeze({
    ...candidateEvidence,
    ...runObservation.evidence("provider-completed"),
  }));
};

let candidateEvidence;
const runObservation = createCandidateRunObservation();
try {
  process.stdout.write(`${JSON.stringify(await completedEvidence())}\n`);
} catch (error) {
  if (candidateEvidence === undefined) {
    process.stderr.write(`invalid Codex canary invocation (${error?.reason === "route-enforcement-unqualified" ? "route-enforcement-unqualified" : "canary-invocation-rejected"})\n`);
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await createProviderCandidateEvidenceEnvelope(Object.freeze({
        ...candidateEvidence, ...runObservation.evidence("failed"),
      })))}\n`);
    } catch {
      process.stderr.write(`invalid Codex canary evidence (canary-evidence-rejected)\n`);
    }
  }
  process.exitCode = 1;
}
