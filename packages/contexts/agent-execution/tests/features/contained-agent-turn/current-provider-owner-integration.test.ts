import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  createContainedTurnFeature,
  createClaudeCurrentKernelOwner,
  createCodexCurrentKernelOwner,
} from "../../../dist/composition.js";
import { createCodexAppServerPermissionBoundary } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {
  CLAUDE_AGENT_SDK_PRODUCTION_TUPLE,
  createClaudeAgentSdkPrivateProjection,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { ClaudeAgentSdkCurrentKernelAdapter } from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-current-kernel-adapter.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createDependencies } from "../../features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import { containedTurnFactoryPortKeys } from "./support/current-provider-owner-composition-ports.ts";
import {
  codexCredentialOutputInventory, executeInput, FakeHost, ids, openInput,
  privateDirectoryCustody, syntheticCodexEffectCustody, workspaceOwner,
} from "./support/current-provider-owner-fixture.ts";

const claudeSnapshot = Object.freeze({
  adapterRevision: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.adapterRevision,
  binaryRevision: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.binaryRevision,
  capabilityManifestRevision: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.manifestRevision, provider: "claude" as const,
});

const claudeManifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation", effectClass: "contained_unmediated_effect",
  manifestRevision: claudeSnapshot.capabilityManifestRevision, manifestVersion: 1, provider: "claude" as const,
  providerAttemptCardinality: "at_most_one", requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.resourceScopeRevision,
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const), unknownCapabilityPolicy: "fail_closed",
});

const createClaimPathOwner = async (provider: "claude" | "codex", root: string, host: FakeHost) => {
  const workspaceRef = join(root, `${provider}-claim-workspace`);
  const privateRootPath = `${workspaceRef}-host-private`;
  await mkdir(workspaceRef, {recursive: true, mode: 0o700});
  const ownerWorkspace = Object.freeze({
    async withLaunchAuthority<Result>(_input: unknown, consume: (authority: any) => Promise<Result>): Promise<Result> {
      return consume(Object.freeze({
        canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
        identity: Object.freeze({dev: 1n, ino: 2n, mountId: `mount:${provider}:claim`}),
      }));
    },
  });
  if (provider === "codex") {
    const codexHome = join(privateRootPath, "home");
    const temp = join(privateRootPath, "temp");
    await Promise.all([mkdir(codexHome, {recursive: true, mode: 0o700}), mkdir(temp, {recursive: true, mode: 0o700})]);
    return createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(),
      hostBootId: "host-boot:claim-codex", hostCustody: host as any,
      hostInstanceId: "host-instance:claim-codex",
      platformTarget: {architecture: "x64", platform: "linux"},
      launchRecords: {resolve: async input => {
        return ({
        boundary: createCodexAppServerPermissionBoundary({codexHome, intentMode: input.intentMode, workspaceRef}),
        credentialOutputInventory: codexCredentialOutputInventory(input),
        executablePath: "/synthetic/codex", privateRootPath, tmpDir: temp,
        });
      }},
      workspaceOwner: ownerWorkspace,
    });
  }
  const [configRoot, homeRoot, tempRoot] = ["config", "home", "temp"].map(name => join(privateRootPath, name));
  await Promise.all([configRoot, homeRoot, tempRoot].map(path => mkdir(path, {recursive: true, mode: 0o700})));
  return createClaudeCurrentKernelOwner({
    adapterSnapshot: claudeSnapshot, executablePath: "/synthetic/claude", executableSha256: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.executableSha256,
    hostBootId: "host-boot:claim-claude", hostCustody: host as any,
    hostInstanceId: "host-instance:claim-claude",
    launchRecords: {resolve: async () => {
      const privateProjection = createClaudeAgentSdkPrivateProjection({
        configRoot, homeRoot, projectionRef: "projection:claude:claim", tempRoot, workspaceRef,
      });
      return ({privateProjection, privateRootPath});
    }},
    manifest: claudeManifest, privateDirectoryCustody,
    platformTarget: Object.freeze({architecture: "x64", platform: "linux"}),
    queryFactory: input => {
      const plan = host.plans.at(-1) as any;
      input.options.spawnClaudeCodeProcess({
        args: [...plan.arguments], command: "/synthetic/claude", cwd: input.options.cwd,
        env: {...plan.environment}, signal: new AbortController().signal,
      });
      return {close: () => {}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {
        yield Promise.reject(new Error("synthetic Claude reconciliation boundary"));
      }};
    },
    workspaceOwner: ownerWorkspace,
  });
};

const dependenciesForProvider = (fixture: ReturnType<typeof createDependencies>, provider: "claude" | "codex") => {
  const providerAccess = fixture.dependencies.providerAccess;
  const bindSnapshot = (
    snapshot: Extract<Awaited<ReturnType<typeof providerAccess.resolveForAcceptance>>, {kind: "resolved"}>["snapshot"],
    scope: Parameters<typeof providerAccess.resolveForAcceptance>[0]["scope"],
  ) => Object.freeze({...snapshot, projectId: scope.projectId, provider, tenantId: scope.tenantId});
  return Object.freeze({...fixture.dependencies, providerAccess: Object.freeze({...providerAccess,
    resolveForAcceptance: async (input: Parameters<typeof providerAccess.resolveForAcceptance>[0]) => {
      const outcome = await providerAccess.resolveForAcceptance(input);
      return outcome.kind === "resolved"
        ? Object.freeze({...outcome, snapshot: bindSnapshot(outcome.snapshot, input.scope)})
        : outcome;
    },
    revalidateForDispatch: async (input: Parameters<typeof providerAccess.revalidateForDispatch>[0]) => {
      const outcome = await providerAccess.revalidateForDispatch(input);
      return outcome.kind === "current"
        ? Object.freeze({...outcome, snapshot: bindSnapshot(outcome.snapshot, input.scope)})
        : outcome;
    },
  })});
};

test("provider owners keep stable kernel and random Host identities distinct and start only post-claim", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "current-provider-owner-")));
  try {
    const codexWorkspace = join(root, "codex-workspace");
    const codexPrivate = `${codexWorkspace}-host-private`;
    const codexHome = join(codexPrivate, "home");
    const codexTemp = join(codexPrivate, "temp");
    await Promise.all([mkdir(codexWorkspace, { mode: 0o700 }), mkdir(codexHome, { recursive: true, mode: 0o700 }),
      mkdir(codexTemp, { recursive: true, mode: 0o700 })]);
    const codexIds = ids("codex", "one");
    const codexHost = new FakeHost();
    const codex = createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(),
      hostBootId: "host-boot:current-owner", hostCustody: codexHost as any,
      hostInstanceId: "host-instance:current-owner",
      platformTarget: {architecture: "x64", platform: "linux"},
      launchRecords: {resolve: async input => ({
        boundary: createCodexAppServerPermissionBoundary({ codexHome, intentMode: input.intentMode, workspaceRef: codexWorkspace }),
        credentialOutputInventory: codexCredentialOutputInventory(input),
        executablePath: "/synthetic/codex", privateRootPath: codexPrivate, tmpDir: codexTemp,
      })},
      workspaceOwner: workspaceOwner(codexIds, codexWorkspace),
    });
    await codex.custody.open(openInput(codexIds, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT));
    await codex.custody.open(openInput(codexIds, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT));
    assert.equal(codexHost.reserves, 1);
    assert.equal(codexHost.starts, 0);
    assert.notEqual(codexHost.refs.get(codexIds.attemptId), codexIds.custodyId);
    assert.equal((await codex.provider.execute(executeInput(
      codexIds, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
    ))).kind, "indeterminate");
    assert.equal(codexHost.starts, 1);
    assert.equal((codexHost.startInputs[0] as {cwd: string}).cwd, "/proc/self/fd/4");

    const claudeWorkspace = join(root, "claude-workspace");
    const claudePrivate = `${claudeWorkspace}-host-private`;
    const [configRoot, homeRoot, tempRoot] = ["config", "home", "temp"].map(name => join(claudePrivate, name));
    await Promise.all([mkdir(claudeWorkspace, { mode: 0o700 }), ...[configRoot, homeRoot, tempRoot]
      .map(path => mkdir(path, { recursive: true, mode: 0o700 }))]);
    const claudeIds = ids("claude", "one");
    const claudeHost = new FakeHost();
    const originalCustodyPaths: string[] = [];
    let replacementCustodyCalls = 0;
    const mutablePrivateDirectoryCustody = {
      async assertPrivateDirectory(this: object, path: string): Promise<void> {
        assert.equal(Object.isFrozen(this), true);
        assert.equal(Object.getPrototypeOf(this), null);
        originalCustodyPaths.push(path);
        assert.equal((await stat(path)).isDirectory(), true);
      },
    };
    const claude = createClaudeCurrentKernelOwner({
      adapterSnapshot: claudeSnapshot, executablePath: "/synthetic/claude", executableSha256: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.executableSha256,
      hostBootId: "host-boot:current-owner", hostCustody: claudeHost as any,
      hostInstanceId: "host-instance:current-owner",
      launchRecords: {resolve: async () => ({
        privateProjection: createClaudeAgentSdkPrivateProjection({
          configRoot, homeRoot, projectionRef: "projection:claude:one", tempRoot, workspaceRef: claudeWorkspace,
        }), privateRootPath: claudePrivate,
      })},
      manifest: Object.freeze({
        effectCardinality: "one_coarse_effect_per_operation", effectClass: "contained_unmediated_effect",
        manifestRevision: claudeSnapshot.capabilityManifestRevision, manifestVersion: 1, provider: "claude" as const,
        providerAttemptCardinality: "at_most_one", requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
        resourceScopeRevision: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.resourceScopeRevision,
        supportedModes: Object.freeze(["analysis", "workspace-write"] as const), unknownCapabilityPolicy: "fail_closed",
      }),
      privateDirectoryCustody: mutablePrivateDirectoryCustody,
      platformTarget: Object.freeze({architecture: "x64", platform: "linux"}),
      queryFactory: input => {
        input.options.spawnClaudeCodeProcess({
          args: [...(claudeHost.plans[0] as any).arguments], command: "/synthetic/claude",
          cwd: input.options.cwd, env: {...(claudeHost.plans[0] as any).environment}, signal: new AbortController().signal,
        });
        return {close: () => {}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {
          yield Promise.reject(new Error("stop"));
        }};
      },
      workspaceOwner: workspaceOwner(claudeIds, claudeWorkspace),
    });
    mutablePrivateDirectoryCustody.assertPrivateDirectory = async () => {replacementCustodyCalls += 1;};
    await claude.custody.open(openInput(claudeIds, "claude", claudeSnapshot));
    assert.deepEqual(originalCustodyPaths, [claudeWorkspace, configRoot, homeRoot, tempRoot]);
    assert.equal(replacementCustodyCalls, 0);
    assert.equal(claudeHost.starts, 0);
    assert.notEqual(claudeHost.refs.get(claudeIds.attemptId), claudeIds.custodyId);
    assert.equal((await claude.provider.execute(executeInput(claudeIds, "claude", claudeSnapshot))).kind, "indeterminate");
    assert.deepEqual(originalCustodyPaths, [
      claudeWorkspace, configRoot, homeRoot, tempRoot,
      claudeWorkspace, configRoot, homeRoot, tempRoot,
    ]);
    assert.equal(replacementCustodyCalls, 0);
    assert.equal(claudeHost.reserves, 1);
    assert.equal(claudeHost.starts, 1);
    codex.dispose(); claude.dispose();
  } finally {await rm(root, { recursive: true, force: true });}
});

test("Codex Darwin owner delegates the canonical workspace to cooperative Host Custody", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-darwin-owner-cwd-")));
  try {
    const workspaceRef = join(root, "workspace");
    const privateRootPath = `${workspaceRef}-host-private`;
    const codexHome = join(privateRootPath, "home");
    const tmpDir = join(privateRootPath, "tmp");
    await Promise.all([
      mkdir(workspaceRef, {mode: 0o700}),
      mkdir(codexHome, {recursive: true, mode: 0o700}),
      mkdir(tmpDir, {recursive: true, mode: 0o700}),
    ]);
    const identity = ids("codex", "darwin-cwd");
    const host = new FakeHost();
    const platformTarget = {architecture: "arm64", platform: "darwin"};
    const owner = createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(), hostBootId: "host-boot:darwin-cwd",
      hostCustody: host as any, hostInstanceId: "host-instance:darwin-cwd",
      launchRecords: {resolve: async input => ({
        boundary: createCodexAppServerPermissionBoundary({codexHome, intentMode: input.intentMode, workspaceRef}),
        credentialOutputInventory: codexCredentialOutputInventory(input),
        executablePath: "/synthetic/codex-darwin-arm64", privateRootPath, tmpDir,
      })},
      platformTarget: platformTarget as never,
      workspaceOwner: workspaceOwner(identity, workspaceRef),
    });
    platformTarget.architecture = "x64";
    platformTarget.platform = "linux";
    const snapshot = owner.provider.adapterSnapshot;
    await owner.custody.open(openInput(identity, "codex", snapshot));
    assert.equal((await owner.provider.execute(executeInput(identity, "codex", snapshot))).kind, "indeterminate");
    assert.equal(host.starts, 1);
    assert.equal((host.startInputs[0] as {cwd: string}).cwd, workspaceRef);
    assert.notEqual((host.startInputs[0] as {cwd: string}).cwd, "/proc/self/fd/4");
    owner.dispose();
  } finally {await rm(root, {recursive: true, force: true});}
});

test("Codex and Claude current owners start only after the real atomic claim and cannot replay", async t => {
  for (const provider of ["codex", "claude"] as const) {
    await t.test(provider, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), `current-owner-real-claim-${provider}-`)));
      try {
        const host = new FakeHost();
        const owner = await createClaimPathOwner(provider, root, host);
        const fixture = createDependencies();
        const selected = dependenciesForProvider(fixture, provider);
        const originalStore = selected.operationStore;
        let capturedClaim: Parameters<typeof originalStore.claimPreparedDispatch>[0] | undefined;
        let releaseClaim!: () => void;
        let reportClaimReached!: () => void;
        const claimGate = new Promise<void>(resolve => {releaseClaim = resolve;});
        const claimReached = new Promise<void>(resolve => {reportClaimReached = resolve;});
        const dependencies = Object.freeze({
          ...selected,
          custody: owner.custody,
          operationStore: Object.freeze({
            ...originalStore,
            claimPreparedDispatch: async (input: Parameters<typeof originalStore.claimPreparedDispatch>[0]) => {
              capturedClaim = input;
              reportClaimReached();
              await claimGate;
              return originalStore.claimPreparedDispatch(input);
            },
          }),
          provider: owner.provider,
        });
        const feature = createContainedTurnFeature(dependencies);
        const submission = feature.submit.execute({
          commandId: `command:real-claim:${provider}`,
          expectedProvider: provider,
          intent: {mode: "analysis", prompt: "Inspect this disposable claim fixture."},
          scope: {projectId: "project:one", tenantId: "tenant:one"},
        });
        await claimReached;
        assert.equal(host.reserves, 1);
        assert.equal(host.starts, 0, "neither Host nor provider may start before atomic claim");
        releaseClaim();
        const result = await submission;
        assert.equal(host.starts, 1, "the winning atomic claim permits exactly one start");
        assert.equal(result.status, "observed");
        assert.ok(result.status === "observed" && ["reconcile_required", "succeeded"].includes(result.turn.status));
        assert.ok(host.containments > 0, "started execution must reach containment before closure or reconciliation");
        assert.ok(capturedClaim);
        const replay = await originalStore.claimPreparedDispatch(capturedClaim);
        assert.equal(replay.kind, "observed_claim");
        assert.equal(host.starts, 1, "a second claim observation cannot start again");
        assert.ok(host.releases > 0 || result.status === "observed" && result.turn.status === "reconcile_required");
        owner.dispose();

        const preventedHost = new FakeHost();
        const preventedOwner = await createClaimPathOwner(provider, join(root, "prevented"), preventedHost);
        const preventedFixture = createDependencies({dispatchPrevented: true});
        const preventedSelected = dependenciesForProvider(preventedFixture, provider);
        const preventedFeature = createContainedTurnFeature(Object.freeze({
          ...preventedSelected, custody: preventedOwner.custody, provider: preventedOwner.provider,
        }));
        const prevented = await preventedFeature.submit.execute({
          commandId: `command:prevented:${provider}`,
          expectedProvider: provider,
          intent: {mode: "analysis", prompt: "This dispatch must be prevented."},
          scope: {projectId: "project:one", tenantId: "tenant:one"},
        });
        assert.equal(prevented.status, "observed");
        assert.equal(preventedHost.starts, 0);
        assert.equal(preventedHost.reserves, 1);
        assert.equal(preventedHost.releases, 1);
        preventedOwner.dispose();
      } finally {await rm(root, {recursive: true, force: true});}
    });
  }
});

test("prevention retires a prepared attempt without a Host or provider start", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "current-owner-prevention-")));
  try {
    const workspaceRef = join(root, "workspace");
    const privateRootPath = `${workspaceRef}-host-private`;
    const codexHome = join(privateRootPath, "home");
    const temp = join(privateRootPath, "temp");
    await Promise.all([mkdir(workspaceRef, {mode: 0o700}), mkdir(codexHome, {recursive: true, mode: 0o700}),
      mkdir(temp, {recursive: true, mode: 0o700})]);
    const identity = ids("codex", "prevented");
    const host = new FakeHost();
    const owner = createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(),
      hostBootId: "host-boot:prevention", hostCustody: host as any,
      hostInstanceId: "host-instance:prevention",
      platformTarget: {architecture: "x64", platform: "linux"},
      launchRecords: {resolve: async input => ({
        boundary: createCodexAppServerPermissionBoundary({codexHome, intentMode: input.intentMode, workspaceRef}),
        credentialOutputInventory: codexCredentialOutputInventory(input),
        executablePath: "/synthetic/codex", privateRootPath, tmpDir: temp,
      })},
      workspaceOwner: workspaceOwner(identity, workspaceRef),
    });
    await assert.rejects(owner.custody.open(openInput({
      ...identity,
      custodyId: containedTurnIdentity("custody", "custody:codex:wrong-operation"),
      operationId: containedTurnIdentity("operation", "operation:codex:wrong-operation"),
    }, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT)));
    assert.equal(host.reserves, 0);
    await owner.custody.open(openInput(identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT));
    await owner.custody.releaseReservation({...identity, reason: "prevention", workspaceId: identity.workspaceId});
    assert.equal((await owner.provider.execute(executeInput(
      identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
    ))).kind, "indeterminate");
    assert.equal(host.reserves, 1);
    assert.equal(host.starts, 0);
    owner.dispose();
  } finally {await rm(root, {recursive: true, force: true});}
});

test("same-provider attempts retain distinct exact plans and reject crossed workspace authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "current-owner-plans-")));
  try {
    const identities = [ids("codex", "plan-a"), ids("codex", "plan-b")] as const;
    const records = new Map<string, {codexHome: string; privateRootPath: string; temp: string; workspaceRef: string}>();
    for (const [index, identity] of identities.entries()) {
      const workspaceRef = join(root, `workspace-${index}`);
      const privateRootPath = `${workspaceRef}-host-private`;
      const codexHome = join(privateRootPath, "home");
      const temp = join(privateRootPath, "temp");
      await Promise.all([mkdir(workspaceRef, {mode: 0o700}), mkdir(codexHome, {recursive: true, mode: 0o700}),
        mkdir(temp, {recursive: true, mode: 0o700})]);
      records.set(identity.workspaceId, {codexHome, privateRootPath, temp, workspaceRef});
    }
    const host = new FakeHost();
    const owner = createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(),
      hostBootId: "host-boot:plans", hostCustody: host as any, hostInstanceId: "host-instance:plans",
      platformTarget: {architecture: "x64", platform: "linux"},
      launchRecords: {resolve: async input => {
        const record = records.get(input.workspaceId);
        if (record === undefined || record.workspaceRef !== input.workspaceAuthority.canonicalPath) {return;}
        return {
          boundary: createCodexAppServerPermissionBoundary({...record, intentMode: input.intentMode}), executablePath: "/synthetic/codex",
          credentialOutputInventory: codexCredentialOutputInventory(input),
          privateRootPath: record.privateRootPath, tmpDir: record.temp,
        };
      }},
      workspaceOwner: {async withLaunchAuthority(input: any, consume: (authority: any) => Promise<unknown>) {
        const record = records.get(input.workspaceId);
        if (record === undefined) {throw new TypeError("workspace identity mismatch");}
        return consume({
          canonicalPath: record.workspaceRef, descriptorPath: `/synthetic/${input.attemptId}`,
          identity: {dev: 1n, ino: BigInt(records.size), mountId: `mount:${input.attemptId}`},
        });
      }} as any,
    });
    for (const identity of identities) {
      await owner.custody.open(openInput(identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT));
    }
    assert.equal(host.reserves, 2);
    assert.notEqual((host.plans[0] as any).privateRootPath, (host.plans[1] as any).privateRootPath);
    assert.notEqual(host.refs.get(identities[0].attemptId), host.refs.get(identities[1].attemptId));
    const crossed = ids("codex", "crossed");
    await assert.rejects(owner.custody.open(openInput(
      crossed, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
    )), /workspace identity mismatch/u);
    assert.equal(host.reserves, 2);
    owner.dispose();
  } finally {await rm(root, {recursive: true, force: true});}
});

test("duplicate and late Claude private callbacks remain effect-free", async () => {
  const snapshot = claudeSnapshot;
  const manifest = claudeManifest;
  const identity = ids("claude", "callback");
  const execution = Object.freeze({
    custodyRef: "urn:agent-runtime:host-custody:random-callback",
    privateProjection: Object.freeze({environment: Object.freeze({}), projectionRef: "projection:test"}),
    workspaceRef: "/synthetic/workspace",
  });
  const host = new FakeHost();
  const duplicate = new ClaudeAgentSdkCurrentKernelAdapter({
    adapterSnapshot: snapshot, executablePath: "/synthetic/claude", manifest,
    privateDirectoryCustody,
    platformTuple: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE,
    privateExecutions: {async consume(input, callback) {
      const first = callback(execution); void callback(execution); return first;
    }},
    processes: host as any,
  });
  assert.equal((await duplicate.execute(executeInput(identity, "claude", snapshot))).kind, "indeterminate");
  assert.equal(host.starts, 0);
  let late: ((value: typeof execution) => Promise<unknown>) | undefined;
  const lateAdapter = new ClaudeAgentSdkCurrentKernelAdapter({
    adapterSnapshot: snapshot, executablePath: "/synthetic/claude", manifest,
    privateDirectoryCustody,
    platformTuple: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE,
    privateExecutions: {async consume(input, callback) {late = callback; return null as never;}},
    processes: host as any,
  });
  assert.equal((await lateAdapter.execute(executeInput(identity, "claude", snapshot))).kind, "indeterminate");
  assert.ok(late);
  assert.equal(((await late(execution)) as {kind: string}).kind, "indeterminate");
  assert.equal(host.starts, 0);
});

test("public root remains path-free and outer composition retains the exact seven ports", async () => {
  assert.throws(() => createCodexCurrentKernelOwner({} as never), /No exact/u);
  assert.throws(() => createCodexCurrentKernelOwner({
    platformTarget: {architecture: "x64", platform: "linux"},
  } as never),
    /workspace-write requires effect custody/u);
  const publicRoot = await readFile(new URL("../../../dist/index.d.ts", import.meta.url), "utf8");
  for (const privateName of ["CurrentKernelOwner", "custodyRef", "descriptorPath", "privateRootPath"]) {
    assert.doesNotMatch(publicRoot, new RegExp(privateName, "u"));
  }
  const composition = await readFile(new URL(
    "../../../../../apps/embedded-runtime/src/composition/contained-turn-feature-composition.ts", import.meta.url,
  ), "utf8");
  const supplied = containedTurnFactoryPortKeys(composition);
  assert.deepEqual(supplied, ["operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider"]);
  assert.doesNotMatch(composition, /production/u);
});

// Exercise the same submission seam retained by both live harnesses, using
// current owners and synthetic transports. No provider executable is invoked.
test("live canary submission uses current owner contracts and rejects substituted dispatch proofs", async t => {
  const { submitContainedTurnLiveCanary } = await import("../../live/contained-turn-live-canary-lifecycle.mjs");
  const { committedDispatchProofV1 } = await import("../../../dist/features/contained-agent-turn/domain/committed-dispatch-proof-v1.js");
  for (const provider of ["codex", "claude"] as const) {
    for (const mutation of ["none", "fabricated", "stale", "mismatched"] as const) {
      await t.test(`${provider}: ${mutation}`, async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "live-canary-contract-")));
        try {
          const host = new FakeHost();
          const owner = await createClaimPathOwner(provider, root, host);
          const fixture = createDependencies();
          const selected = dependenciesForProvider(fixture, provider);
          let starts = 0;
          let opens = 0;
          const custody = Object.freeze({
            attestContainment: owner.custody.attestContainment.bind(owner.custody),
            attestExecutionClosure: owner.custody.attestExecutionClosure.bind(owner.custody),
            completionBoundary: owner.custody.completionBoundary.bind(owner.custody),
            ensurePhysicalContainment: owner.custody.ensurePhysicalContainment.bind(owner.custody),
            queryContainmentAttestation: owner.custody.queryContainmentAttestation.bind(owner.custody),
            queryPhysicalContainment: owner.custody.queryPhysicalContainment.bind(owner.custody),
            releaseReservation: owner.custody.releaseReservation.bind(owner.custody),
            releaseRetiredReservation: owner.custody.releaseRetiredReservation.bind(owner.custody),
            requestContainment: owner.custody.requestContainment.bind(owner.custody),
            requestPhysicalContainment: owner.custody.requestPhysicalContainment.bind(owner.custody),
            open: async (input: Parameters<typeof owner.custody.open>[0]) => {
              opens += 1;
              assert.equal(typeof input.commandId, "string");
              assert.equal(typeof input.operationRevision, "number");
              assert.equal(typeof input.operationCutoffRevision, "number");
              assert.equal(typeof input.preparationToken, "string");
              return owner.custody.open(input);
            },
            start: async (input: Parameters<typeof owner.custody.start>[0]) => {
              starts += 1;
              assert.equal(host.starts, 0);
              assert.equal(input.intentMode, "analysis");
              assert.equal("intent" in input || "startAuthority" in input, false);
              assert.equal(fixture.current()?.dispatch.kind, "claimed");
              if (mutation === "none") {return owner.custody.start(input);}
              const {proofDigest: _digest, ...seed} = input.committedDispatchProof;
              const proof = mutation === "fabricated"
                ? {...input.committedDispatchProof, proofDigest: `sha256:${"0".repeat(64)}`}
                : committedDispatchProofV1({...seed, ...(mutation === "stale"
                  ? {committedOperationRevision: seed.committedOperationRevision + 1}
                  : {commandId: containedTurnIdentity("command", "command:foreign")})});
              return owner.custody.start({...input, committedDispatchProof: proof as never});
            },
          });
          const command = {
            commandId: `command:canary:${provider}:${mutation}`, expectedProvider: provider,
            intent: {mode: "analysis" as const, prompt: "synthetic current-owner contract"},
            scope: {projectId: "project:one", tenantId: "tenant:one"},
          };
          let accepted = false;
          const operationStore = Object.freeze({
            ...selected.operationStore,
            accept: async (...input: Parameters<typeof selected.operationStore.accept>) => {
              if (!accepted) {
                accepted = true;
                return selected.operationStore.accept(...input);
              }
              const operation = fixture.current();
              if (operation === undefined) {throw new Error("live canary replay lacks accepted operation");}
              return {kind: "replayed" as const, operation};
            },
          });
          const dependencies = {...selected, custody, operationStore, provider: owner.provider};
          const result = await submitContainedTurnLiveCanary({
            command, dependencies, owner,
          });
          assert.equal(opens, 1);
          assert.equal(starts, 1);
          assert.equal(host.starts, mutation === "none" ? 1 : 0);
          assert.equal(result.turn.status, "reconcile_required");
          assert.equal(result.turn.commandId, command.commandId);
          assert.equal(result.turn.operationId, fixture.current()?.operationId);
          assert.equal(result.turn.effectId, fixture.current()?.effectId);
          const replay = await createContainedTurnFeature(dependencies).submit.execute(command);
          assert.equal(replay.status, "observed");
          assert.equal(opens, 1);
          assert.equal(starts, 1);
        } finally {await rm(root, {recursive: true, force: true});}
      });
    }
  }
});
