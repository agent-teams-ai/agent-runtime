import assert from "node:assert/strict";
import { Core, fixture as reservationFixture, directory, spawnCount } from "../native-launch-finalization-fixture.ts";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createCodexCurrentKernelOwner } from "../../../../dist/features/contained-agent-turn/composition/codex-current-kernel-owner.js";
import { createClaudeCurrentKernelOwner } from "../../../../dist/features/contained-agent-turn/composition/claude-current-kernel-owner.js";
import { createContainedTurnFeature } from "../../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { createCodexAppServerPermissionBoundary } from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CLAUDE_AGENT_SDK_PRODUCTION_TUPLE as tuple, createClaudeAgentSdkPrivateProjection } from "../../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import type { ContainedTurnKernelCustodyPort } from "../../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import type { ContainedTurnHostPostClaimPreparation } from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-contracts.js";
import { codexCredentialOutputInventory, ids, openInput, privateDirectoryCustody, syntheticCodexEffectCustody } from "./current-provider-owner-fixture.ts";
import { createDependencies } from "./contained-agent-turn-fixture.ts";
import { committedDispatchProofFixture } from "./committed-dispatch-proof-fixture.ts";

export type Preparation = ContainedTurnHostPostClaimPreparation;
export type PrepareInput = Parameters<Preparation["prepareClaimed"]>[0];
export const deferred = <Value>() => {
  let complete!: (value: Value) => void;
  const promise = new Promise<Value>(resolve => {complete = resolve;});
  return {promise, resolve: complete};
};
export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});

export const ownerPreparationFixture = async (t: TestContext, provider: "codex" | "claude") => {
  // Retain real core branding, reservation, evidence and cleanup. Only low-level
  // filesystem/executable/residue observations are synthetic; no platform bypass.
  const reservation = await reservationFixture(false);
  const workspaceRef = reservation.options.boundary.workspaceRef;
  const privateRootPath = reservation.options.privateRootPath;
  const [homeRoot, tempRoot, configRoot] = ["home", "temp", "config"].map(name => join(privateRootPath, name));
  for (const path of [workspaceRef, homeRoot, tempRoot, configRoot]) {directory(path!);}
  const executablePath = reservation.options.executablePath;
  const events: string[] = [];
  const residueAuthorityFactory = {create: async () => ({close: async () => true,
    proveEmpty: async () => "empty", killAll: async () => true})};
  const core = new Core({launchPlans: {resolve: async () => {throw new Error("unexpected launch resolver");}},
    residueAuthorityFactory} as never, {containmentProfile: "strict-linux-cgroup-v2", platform: "linux",
    residueAuthorityFactory} as never);
  const host = Object.assign(core, {starts: 0, reserves: 0, releases: 0, containments: 0,
    refs: new Map<string, string>()});
  const reserve = core.reserve.bind(core);
  host.reserve = async input => {
    host.reserves += 1;
    const result = await reserve(input);
    host.refs.set(input.attemptId, result.custodyRef);
    return result;
  };
  const contain = core.requestContainment.bind(core);
  host.requestContainment = async input => {host.containments += 1; return contain(input);};
  const release = core.release.bind(core);
  host.release = async input => {
    const result = await release(input);
    if (result.kind === "released") {host.releases += 1;}
    return result;
  };
  const initialSpawns = spawnCount();
  t.after(() => assert.equal(spawnCount(), initialSpawns, "forwarding never launches a provider"));
  // Tripwires: a test can reach the kernel's synthetic creator, never provider/native creation.
  host.start = () => {events.push("forbidden-provider-start"); throw new Error("provider process creation is forbidden");};
  host.get = () => {events.push("forbidden-provider-get"); throw new Error("provider process access is forbidden");};
  const common = {
    hostBootId: "host-boot:owner-preparation", hostInstanceId: "host-instance:owner-preparation", hostCustody: host as never,
    platformTarget: {architecture: "x64", platform: "linux"} as const,
    workspaceOwner: {async withLaunchAuthority<Result>(_input: unknown, consume: (authority: any) => Promise<Result>) {
      events.push("workspace");
      return consume(reservation.workspaceAuthority);
    }},
  };
  const codexOptions: Parameters<typeof createCodexCurrentKernelOwner>[0] = {...common,
    effectCustody: syntheticCodexEffectCustody(),
    launchRecords: {async resolve(input) {
      events.push("launch-record");
      if (input.credentialGeneration !== 1) {throw new Error("Unexpected fixture credential generation");}
      return {boundary: createCodexAppServerPermissionBoundary({codexHome: homeRoot!, intentMode: input.intentMode, workspaceRef}),
        credentialOutputInventory: codexCredentialOutputInventory({credentialBindingDigest: input.credentialBindingDigest,
          credentialGeneration: input.credentialGeneration}), executablePath,
        privateRootPath, tmpDir: tempRoot!};
    }},
  };
  const claudeOptions: Parameters<typeof createClaudeCurrentKernelOwner>[0] = {...common,
    adapterSnapshot: {provider: "claude", adapterRevision: tuple.adapterRevision, binaryRevision: tuple.binaryRevision,
      capabilityManifestRevision: tuple.manifestRevision},
    executablePath, executableSha256: tuple.executableSha256,
    manifest: {effectCardinality: "one_coarse_effect_per_operation", effectClass: "contained_unmediated_effect",
      manifestRevision: tuple.manifestRevision, manifestVersion: 1, provider: "claude", providerAttemptCardinality: "at_most_one",
      requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS, resourceScopeRevision: tuple.resourceScopeRevision,
      supportedModes: ["analysis", "workspace-write"], unknownCapabilityPolicy: "fail_closed"},
    launchRecords: {async resolve() {
      events.push("launch-record");
      return {privateRootPath, privateProjection: createClaudeAgentSdkPrivateProjection({configRoot: configRoot!, homeRoot: homeRoot!,
        tempRoot: tempRoot!, workspaceRef, projectionRef: "projection:owner-preparation"})};
    }}, privateDirectoryCustody,
    queryFactory: () => {events.push("forbidden-sdk-query"); throw new Error("SDK execution is forbidden");},
  };
  const construct = (options: object) => provider === "codex"
    ? createCodexCurrentKernelOwner(options as typeof codexOptions)
    : createClaudeCurrentKernelOwner(options as typeof claudeOptions);
  const options = provider === "codex" ? codexOptions : claudeOptions;
  const create = (extra: {postClaimPreparation?: Preparation} = {}) => {
    const selected = {...options, ...extra};
    const owner = construct(selected);
    t.after(() => owner.dispose());
    return {owner, selected};
  };
  t.after(() => assert.equal(events.some(event => event.startsWith("forbidden-")), false));
  return {construct, create, events, host, options, provider};
};

export const openOwner = async (fixture: Awaited<ReturnType<typeof ownerPreparationFixture>>,
  owner: ReturnType<typeof fixture.construct>) => {
  const identity = ids(fixture.provider, "preparation");
  const input = openInput(identity, fixture.provider, owner.provider.adapterSnapshot);
  const opened = await owner.custody.open(input);
  const proof = committedDispatchProofFixture(input, opened);
  const start: Parameters<ContainedTurnKernelCustodyPort["start"]>[0] = {...identity,
    intentMode: "analysis", committedDispatchProof: proof,
    async execute(boundary) {
      fixture.events.push("execute");
      boundary.createProcess(() => {fixture.events.push("synthetic-creator");});
      return {kind: "completed", outcome: "succeeded"};
    },
  };
  return {identity, input, opened, proof, start, release: () => owner.custody.releaseReservation({...identity, reason: "claim_lost"})};
};

export const claimFeature = (fixture: Awaited<ReturnType<typeof ownerPreparationFixture>>,
  owner: ReturnType<typeof fixture.construct>, mode: "acknowledged" | "prevented" | "lost-ack" = "acknowledged") => {
  const kernel = createDependencies({dispatchPrevented: mode === "prevented", claimCommitThenThrow: mode === "lost-ack"});
  const dependencies = kernel.dependencies;
  const providerAccess = dependencies.providerAccess;
  const bind = (snapshot: any, scope: any) => ({...snapshot, ...scope, provider: fixture.provider});
  let acknowledgedProof: PrepareInput["committedDispatchProof"] | undefined;
  const feature = createContainedTurnFeature({...dependencies, custody: owner.custody,
    // Keep the actual factory's custody and metadata; the existing synthetic kernel provider owns execution.
    provider: {...dependencies.provider, adapterSnapshot: owner.provider.adapterSnapshot, manifest: owner.provider.manifest},
    providerAccess: {...providerAccess,
      async resolveForAcceptance(input) {
        const result = await providerAccess.resolveForAcceptance(input);
        return result.kind === "resolved" ? {...result, snapshot: bind(result.snapshot, input.scope)} : result;
      },
      async revalidateForDispatch(input) {
        const result = await providerAccess.revalidateForDispatch(input);
        return result.kind === "current" ? {...result, snapshot: bind(result.snapshot, input.scope)} : result;
      },
    },
    operationStore: {...dependencies.operationStore,
      async accept(candidate, authority) {
        const current = kernel.current();
        return current === undefined ? dependencies.operationStore.accept(candidate, authority) : {kind: "replayed", operation: current};
      },
      async claimPreparedDispatch(input) {
        fixture.events.push("claim-requested");
        const result = await dependencies.operationStore.claimPreparedDispatch(input);
        if (result.kind === "claimed") {acknowledgedProof = result.committedDispatchProof; fixture.events.push("claim-acknowledged");}
        return result;
      },
    },
  });
  const submission = {commandId: `command:preparation:${fixture.provider}`, expectedProvider: fixture.provider,
    intent: {mode: "analysis" as const, prompt: "Synthetic owner forwarding only."}, scope: {projectId: "project:one", tenantId: "tenant:one"}};
  return {feature, kernel, proof: () => acknowledgedProof, submission};
};
