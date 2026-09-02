import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";

import {
  createProviderCandidateEvidenceEnvelope,
  resolveCanaryExecutionProvenance,
} from "./provider-candidate-evidence-envelope.mjs";

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
const workspaceOwner = (workspaceRef, platformTarget) => Object.freeze({
  async withLaunchAuthority(_input, consume) {
    if (platformTarget.platform === "darwin" && platformTarget.architecture === "arm64") {
      const identity = await stat(workspaceRef, {bigint: true});
      assert.equal(identity.isDirectory(), true);
      return consume(Object.freeze({
        canonicalPath: workspaceRef,
        descriptorPath: workspaceRef,
        identity: Object.freeze({
          dev: identity.dev, ino: identity.ino, mountId: "darwin-statfs:unqualified-candidate",
        }),
      }));
    }
    if (platformTarget.platform !== "linux" || platformTarget.architecture !== "x64") {
      throw new Error("unsupported Claude canary workspace authority target");
    }
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

const resolveCandidateExecution = () => {
  const canaryId = "claude-contained-turn-live-canary/v1";
  return resolveCanaryExecutionProvenance({
    buildRootUrl: new URL("../../dist/", import.meta.url),
    canaryId,
    canarySourceUrl: import.meta.url,
    claimedSourceSha: requiredEnvironment("AR_SOURCE_SHA"),
    provider: "claude-agent-sdk-current-kernel",
  });
};

const loadCandidateBuild = async () => {
  const [composition, launchPlan, authority, codecs, identities] = await Promise.all([
    import("../../dist/composition.js"),
    import("../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js"),
    import("../../dist/features/contained-agent-turn/domain/contained-turn-authority.js"),
    import("../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js"),
    import("../../dist/features/contained-agent-turn/domain/contained-turn-identities.js"),
  ]);
  return Object.freeze({ ...composition, ...launchPlan, ...authority, ...codecs, ...identities });
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

const createSuccessfulEvidence = (evidence, physicalContainment, output, outputEvents) =>
  createProviderCandidateEvidenceEnvelope({
    ...evidence,
    compositeContainment: "indeterminate",
    observations: Object.freeze({ outputDigest: sha256(output), outputEvents }),
    physicalContainment,
    status: "succeeded",
  });

const run = async () => {
  const platformTarget = exactPlatformTarget();
  const executionProvenance = await resolveCandidateExecution();
  const candidateBuild = await loadCandidateBuild();
  const {
    CONTAINED_TURN_REQUIRED_PROOF_KINDS, containedTurnIdentity, createClaudeAgentSdkPrivateProjection,
    createClaudeCurrentKernelOwner, digestContainedTurnCanonicalValue, selectClaudeAgentSdkPlatformTuple,
  } = candidateBuild;
  const tuple = selectClaudeAgentSdkPlatformTuple(platformTarget.platform, platformTarget.architecture);
  candidateEvidence = prepareCandidateEvidence(tuple, executionProvenance);
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
  const credentialBindingDigest = `sha256:${sha256(await readFile(credentialPath))}`;
  const providerAccessSnapshot = Object.freeze({
    accessRef: "access:claude-live-canary", credentialBindingDigest,
    credentialBindingRef: "credential-binding:claude-live-canary", credentialGeneration: 1,
    ownerAuthorityDigest: digestContainedTurnCanonicalValue({owner: "claude-live-canary"}),
    projectId: "project:disposable-live-canary", provider: "claude",
    providerAccountRef: "account:claude-live-canary",
    providerRouteRef: "route:claude-live-canary:subscription", revision: 1,
    tenantId: "tenant:disposable-live-canary",
  });
  const authorityVectorDigest = digestContainedTurnCanonicalValue({provider: "claude", workspace: "disposable"});
  const ids = Object.freeze({
    attemptId: containedTurnIdentity("attempt", "attempt:claude-live-canary"),
    custodyId: containedTurnIdentity("custody", "custody:claude-live-canary"),
    effectId: containedTurnIdentity("effect", "effect:claude-live-canary"),
    operationId: containedTurnIdentity("operation", "operation:claude-live-canary"),
    workspaceId: containedTurnIdentity("workspace", "workspace:claude-live-canary"),
  });
  const launchPlans = Object.freeze({
    resolve: async () => {throw new Error("ambient launch-plan resolution is forbidden");},
  });
  const hostCustody = await createPlatformCustody(platformTarget, launchPlans, candidateBuild);
  const privateDirectoryCustody = Object.freeze({assertPrivateDirectory});
  const privateProjection = createClaudeAgentSdkPrivateProjection({
    configRoot, homeRoot, projectionRef: "projection:claude-live-canary", tempRoot, workspaceRef,
  });
  const owner = createClaudeCurrentKernelOwner({
    adapterSnapshot: snapshot, executablePath,
    executableSha256: tuple.executableSha256,
    hostBootId: "host-boot:claude-live-canary", hostCustody,
    hostInstanceId: "host-instance:claude-live-canary",
    launchRecords: Object.freeze({resolve: async input => {
      assert.equal(input.intentMode, "analysis");
      assert.equal(input.workspaceAuthority.canonicalPath, workspaceRef);
      if (platformTarget.platform === "linux") {
        assert.match(input.workspaceAuthority.descriptorPath, /^\/proc\/self\/fd\/\d+$/u);
      } else {
        assert.equal(input.workspaceAuthority.descriptorPath, workspaceRef);
        assert.equal(input.workspaceAuthority.identity.mountId, "darwin-statfs:unqualified-candidate");
      }
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
    workspaceOwner: workspaceOwner(workspaceRef, platformTarget),
  });
  const intent = Object.freeze({
    mode: "analysis",
    prompt: "Reply with exactly AR_CLAUDE_CANARY_OK. Do not invoke tools, spawn agents, or modify files.",
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
    assert.equal(output.join(""), "AR_CLAUDE_CANARY_OK");
    const closure = await owner.custody.attestExecutionClosure({
      attemptId: ids.attemptId, custodyId: ids.custodyId, finalCursor, operationId: ids.operationId,
    });
    assert.equal(closure.kind, "proved");
    assert.equal(closure.outputDrainProof.kind, "output_drain");
  } finally {
    physicalContainment = await owner.custody.requestPhysicalContainment({
      attemptId: ids.attemptId, custodyId: ids.custodyId, operationId: ids.operationId,
    });
    owner.dispose();
  }
  if (platformTarget.platform === "linux") {
    assert.equal(physicalContainment.kind, "contained");
  } else {
    assert.equal(physicalContainment.kind, "indeterminate");
  }
  return createSuccessfulEvidence(candidateEvidence, physicalContainment.kind, output.join(""), finalCursor);
};

let candidateEvidence;
try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  const failure = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  if (candidateEvidence === undefined) {
    process.stderr.write(`invalid Claude canary invocation (${sha256(failure)})\n`);
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await createProviderCandidateEvidenceEnvelope({
        ...candidateEvidence, compositeContainment: "indeterminate",
        observations: Object.freeze({errorDigest: sha256(failure)}),
        physicalContainment: "indeterminate", status: "failed",
      }))}\n`);
    } catch (provenanceError) {
      const detail = provenanceError instanceof Error ? provenanceError.name : "UnknownError";
      process.stderr.write(`invalid Claude canary evidence (${sha256(detail)})\n`);
    }
  }
  process.exitCode = 1;
}
