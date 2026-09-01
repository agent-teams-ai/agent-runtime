import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeCurrentKernelOwner } from "../../../dist/composition.js";
import {
  CONTAINED_TURN_REQUIRED_PROOF_KINDS,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import {
  CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE,
  CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD,
  CLAUDE_AGENT_SDK_LINUX_X64_TUPLE,
  createClaudeAgentSdkLaunchPlan,
  selectClaudeAgentSdkPlatformTuple,
  type ClaudeAgentSdkPlatformTuple,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import {
  assertDelegatedStartFingerprint,
  createFingerprint,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
import {
  executablePath,
  inertProcess,
  inertRegistryProcess,
  input,
  privateDirectoryCustody,
  privateProjection,
  privateRoot,
  provider,
  success,
  workspaceRef,
} from "../../claude-agent-sdk-contained-turn-provider.support.ts";

const planFor = (platformTuple: ClaudeAgentSdkPlatformTuple) => createClaudeAgentSdkLaunchPlan({
  binaryRevision: platformTuple.binaryRevision,
  executablePath,
  executableSha256: platformTuple.executableSha256,
  intentMode: "analysis",
  platformTuple,
  privateDirectoryCustody,
  privateProjection,
  privateRootPath: privateRoot,
  workspaceRef,
});

const delegatedLaunch = (plan: Awaited<ReturnType<typeof planFor>>, cwd: string) => ({
  arguments: plan.arguments,
  command: plan.executablePath,
  cwd,
  environment: plan.environment,
});

test("selects only the exact supported Claude Linux and Darwin candidate tuples", () => {
  assert.equal(selectClaudeAgentSdkPlatformTuple("linux", "x64"), CLAUDE_AGENT_SDK_LINUX_X64_TUPLE);
  assert.equal(selectClaudeAgentSdkPlatformTuple("darwin", "arm64"), CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE);
  assert.deepEqual(CLAUDE_AGENT_SDK_LINUX_X64_TUPLE, {
    adapterRevision: "claude-agent-sdk-contained-turn:0.3.251",
    architecture: "x64",
    binaryRevision: "sha256:fd5f10ff0eb58daec04900466b143ea98aab50abf208a422bc008eaec13f61f7",
    bundledCliVersion: "2.1.251",
    containmentProfile: "strict-linux-cgroup-v2",
    executableSha256: "fd5f10ff0eb58daec04900466b143ea98aab50abf208a422bc008eaec13f61f7",
    manifestRevision: "claude-contained-turn-v1@1",
    platform: "linux",
    resourceScopeRevision: "contained-turn-v1-worst-case-scope@1",
    sdkVersion: "0.3.251",
    workspaceAuthority: "retained-descriptor",
  });
  assert.equal(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.executableSha256,
    "625869b01e0050f260b2980fac248fd9cef9e462612bded4ec9d3d49ff8969a5");
  assert.equal(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.containmentProfile,
    "cooperative-darwin-posix-process-group");
  assert.equal(Object.isFrozen(CLAUDE_AGENT_SDK_LINUX_X64_TUPLE), true);
  assert.equal(Object.isFrozen(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE), true);
  for (const target of [["win32", "x64"], ["linux", "arm64"], ["darwin", "x64"]] as const) {
    assert.throws(() => selectClaudeAgentSdkPlatformTuple(...target), /no supported tuple/u);
  }
});

test("binds Linux to its retained descriptor and Darwin to its canonical operation workspace", async () => {
  const linux = await planFor(CLAUDE_AGENT_SDK_LINUX_X64_TUPLE);
  const darwin = await planFor(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE);
  assert.equal(linux.containmentProfile, "strict-linux-cgroup-v2");
  assert.equal(darwin.containmentProfile, "cooperative-darwin-posix-process-group");
  assert.match(JSON.stringify(linux.arguments), /\/proc\/self\/fd\/4/u);
  assert.doesNotMatch(JSON.stringify(darwin.arguments), /\/proc\/self\/fd/u);
  assert.match(JSON.stringify(darwin.arguments), new RegExp(workspaceRef.replaceAll("/", "\\/"), "u"));

  assert.doesNotThrow(() => assertDelegatedStartFingerprint(
    delegatedLaunch(linux, CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD), linux, workspaceRef,
  ));
  assert.doesNotThrow(() => assertDelegatedStartFingerprint(delegatedLaunch(darwin, workspaceRef), darwin, workspaceRef));
  assert.throws(() => assertDelegatedStartFingerprint(delegatedLaunch(linux, workspaceRef), linux, workspaceRef), /workspace/u);
  assert.throws(() => assertDelegatedStartFingerprint(
    delegatedLaunch(darwin, CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD), darwin, workspaceRef,
  ), /workspace/u);
});

test("fails closed on tuple, profile, binary, and cwd mismatch", async () => {
  const forgedProfile = Object.freeze({
    ...CLAUDE_AGENT_SDK_LINUX_X64_TUPLE,
    containmentProfile: "cooperative-darwin-posix-process-group" as const,
  });
  await assert.rejects(planFor(forgedProfile), /tuple/u);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({
    binaryRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.binaryRevision,
    executablePath,
    executableSha256: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.executableSha256,
    intentMode: "analysis",
    platformTuple: CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE,
    privateDirectoryCustody,
    privateProjection,
    privateRootPath: privateRoot,
    workspaceRef,
  }), /tuple/u);
});

test("outer composition accepts a structural target and rejects unsupported targets or digest drift", () => {
  const adapterSnapshot = Object.freeze({
    adapterRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.adapterRevision,
    binaryRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.binaryRevision,
    capabilityManifestRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.manifestRevision,
    provider: "claude" as const,
  });
  const manifest = Object.freeze({
    effectCardinality: "one_coarse_effect_per_operation" as const,
    effectClass: "contained_unmediated_effect" as const,
    manifestRevision: adapterSnapshot.capabilityManifestRevision,
    manifestVersion: 1 as const,
    provider: "claude" as const,
    providerAttemptCardinality: "at_most_one" as const,
    requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
    resourceScopeRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.resourceScopeRevision,
    supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
    unknownCapabilityPolicy: "fail_closed" as const,
  });
  const options = {
    adapterSnapshot,
    executablePath,
    executableSha256: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.executableSha256,
    hostBootId: "host-boot:tuple",
    hostCustody: {get() {return;}, start() {return {} as never;}} as never,
    hostInstanceId: "host-instance:tuple",
    launchRecords: {} as never,
    manifest,
    platformTarget: Object.freeze({architecture: "x64" as const, platform: "linux" as const}),
    privateDirectoryCustody,
    workspaceOwner: {} as never,
  };
  assert.doesNotThrow(() => createClaudeCurrentKernelOwner({...options,
    platformTarget: {architecture: "x64", platform: "linux"}}));
  assert.throws(() => createClaudeCurrentKernelOwner({...options,
    platformTarget: {architecture: "x64", platform: "darwin"}} as never), /supported tuple/u);
  assert.throws(() => createClaudeCurrentKernelOwner({...options,
    executableSha256: CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.executableSha256}), /tuple/u);
});

test("produces deterministic tuple-bound fingerprints without exposing private paths", async () => {
  const plan = await planFor(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE);
  const providerBinding = Object.freeze({
    adapterRevision: CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.adapterRevision,
    binaryRevision: CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.binaryRevision,
    capabilityManifestRevision: CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.manifestRevision,
    credentialBindingDigest: "credential:opaque",
    provider: "claude" as const,
    providerRouteRef: "route:opaque",
  });
  const launchInput = {attemptId: "attempt:tuple", intentMode: "analysis" as const,
    operationId: "operation:tuple", providerBinding, workspaceRef};
  const first = createFingerprint(launchInput, plan, workspaceRef, plan.arguments);
  const second = createFingerprint(launchInput, plan, workspaceRef, plan.arguments);
  assert.deepEqual(first, second);
  assert.equal(first.binaryRevision, CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.binaryRevision);
  assert.equal(first.containmentProfile, CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE.containmentProfile);
  assert.doesNotMatch(JSON.stringify(first), /host-private|\/tmp\//u);
});

test("delegates the exact Darwin plan fingerprint through the official SDK spawn callback", async () => {
  const plan = await planFor(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE);
  let delegated: unknown;
  const adapter = provider(queryInput => {
    assert.equal(queryInput.options.cwd, workspaceRef);
    assert.deepEqual(queryInput.options.sandbox.filesystem.allowRead, [workspaceRef]);
    queryInput.options.spawnClaudeCodeProcess({
      args: [...plan.arguments], command: executablePath, cwd: queryInput.options.cwd,
      env: {...plan.environment}, signal: new AbortController().signal,
    });
    return {close: () => {}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {yield success();}};
  }, {
    platformTuple: CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE,
    processes: {get: () => inertRegistryProcess(), start: (_custodyRef, launch) => {
      delegated = launch; return inertProcess();
    }},
  });
  assert.equal((await adapter.execute(input())).kind, "completed");
  assert.deepEqual(delegated, {
    arguments: plan.arguments, command: executablePath, cwd: workspaceRef,
    environment: plan.environment, signal: (delegated as {signal: AbortSignal}).signal,
  });
});
