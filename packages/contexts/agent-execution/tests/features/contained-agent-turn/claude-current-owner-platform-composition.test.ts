import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaudeCurrentKernelOwner,
  DarwinCooperativeProcessCustody,
} from "../../../dist/composition.js";
import {
  CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE,
  CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD,
  CLAUDE_AGENT_SDK_LINUX_X64_TUPLE,
  type ClaudeAgentSdkPlatformTuple,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { containedTurnOperationCutoffRevision } from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {
  delta,
  executablePath,
  inertProcess,
  inertRegistryProcess,
  privateDirectoryCustody,
  privateProjection,
  privateRoot,
  success,
  workspaceRef,
} from "../../claude-agent-sdk-contained-turn-provider.support.ts";
import { committedDispatchProofFixture } from "./support/committed-dispatch-proof-fixture.ts";

const targetFor = (tuple: ClaudeAgentSdkPlatformTuple) => tuple.platform === "linux"
  ? Object.freeze({architecture: "x64" as const, platform: "linux" as const})
  : Object.freeze({architecture: "arm64" as const, platform: "darwin" as const});

const snapshotFor = (tuple: ClaudeAgentSdkPlatformTuple) => Object.freeze({
  adapterRevision: tuple.adapterRevision,
  binaryRevision: tuple.binaryRevision,
  capabilityManifestRevision: tuple.manifestRevision,
  provider: "claude" as const,
});

const manifestFor = (tuple: ClaudeAgentSdkPlatformTuple) => Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation" as const,
  effectClass: "contained_unmediated_effect" as const,
  manifestRevision: tuple.manifestRevision,
  manifestVersion: 1 as const,
  provider: "claude" as const,
  providerAttemptCardinality: "at_most_one" as const,
  requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: tuple.resourceScopeRevision,
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
  unknownCapabilityPolicy: "fail_closed" as const,
});

class ProfileHost {
  readonly plans: unknown[] = [];
  readonly profile: ClaudeAgentSdkPlatformTuple["containmentProfile"];
  contained = false;
  starts = 0;

  public constructor(profile: ClaudeAgentSdkPlatformTuple["containmentProfile"]) {
    this.profile = profile;
  }

  public async reserve(input: {readonly launchPlan: {readonly containmentProfile: string}}) {
    if (input.launchPlan.containmentProfile !== this.profile) {
      throw new TypeError("Claude plan and Host profile mismatch");
    }
    this.plans.push(input.launchPlan);
    return Object.freeze({custodyRef: "host-custody:claude-platform-composition"});
  }

  public async open() {throw new Error("composed owner must use delegated reservation");}

  public start(_custodyRef: string, input: {readonly cwd: string}) {
    const expected = this.profile === "strict-linux-cgroup-v2" ? CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD : workspaceRef;
    assert.equal(input.cwd, expected);
    this.starts += 1;
    return inertProcess();
  }

  public get() {return inertRegistryProcess();}

  public evidence() {
    const plan = this.plans[0] as {
      readonly binaryRevision: string;
      readonly executableSha256: string;
    } | undefined;
    if (plan === undefined) {return;}
    const limitations = this.profile === "strict-linux-cgroup-v2"
      ? Object.freeze([])
      : Object.freeze(["descendant-may-escape-via-new-session"] as const);
    return Object.freeze({
      closure: Object.freeze({limitations, profile: this.profile, status: "closed" as const}),
      fingerprint: Object.freeze({
        argumentsSha256: "1".repeat(64), binaryRevision: plan.binaryRevision,
        containmentProfile: this.profile, environmentKeys: Object.freeze(["CLAUDE_AGENT_SDK_VERSION"]),
        executablePathSha256: "2".repeat(64), executableSha256: plan.executableSha256,
        fingerprintSha256: "3".repeat(64), intentMode: "analysis" as const,
        planSha256: "4".repeat(64), privatePathEnvironmentKeys: Object.freeze(["HOME"]),
        privateRootPathSha256: "5".repeat(64), providerBindingSha256: "6".repeat(64),
        spawnMode: "sdk-delegated" as const, workspaceSha256: "7".repeat(64),
      }),
      guardianExit: Object.freeze({code: 0, signal: null, status: "observed" as const}),
      identity: Object.freeze({
        binarySha256: plan.executableSha256, childProcessInstanceSha256: "8".repeat(64),
        hostLifecycleGenerationSha256: "9".repeat(64), pgid: 12, pid: 13,
        planSha256: "4".repeat(64), proofRef: "process-proof:opaque", status: "proved" as const,
      }),
      privateRoot: Object.freeze({identitySha256: "a".repeat(64), status: "deleted" as const}),
      providerExit: Object.freeze({code: 0, signal: null, status: "observed" as const}),
      sealed: true,
      spawn: "acknowledged" as const,
      stderr: Object.freeze({bytes: 0, sha256: "0".repeat(64), status: "complete" as const}),
      stdout: Object.freeze({bytes: 0, sha256: "0".repeat(64), status: "complete" as const}),
    });
  }

  public async requestContainment() {
    this.contained = true;
    return Object.freeze({kind: "contained" as const, receiptRef: "containment-receipt:opaque"});
  }

  public async release() {return Object.freeze({kind: "released" as const});}
}

const idsFor = (suffix: string) => Object.freeze({
  attemptId: containedTurnIdentity("attempt", `attempt:claude-platform:${suffix}`),
  authorityVectorDigest: digestContainedTurnCanonicalValue({suffix}),
  custodyId: containedTurnIdentity("custody", `custody:claude-platform:${suffix}`),
  commandId: containedTurnIdentity("command", `command:claude-platform:${suffix}`),
  effectId: containedTurnIdentity("effect", `effect:claude-platform:${suffix}`),
  operationCutoffRevision: containedTurnOperationCutoffRevision(0),
  operationId: containedTurnIdentity("operation", `operation:claude-platform:${suffix}`),
  operationRevision: 1,
  preparationToken: containedTurnIdentity("preparation", `preparation:claude-platform:${suffix}`),
  workspaceId: containedTurnIdentity("workspace", `workspace:claude-platform:${suffix}`),
});

const providerAccess = Object.freeze({
  accessRef: "access:opaque", credentialBindingDigest: "credential-digest:opaque",
  credentialBindingRef: "credential-binding:opaque", credentialGeneration: 1,
  ownerAuthorityDigest: "owner-authority:opaque", projectId: "project:test", provider: "claude" as const,
  providerAccountRef: "account:opaque", providerRouteRef: "route:opaque", revision: 1, tenantId: "tenant:test",
});

const exerciseComposedOwner = async (tuple: ClaudeAgentSdkPlatformTuple, cancellation = false) => {
  const ids = idsFor(tuple.platform);
  const host = new ProfileHost(tuple.containmentProfile);
  const snapshot = snapshotFor(tuple);
  const emitted: Array<Readonly<{cursor: number; text: string}>> = [];
  const rawProviderOutput = `provider-output-${tuple.platform}-must-not-enter-evidence`;
  let releaseDrain!: () => void;
  const drainGate = new Promise<void>(resolve => {releaseDrain = resolve;});
  const owner = createClaudeCurrentKernelOwner({
    adapterSnapshot: snapshot, executablePath, executableSha256: tuple.executableSha256,
    hostBootId: `host-boot:${tuple.platform}`, hostCustody: host as never,
    hostInstanceId: `host-instance:${tuple.platform}`,
    launchRecords: Object.freeze({resolve: async () => Object.freeze({privateProjection, privateRootPath: privateRoot})}),
    manifest: manifestFor(tuple), platformTarget: targetFor(tuple), privateDirectoryCustody,
    queryFactory(input) {
      const plan = host.plans[0] as {readonly arguments: readonly string[]; readonly environment: Readonly<Record<string, string>>};
      input.options.spawnClaudeCodeProcess({args: [...plan.arguments], command: executablePath,
        cwd: input.options.cwd, env: {...plan.environment}, signal: new AbortController().signal});
      return Object.freeze({close() {}, async interrupt() {releaseDrain();}, async *[Symbol.asyncIterator]() {
        yield delta(rawProviderOutput);
        if (cancellation) {await drainGate; return;}
        yield success(tuple.platform);
      }});
    },
    workspaceOwner: Object.freeze({async withLaunchAuthority(_input, consume) {
      return consume(Object.freeze({canonicalPath: workspaceRef, descriptorPath: "/opaque/descriptor/99",
        identity: Object.freeze({dev: 1n, ino: 2n, mountId: "mount:opaque"})}));
    }}),
  });
  const kernel = Object.freeze({...ids, adapterSnapshot: snapshot, providerAccessSnapshot: providerAccess});
  const openInput = Object.freeze({...kernel, intentMode: "analysis" as const});
  const opened = await owner.custody.open(openInput);
  const started = await owner.custody.start({
    attemptId: ids.attemptId, custodyId: ids.custodyId,
    execute: start => owner.provider.execute({...kernel,
      emit: async chunk => {emitted.push(Object.freeze({cursor: chunk.cursor, text: chunk.text}));},
      intent: Object.freeze({mode: "analysis" as const, prompt: "synthetic composed owner"}),
      isCancellationRequested: async () => cancellation, start,
    }),
    intentMode: "analysis",
    committedDispatchProof: committedDispatchProofFixture(openInput, opened), operationId: ids.operationId,
    workspaceId: ids.workspaceId,
  });
  assert.equal(started.kind, "execution_started");
  if (started.kind !== "execution_started") {throw new Error("composed start was not established");}
  const outcome = await started.execution;
  assert.equal(outcome.kind, cancellation ? "indeterminate" : "completed");
  assert.equal(host.starts, 1);
  assert.deepEqual(emitted.map(chunk => chunk.cursor), cancellation ? [] : [0]);
  const closure = await owner.custody.attestExecutionClosure({
    attemptId: ids.attemptId, custodyId: ids.custodyId, finalCursor: emitted.length, operationId: ids.operationId,
  });
  assert.equal(closure.kind, cancellation ? "indeterminate" : "proved");
  const containment = await owner.custody.requestPhysicalContainment({
    attemptId: ids.attemptId, custodyId: ids.custodyId, operationId: ids.operationId,
  });
  const canonicalEvidence = JSON.stringify({closure, containment, host: host.evidence()});
  assert.doesNotMatch(canonicalEvidence, new RegExp(workspaceRef, "u"));
  assert.doesNotMatch(canonicalEvidence, /credential-digest|provider-output|\/tmp\//u);
  owner.dispose();
  return containment;
};

test("composed owners bind exact Linux and Darwin targets, one delegated spawn, drain, and claim boundaries", async () => {
  assert.equal((await exerciseComposedOwner(CLAUDE_AGENT_SDK_LINUX_X64_TUPLE)).kind, "contained");
  assert.equal((await exerciseComposedOwner(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE)).kind, "indeterminate");
});

test("composed Darwin cancellation interrupts once, drains output, and retains cooperative-only containment", async () => {
  assert.equal((await exerciseComposedOwner(CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE, true)).kind, "indeterminate");
});

test("composed owners reject Linux and Darwin Host-profile swaps before delegated spawn", async () => {
  for (const [tuple, wrongProfile] of [
    [CLAUDE_AGENT_SDK_LINUX_X64_TUPLE, "cooperative-darwin-posix-process-group"],
    [CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE, "strict-linux-cgroup-v2"],
  ] as const) {
    const host = new ProfileHost(wrongProfile);
    const snapshot = snapshotFor(tuple);
    const ids = idsFor(`wrong-${tuple.platform}`);
    const owner = createClaudeCurrentKernelOwner({
      adapterSnapshot: snapshot, executablePath, executableSha256: tuple.executableSha256,
      hostBootId: "host-boot:wrong-profile", hostCustody: host as never,
      hostInstanceId: "host-instance:wrong-profile",
      launchRecords: Object.freeze({resolve: async () => Object.freeze({privateProjection, privateRootPath: privateRoot})}),
      manifest: manifestFor(tuple), platformTarget: targetFor(tuple), privateDirectoryCustody,
      workspaceOwner: Object.freeze({async withLaunchAuthority(_input, consume) {
        return consume(Object.freeze({canonicalPath: workspaceRef, descriptorPath: "/opaque/descriptor/99",
          identity: Object.freeze({dev: 1n, ino: 2n, mountId: "mount:opaque"})}));
      }}),
    });
    await assert.rejects(owner.custody.open({...ids, adapterSnapshot: snapshot, intentMode: "analysis",
      providerAccessSnapshot: providerAccess}), /Host profile mismatch/u);
    assert.equal(host.starts, 0);
    owner.dispose();
  }
});

test("exact Darwin target composes with cooperative Darwin Host custody without claiming physical proof",
  { skip: process.platform !== "darwin" }, () => {
  const tuple = CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE;
  const hostCustody = new DarwinCooperativeProcessCustody({
    launchPlans: Object.freeze({async resolve() {return;}}),
    platform: "darwin",
    processGroupObserver: Object.freeze({async observe() {return "unproven" as const;}}),
    processIdentityObserver: Object.freeze({async observe() {return {status: "unproven" as const};}}),
  });
  const owner = createClaudeCurrentKernelOwner({
    adapterSnapshot: snapshotFor(tuple), executablePath, executableSha256: tuple.executableSha256,
    hostBootId: "host-boot:darwin-cooperative-composition", hostCustody,
    hostInstanceId: "host-instance:darwin-cooperative-composition",
    launchRecords: Object.freeze({resolve: async () => Object.freeze({privateProjection, privateRootPath: privateRoot})}),
    manifest: manifestFor(tuple), platformTarget: targetFor(tuple), privateDirectoryCustody,
    workspaceOwner: Object.freeze({async withLaunchAuthority(_input, consume) {
      return consume(Object.freeze({canonicalPath: workspaceRef, descriptorPath: "/opaque/descriptor/99",
        identity: Object.freeze({dev: 1n, ino: 2n, mountId: "mount:opaque"})}));
    }}),
  });
  assert.ok(owner.custody);
  assert.ok(owner.provider);
  assert.equal(hostCustody.evidence("not-a-custody-ref"), undefined);
  owner.dispose();
  });
