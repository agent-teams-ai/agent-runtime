import { pathToFileURL } from "node:url";
import { trustedToolchainQualification } from "./provider-candidate-toolchain.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  createProviderCandidateEvidenceEnvelope,
  resolveCanaryExecutionProvenance,
  revalidateCanaryExecutionProvenance,
} from "./provider-candidate-evidence-envelope.mjs";


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
  throw new Error(`unsupported Claude canary target: ${platformRevision}`);
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

const resolveCandidateExecution = trustedBuildQualification => {
  const canaryId = "claude-contained-turn-live-canary/v1";
  return resolveCanaryExecutionProvenance(Object.freeze({
    buildRootUrl: new URL("../../dist/", import.meta.url).href,
    canaryId,
    canarySourceUrl: import.meta.url,
    claimedSourceSha: requiredEnvironment("AR_SOURCE_SHA"),
    provider: "claude-agent-sdk-current-kernel",
  }), trustedBuildQualification);
};

const loadCandidateBuild = async () => {
  const [composition, launchPlan, authority] = await Promise.all([
    import("../../dist/composition.js"),
    import("../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js"),
    import("../../dist/features/contained-agent-turn/domain/contained-turn-authority.js"),
  ]);
  return Object.freeze({ ...composition, ...launchPlan, ...authority });
};

const prepareCandidateEvidence = (tuple, executionProvenance) => {
  const canaryId = "claude-contained-turn-live-canary/v1";
  return Object.freeze({
    binaryRevision: tuple.binaryRevision,
    binarySha256: tuple.executableSha256,
    packageIdentity: Object.freeze({
      bundledCliVersion: tuple.bundledCliVersion,
      sdkRevision: `@anthropic-ai/claude-agent-sdk@${tuple.sdkVersion}`,
    }),
    platformTuple: tuple,
    provider: "claude-agent-sdk-current-kernel",
    canaryId,
    executionProvenance,
  });
};

const createPlatformCustody = async (platformTarget, launchPlans, candidateBuild) => {
  if (platformTarget.platform === "linux" && platformTarget.architecture === "x64") {
    const delegatedCgroupRoot = await realpath(requiredEnvironment("AR_CLAUDE_CANARY_CGROUP_ROOT"));
    assert.equal((await statfs(delegatedCgroupRoot)).type, 0x63677270);
    return new candidateBuild.NodeProviderProcessCustody({
      containmentAfterMs: 30_000, drainAfterMs: 10_000, forceKillAfterMs: 5_000,
      launchPlans, residueAuthorityFactory: cgroupV2Factory(delegatedCgroupRoot), terminateAfterMs: 5_000,
    });
  }
  if (platformTarget.platform === "darwin" && platformTarget.architecture === "arm64") {
    return new candidateBuild.DarwinCooperativeProcessCustody({
      containmentAfterMs: 30_000, drainAfterMs: 10_000, forceKillAfterMs: 5_000,
      launchPlans, terminateAfterMs: 5_000,
    });
  }
  throw new Error("unsupported Claude canary Host Custody target");
};

const run = async (executionProvenance, canaryProviderAuthorities, runObservation, state) => {
  const { requireContainedTurnLiveCanaryAuthorities, createDisposableContainedTurnCanaryRuntime,
    submitContainedTurnLiveCanary } = await import("./contained-turn-live-canary-lifecycle.mjs");
  // Provider Access and Runtime Security gates still precede credentials,
  // custody, database access and provider start.
  const authorities = requireContainedTurnLiveCanaryAuthorities(canaryProviderAuthorities);
  const platformTarget = exactPlatformTarget();
  const candidateBuild = await loadCandidateBuild();
  const { query: claudeQuery } = await import("@anthropic-ai/claude-agent-sdk");
  const {
    CONTAINED_TURN_REQUIRED_PROOF_KINDS, createClaudeAgentSdkPrivateProjection,
    createClaudeCurrentKernelOwner, selectClaudeAgentSdkPlatformTuple,
  } = candidateBuild;
  const tuple = selectClaudeAgentSdkPlatformTuple(platformTarget.platform, platformTarget.architecture);
  state.candidateEvidence = prepareCandidateEvidence(tuple, executionProvenance);
  const canaryRoot = await realpath(requiredEnvironment("AR_CLAUDE_CANARY_ROOT"));
  const workspaceRef = await realpath(requiredEnvironment("AR_CLAUDE_CANARY_WORKSPACE"));
  const privateRootPath = await realpath(requiredEnvironment("AR_CLAUDE_CANARY_PRIVATE_ROOT"));
  const configRoot = await realpath(join(privateRootPath, "config"));
  const homeRoot = await realpath(join(privateRootPath, "home"));
  const tempRoot = await realpath(join(privateRootPath, "tmp"));
  const executablePath = await realpath(requiredEnvironment("AR_CLAUDE_BINARY"));
  const suppliedExecutableSha256 = requiredEnvironment("AR_CLAUDE_BINARY_SHA256");
  const credentialPath = join(configRoot, ".credentials.json");

  await assertRegularFile(join(canaryRoot, ".agent-runtime-test-sandbox"));
  await Promise.all([privateRootPath, configRoot, homeRoot, tempRoot].map(assertPrivateDirectory));
  await assertRegularFile(credentialPath);
  assert.equal(contains(canaryRoot, workspaceRef) && workspaceRef !== canaryRoot, true);
  assert.equal(contains(canaryRoot, privateRootPath) && privateRootPath !== canaryRoot, true);
  assert.equal(contains(privateRootPath, configRoot) && configRoot !== privateRootPath, true);
  assert.equal(contains(privateRootPath, homeRoot) && homeRoot !== privateRootPath, true);
  assert.equal(contains(privateRootPath, tempRoot) && tempRoot !== privateRootPath, true);
  assert.equal(contains(privateRootPath, workspaceRef) || contains(workspaceRef, privateRootPath), false);
  assert.equal(suppliedExecutableSha256, tuple.executableSha256);
  assert.equal(sha256(await readFile(executablePath)), tuple.executableSha256);

  const snapshot = Object.freeze({
    adapterRevision: tuple.adapterRevision, binaryRevision: tuple.binaryRevision,
    capabilityManifestRevision: tuple.manifestRevision, provider: "claude",
  });
  const manifest = Object.freeze({
    effectCardinality: "one_coarse_effect_per_operation",
    effectClass: "contained_unmediated_effect",
    manifestRevision: tuple.manifestRevision, manifestVersion: 1, provider: "claude",
    providerAttemptCardinality: "at_most_one",
    requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
    resourceScopeRevision: tuple.resourceScopeRevision,
    supportedModes: Object.freeze(["analysis", "workspace-write"]),
    unknownCapabilityPolicy: "fail_closed",
  });
  const runtime = await createDisposableContainedTurnCanaryRuntime({
    authorities, canaryRoot, canonicalProjectRoot: workspaceRef,
    databaseUrl: requiredEnvironment("AR_CLAUDE_CANARY_POSTGRES_URL"),
  });
  let observedCustody;
  try {
    const launchPlans = Object.freeze({
      resolve: async () => {throw new Error("ambient launch-plan resolution is forbidden");},
    });
    const hostCustody = await createPlatformCustody(platformTarget, launchPlans, candidateBuild);
    observedCustody = observeCustodyReservation(hostCustody);
    const privateDirectoryCustody = Object.freeze({assertPrivateDirectory});
    const owner = createClaudeCurrentKernelOwner({
      adapterSnapshot: snapshot, executablePath,
      executableSha256: tuple.executableSha256,
      hostBootId: "host-boot:claude-live-canary", hostCustody: observedCustody.hostCustody,
      hostInstanceId: "host-instance:claude-live-canary",
      launchRecords: Object.freeze({resolve: async input => {
        assert.equal(input.intentMode, "analysis");
        const launchWorkspace = input.workspaceAuthority.canonicalPath;
        if (platformTarget.platform === "linux") {
          assert.match(input.workspaceAuthority.descriptorPath, /^\/proc\/self\/fd\/\d+$/u);
        } else {
          assert.equal(input.workspaceAuthority.descriptorPath, launchWorkspace);
        }
        const privateProjection = createClaudeAgentSdkPrivateProjection({
          configRoot, homeRoot, projectionRef: "projection:claude-live-canary", tempRoot,
          workspaceRef: launchWorkspace,
        });
        return Object.freeze({privateProjection, privateRootPath});
      }}),
      manifest, privateDirectoryCustody,
      queryFactory(input) {
        assert.equal(typeof input.options.spawnClaudeCodeProcess, "function");
        const query = claudeQuery(input);
        return Object.freeze({
          close: () => query.close(),
          interrupt: () => query.interrupt(),
          async *[Symbol.asyncIterator]() {yield* query;},
        });
      },
      platformTarget,
      workspaceOwner: runtime.workspaceOwner,
    });
    const intent = Object.freeze({
      mode: "analysis",
      prompt: "Reply with exactly AR_CLAUDE_CANARY_OK. Do not invoke tools, spawn agents, or modify files.",
    });
    const result = await submitContainedTurnLiveCanary({
      dependencies: runtime.dependencies(owner),
      owner: {dispose: () => runObservation.dispose("ownerDisposal", () => owner.dispose())},
      onObserved: runObservation.result,
      command: {
        commandId: "command:claude-live-canary",
        expectedProvider: "claude", intent,
        scope: {projectId: "project:disposable-live-canary", tenantId: "tenant:disposable-live-canary"},
      },
    });
    const observations = observeProviderCandidateCompletion({
      platform: platformTarget.platform, result, closure: observedCustody.closure(),
      expectedOutput: "AR_CLAUDE_CANARY_OK",
    });
    runObservation.completed(observations);
  } finally {
    try {runObservation.closure(observedCustody?.closure());}
    finally {await runObservation.dispose("runtimeDisposal", () => runtime.dispose());}
  }
};

// Inert private callable with separately trusted data; no environment loader.
export const runCanary = async (trustedBuildQualification, canaryProviderAuthorities) => {
  const qualification = trustedToolchainQualification(trustedBuildQualification);
  const executionProvenance = await resolveCandidateExecution(qualification);
  await revalidateCanaryExecutionProvenance(executionProvenance);
  const state = {};
  const runObservation = createCandidateRunObservation();
  try {
    await run(executionProvenance, canaryProviderAuthorities, runObservation, state);
    return await createProviderCandidateEvidenceEnvelope(Object.freeze({
      ...state.candidateEvidence, ...runObservation.evidence("provider-completed"),
    }));
  } catch (error) {
    if (state.candidateEvidence === undefined) {throw error;}
    return createProviderCandidateEvidenceEnvelope(Object.freeze({
      ...state.candidateEvidence, ...runObservation.evidence("failed"),
    }));
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(`${JSON.stringify(await runCanary())}\n`);}
  catch {
    process.stderr.write("invalid canary invocation (separate trusted composition required)\n");
    process.exitCode = 1;
  }
}
