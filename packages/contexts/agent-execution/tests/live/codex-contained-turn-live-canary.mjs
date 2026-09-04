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
import { readCodexCanaryCredentialInventory } from "./codex-canary-credential-inventory.mjs";

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

const observeCustodyReservation = custody => {
  let openedCustody;
  const hostCustody = new Proxy(custody, {
    get(target, property) {
      if (property === "reserve") {
        return async input => {
          const opened = await target.reserve(input);
          assert.equal(openedCustody, undefined);
          openedCustody = opened;
          return opened;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    hostCustody,
    opened() { assert.ok(openedCustody); return openedCustody; },
  });
};

const safeContainmentEvidence = (custody, opened, physicalContainment, platformTarget) => {
  const evidence = custody.evidence(opened.custodyRef);
  assert.ok(evidence);
  const safe = Object.freeze({
    limitations: evidence.closure.limitations,
    profile: evidence.closure.profile,
    status: evidence.closure.status,
  });
  assert.equal(safe.status, "closed");
  if (platformTarget.platform === "linux") {
    assert.equal(physicalContainment.kind, "contained");
    assert.equal(safe.profile, "strict-linux-cgroup-v2");
    assert.deepEqual(safe.limitations, []);
  } else {
    assert.equal(physicalContainment.kind, "indeterminate");
    assert.equal(safe.profile, "cooperative-darwin-posix-process-group");
    assert.deepEqual(safe.limitations, [
      "canonical-executable-path-is-name-bound-at-spawn",
      "canonical-workspace-path-is-name-bound-at-spawn",
      "private-environment-paths-are-name-bound-at-spawn",
      "descendant-may-escape-via-new-session",
    ]);
  }
  return safe;
};

const resolveCandidateExecution = () => {
  const canaryId = "codex-contained-turn-live-canary/v1";
  return resolveCanaryExecutionProvenance({
    buildRootUrl: new URL("../../dist/", import.meta.url),
    canaryId,
    canarySourceUrl: import.meta.url,
    claimedSourceSha: requiredEnvironment("AR_SOURCE_SHA"),
    provider: "codex-app-server-current-kernel",
  });
};

const loadCandidateBuild = async () => {
  const [composition, tuple, codecs, identities] = await Promise.all([
    import("../../dist/composition.js"),
    import("../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js"),
    import("../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js"),
    import("../../dist/features/contained-agent-turn/domain/contained-turn-identities.js"),
  ]);
  return Object.freeze({ ...composition, ...tuple, ...codecs, ...identities });
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

const readBoundCredentialOutputInventory = async (codexHome, input) => {
  // Candidate-only re-observation: route qualification must separately bind the
  // exact material later opened by Codex through custody-owned provisioning.
  const inventory = await readCodexCanaryCredentialInventory(
    join(codexHome, "auth.json"), input.credentialGeneration,
  );
  if (inventory.credentialBindingDigest !== input.credentialBindingDigest) {
    throw new Error("disposable Codex credential inventory changed before launch planning");
  }
  return inventory;
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
    const observedCustody = observeCustodyReservation(custody);
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
        const credentialOutputInventory = await readBoundCredentialOutputInventory(codexHome, input);
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
    const {physicalContainment, turn} = await submitContainedTurnLiveCanary({
      dependencies: runtime.dependencies(owner), owner,
      command: {
        commandId: "command:codex-live-canary",
        expectedProvider: "codex", intent,
        scope: {projectId: "project:disposable-live-canary", tenantId: "tenant:disposable-live-canary"},
      },
    });
    const output = turn.output.map(chunk => chunk.text);
    const finalCursor = turn.output.length;
    assert.equal(turn.status, "succeeded");
    assert.equal(output.join(""), "AR_CODEX_CANARY_OK");
    const containmentEvidence = safeContainmentEvidence(
      custody, observedCustody.opened(), physicalContainment, platformTarget,
    );
    return createProviderCandidateEvidenceEnvelope({
      ...candidateEvidence,
      compositeContainment: "indeterminate",
      observations: Object.freeze({
        ...(physicalContainment.kind === "contained"
          ? {containmentProofDigest: sha256(physicalContainment.proofId)} : {}),
        terminalStatus: turn.status, artifactManifestRef: turn.artifactManifestRef, resultRef: turn.resultRef,
        closureStatus: containmentEvidence.status,
        containmentLimitations: containmentEvidence.limitations,
        containmentProfile: containmentEvidence.profile,
        outputDigest: sha256(output.join("")), outputEvents: finalCursor,
      }),
      physicalContainment: physicalContainment.kind,
      status: "succeeded",
    });
  } finally {await runtime.dispose();}
};

let candidateEvidence;
try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  const failure = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  if (candidateEvidence === undefined) {
    process.stderr.write(`invalid Codex canary invocation (${error?.reason ?? sha256(failure)})\n`);
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await createProviderCandidateEvidenceEnvelope({
        ...candidateEvidence, compositeContainment: "indeterminate",
        observations: Object.freeze({errorDigest: sha256(failure)}),
        physicalContainment: "indeterminate", status: "failed",
      }))}\n`);
    } catch (provenanceError) {
      const detail = provenanceError instanceof Error ? provenanceError.name : "UnknownError";
      process.stderr.write(`invalid Codex canary evidence (${sha256(detail)})\n`);
    }
  }
  process.exitCode = 1;
}
