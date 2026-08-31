import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  createContainedTurnFeature,
  createClaudeCurrentKernelOwner,
  createCodexCurrentKernelOwner,
  NodeProviderProcessCustody,
} from "../dist/composition.js";
import { createCodexAppServerPermissionBoundary } from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT } from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {
  createClaudeAgentSdkLaunchPlan,
  createClaudeAgentSdkPrivateProjection,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { ClaudeAgentSdkCurrentKernelAdapter } from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-current-kernel-adapter.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { privateHostCustodyReservationTestSupport } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.js";
import { createDependencies } from "./features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

const ids = (provider: "claude" | "codex", suffix: string) => Object.freeze({
  attemptId: containedTurnIdentity("attempt", `attempt:${provider}:${suffix}`),
  authorityVectorDigest: digestContainedTurnCanonicalValue({ provider, suffix }),
  custodyId: containedTurnIdentity("custody", `custody:${provider}:${suffix}`),
  effectId: containedTurnIdentity("effect", `effect:${provider}:${suffix}`),
  operationId: containedTurnIdentity("operation", `operation:${provider}:${suffix}`),
  workspaceId: containedTurnIdentity("workspace", `workspace:opaque:${provider}:${suffix}`),
});

const access = (provider: "claude" | "codex") => Object.freeze({
  accessRef: `access:${provider}`, credentialBindingDigest: digestContainedTurnCanonicalValue({ provider }),
  credentialBindingRef: `credential-binding:${provider}`, credentialGeneration: 1,
  ownerAuthorityDigest: `owner:${provider}`, projectId: "project:test", provider,
  providerAccountRef: `account:${provider}`, providerRouteRef: `route:${provider}`,
  revision: 1, tenantId: "tenant:test",
});

class FakeHost {
  readonly plans: unknown[] = [];
  readonly refs = new Map<string, string>();
  reserves = 0;
  releases = 0;
  starts = 0;
  contained = false;
  containments = 0;
  async reserve(input: any) {
    this.reserves += 1;
    const custodyRef = `urn:agent-runtime:host-custody:random-${this.reserves}`;
    this.refs.set(input.attemptId, custodyRef);
    this.plans.push(input.launchPlan);
    return Object.freeze({ custodyRef });
  }
  async open() {throw new Error("owner integration must use reserve");}
  start(custodyRef: string) {
    assert.ok([...this.refs.values()].includes(custodyRef));
    this.starts += 1;
    return Object.freeze({
      exitCode: null, killed: false, stdin: {}, stdout: {}, kill: () => true,
      off: () => {}, on: () => {}, once: () => {},
    });
  }
  get(custodyRef: string) {
    if (![...this.refs.values()].includes(custodyRef)) {return null;}
    return Object.freeze({
      closeInput: async () => {}, custodyRef, stderr: emptyBytes(), stdout: emptyBytes(),
      waitForExit: async () => ({ code: 0, signal: null }),
      workspaceAuthorityPath: "/proc/self/fd/4" as const, write: async () => {},
    });
  }
  evidence(custodyRef: string) {
    if (![...this.refs.values()].includes(custodyRef)) {return null;}
    const started = this.starts > 0;
    const provedNoStart = !started && this.contained;
    return Object.freeze({
      closure: Object.freeze({
        limitations: Object.freeze([]), profile: "strict-linux-cgroup-v2",
        status: started ? "closed" : provedNoStart ? "not-started" : "unproven",
      }),
      fingerprint: Object.freeze({
        argumentsSha256: "1".repeat(64), binaryRevision: "binary:test", containmentProfile: "strict-linux-cgroup-v2",
        environmentKeys: Object.freeze([]), executablePathSha256: "2".repeat(64), executableSha256: "3".repeat(64),
        fingerprintSha256: "4".repeat(64), intentMode: "analysis", planSha256: "5".repeat(64),
        privatePathEnvironmentKeys: Object.freeze([]), privateRootPathSha256: "6".repeat(64),
        providerBindingSha256: "7".repeat(64), spawnMode: "sdk-delegated", workspaceSha256: "8".repeat(64),
      }),
      guardianExit: started ? Object.freeze({code: 0, signal: null, status: "observed"}) : Object.freeze({status: "unobserved"}),
      identity: started ? Object.freeze({
        binarySha256: "3".repeat(64), childProcessInstanceSha256: "9".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), pgid: 101, pid: 102,
        planSha256: "5".repeat(64), proofRef: "process-proof:test", status: "proved",
      }) : Object.freeze({
        binarySha256: "0".repeat(64), childProcessInstanceSha256: "0".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), planSha256: "0".repeat(64), status: "not-started",
      }),
      privateRoot: Object.freeze({identitySha256: "b".repeat(64), status: started ? "deleted" : "active"}),
      providerExit: started ? Object.freeze({code: 0, signal: null, status: "observed"}) : Object.freeze({status: "not-started"}),
      sealed: started || provedNoStart, spawn: started ? "acknowledged" : "never-started",
      stderr: Object.freeze({bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : provedNoStart ? "not-started" : "incomplete"}),
      stdout: Object.freeze({bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : provedNoStart ? "not-started" : "incomplete"}),
    });
  }
  async requestContainment() {
    this.contained = true;
    this.containments += 1;
    return Object.freeze({ kind: "contained" as const, receiptRef: "receipt:test" });
  }
  async release() {this.releases += 1; return Object.freeze({ kind: "released" as const });}
}
async function* emptyBytes(): AsyncIterable<Uint8Array> {}

const privateDirectoryCustody = Object.freeze({
  async assertPrivateDirectory(path: string): Promise<void> {
    assert.equal((await stat(path)).isDirectory(), true);
  },
});

const workspaceOwner = (expected: ReturnType<typeof ids>, workspaceRef: string) => Object.freeze({
  async withLaunchAuthority<Result>(input: any, consume: (authority: any) => Promise<Result>): Promise<Result> {
    assert.deepEqual(input, {
      attemptId: expected.attemptId, operationId: expected.operationId, workspaceId: expected.workspaceId,
    });
    return consume(Object.freeze({
      canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
      identity: Object.freeze({ dev: 1n, ino: 2n, mountId: "mount:test" }),
    }));
  },
});

const openInput = (identity: ReturnType<typeof ids>, provider: "claude" | "codex", snapshot: any) => ({
  adapterSnapshot: snapshot, ...identity, intentMode: "analysis" as const, providerAccessSnapshot: access(provider),
});
const executeInput = (identity: ReturnType<typeof ids>, provider: "claude" | "codex", snapshot: any) => ({
  adapterSnapshot: snapshot, ...identity, emit: async () => {},
  intent: Object.freeze({ mode: "analysis" as const, prompt: "Inspect this disposable workspace." }),
  isCancellationRequested: async () => false, providerAccessSnapshot: access(provider),
  start: Object.freeze({
    createProcess<Process>(create: () => Process): Process {return create();},
    observation: Promise.resolve(Object.freeze({
      evidenceId: containedTurnIdentity("evidence", `evidence:${provider}:synthetic-start`),
      kind: "indeterminate" as const,
    })),
  }),
});

const claudeSnapshot = Object.freeze({
  adapterRevision: "claude:test", binaryRevision: "claude-binary:test",
  capabilityManifestRevision: "claude-manifest:test", provider: "claude" as const,
});

const claudeManifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation", effectClass: "contained_unmediated_effect",
  manifestRevision: claudeSnapshot.capabilityManifestRevision, manifestVersion: 1, provider: "claude" as const,
  providerAttemptCardinality: "at_most_one", requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: "contained-workspace-network-credential:1",
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
      hostBootId: "host-boot:claim-codex", hostCustody: host as any,
      hostInstanceId: "host-instance:claim-codex",
      launchRecords: {resolve: async () => {
        return ({
        boundary: createCodexAppServerPermissionBoundary({codexHome, workspaceRef}),
        executablePath: "/synthetic/codex", privateRootPath, tmpDir: temp,
        });
      }},
      workspaceOwner: ownerWorkspace,
    });
  }
  const [configRoot, homeRoot, tempRoot] = ["config", "home", "temp"].map(name => join(privateRootPath, name));
  await Promise.all([configRoot, homeRoot, tempRoot].map(path => mkdir(path, {recursive: true, mode: 0o700})));
  return createClaudeCurrentKernelOwner({
    adapterSnapshot: claudeSnapshot, executablePath: "/synthetic/claude", executableSha256: "a".repeat(64),
    hostBootId: "host-boot:claim-claude", hostCustody: host as any,
    hostInstanceId: "host-instance:claim-claude",
    launchRecords: {resolve: async () => {
      const privateProjection = createClaudeAgentSdkPrivateProjection({
        configRoot, homeRoot, projectionRef: "projection:claude:claim", tempRoot, workspaceRef,
      });
      return ({privateProjection, privateRootPath});
    }},
    manifest: claudeManifest, privateDirectoryCustody,
    queryFactory: input => {
      const plan = host.plans.at(-1) as any;
      input.options.spawnClaudeCodeProcess({
        args: [...plan.arguments], command: "/synthetic/claude", cwd: workspaceRef,
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
  const root = await mkdtemp(join(tmpdir(), "current-provider-owner-"));
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
      hostBootId: "host-boot:current-owner", hostCustody: codexHost as any,
      hostInstanceId: "host-instance:current-owner",
      launchRecords: {resolve: async () => ({
        boundary: createCodexAppServerPermissionBoundary({ codexHome, workspaceRef: codexWorkspace }),
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
      adapterSnapshot: claudeSnapshot, executablePath: "/synthetic/claude", executableSha256: "a".repeat(64),
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
        resourceScopeRevision: "contained-workspace-network-credential:1",
        supportedModes: Object.freeze(["analysis", "workspace-write"] as const), unknownCapabilityPolicy: "fail_closed",
      }),
      privateDirectoryCustody: mutablePrivateDirectoryCustody,
      queryFactory: input => {
        input.options.spawnClaudeCodeProcess({
          args: [...(claudeHost.plans[0] as any).arguments], command: "/synthetic/claude",
          cwd: claudeWorkspace, env: {...(claudeHost.plans[0] as any).environment}, signal: new AbortController().signal,
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

test("Codex and Claude current owners start only after the real atomic claim and cannot replay", async t => {
  for (const provider of ["codex", "claude"] as const) {
    await t.test(provider, async () => {
      const root = await mkdtemp(join(tmpdir(), `current-owner-real-claim-${provider}-`));
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

test("raw Host reservation rejects a replaced filesystem descriptor before launch effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-owner-handoff-"));
  try {
    const expected = join(root, "expected");
    const replacement = join(root, "replacement");
    await Promise.all([mkdir(expected, { mode: 0o700 }), mkdir(replacement, { mode: 0o700 })]);
    const expectedIdentity = await stat(expected, { bigint: true });
    const replacementHandle = await open(replacement, "r");
    try {
      const host = new NodeProviderProcessCustody({launchPlans: {resolve: async () => {}}});
      await assert.rejects(host.reserve({
        attemptId: "attempt:handoff", intentMode: "analysis",
        launchPlan: Object.freeze({
          arguments: Object.freeze([]), binaryRevision: "binary:test",
          containmentProfile: "strict-linux-cgroup-v2", environment: Object.freeze({HOME: "/invalid"}),
          executablePath: "/invalid", executableSha256: "0".repeat(64), intentMode: "analysis",
          privateRootPath: "/invalid-private", provider: "codex", spawnMode: "sdk-delegated",
        }),
        operationId: "operation:handoff",
        providerBinding: Object.freeze({
          adapterRevision: "adapter:test", binaryRevision: "binary:test",
          capabilityManifestRevision: "manifest:test", credentialBindingDigest: "credential:test",
          provider: "codex", providerRouteRef: "route:test",
        }),
        workspaceAuthority: Object.freeze({
          canonicalPath: expected, descriptorPath: `/proc/self/fd/${replacementHandle.fd}`,
          identity: Object.freeze({dev: expectedIdentity.dev, ino: expectedIdentity.ino, mountId: "mount:test"}),
        }),
        workspaceRef: expected,
      }), /workspace descriptor identity mismatch/u);
    } finally {await replacementHandle.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test("raw Host reservation rejects exact path, device and inode on a substituted mount before provider effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-owner-mount-identity-"));
  try {
    const workspaceRef = join(root, "workspace");
    const privateRootPath = `${workspaceRef}-host-private`;
    const configRoot = join(privateRootPath, "config");
    const homeRoot = join(privateRootPath, "home");
    const temp = join(privateRootPath, "temp");
    await Promise.all([mkdir(workspaceRef, {mode: 0o700}), mkdir(privateRootPath, {mode: 0o700})]);
    await Promise.all([mkdir(configRoot, {mode: 0o700}), mkdir(homeRoot, {mode: 0o700}), mkdir(temp, {mode: 0o700})]);
    const authorityHandle = await open(workspaceRef, "r");
    try {
      const identity = await authorityHandle.stat({bigint: true});
      const fdinfo = await readFile(`/proc/self/fdinfo/${authorityHandle.fd}`, "utf8");
      const mountId = /^mnt_id:\s*(\d+)$/mu.exec(fdinfo)?.[1];
      assert.ok(mountId);
      const projection = createClaudeAgentSdkPrivateProjection({
        configRoot, homeRoot, projectionRef: "projection:mount-substitution", tempRoot: temp, workspaceRef,
      });
      const plan = await createClaudeAgentSdkLaunchPlan({
        binaryRevision: claudeSnapshot.binaryRevision,
        executablePath: process.execPath,
        executableSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
        intentMode: "analysis", privateDirectoryCustody, privateProjection: projection, privateRootPath, workspaceRef,
      });
      const effects = {descriptorCloses: 0, guardianAuthorizations: 0, providerStarts: 0};
      const host = new NodeProviderProcessCustody({
        launchPlans: {resolve: async () => {}},
        residueAuthorityFactory: Object.freeze({async create() {return Object.freeze({
          async attachGuardian() {effects.guardianAuthorizations += 1; return true;},
          async close() {return true;}, async killAll() {return true;}, async proveEmpty() {return "empty" as const;},
        });}}),
      });
      privateHostCustodyReservationTestSupport.install(host, {
        descriptorLifecycle: event => {if (event === "closed") {effects.descriptorCloses += 1;}},
        mountIdentity: observation => observation.phase === "launch"
          ? `${observation.actualMountId}:substituted`
          : observation.actualMountId,
      });
      const reservation = await host.reserve({
        attemptId: "attempt:mount-substitution", intentMode: "analysis",
        launchPlan: plan,
        operationId: "operation:mount-substitution",
        providerBinding: Object.freeze({
          adapterRevision: claudeSnapshot.adapterRevision, binaryRevision: claudeSnapshot.binaryRevision,
          capabilityManifestRevision: "manifest:test", credentialBindingDigest: "credential:test",
          provider: "claude", providerRouteRef: "route:test",
        }),
        workspaceAuthority: Object.freeze({
          canonicalPath: workspaceRef, descriptorPath: `/proc/self/fd/${authorityHandle.fd}`,
          identity: Object.freeze({dev: identity.dev, ino: identity.ino, mountId}),
        }),
        workspaceRef,
      });
      assert.equal(host.get(reservation.custodyRef), undefined);
      assert.throws(() => host.start(reservation.custodyRef, {
        arguments: plan.arguments, command: plan.executablePath, cwd: "/proc/self/fd/4",
        environment: plan.environment, signal: new AbortController().signal,
      }), {name: "HostCustodyLaunchRejectedError"});
      effects.providerStarts += host.get(reservation.custodyRef) === undefined ? 0 : 1;
      assert.deepEqual(effects, {descriptorCloses: 1, guardianAuthorizations: 0, providerStarts: 0});
      assert.equal(host.evidence(reservation.custodyRef)?.spawn, "never-started");
    } finally {await authorityHandle.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test("throwing reserved-plan getters and reservation validation close retained authority exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-owner-reservation-exception-"));
  try {
    const workspaceRef = join(root, "workspace");
    await mkdir(workspaceRef, {mode: 0o700});
    const authorityHandle = await open(workspaceRef, "r");
    try {
      const identity = await authorityHandle.stat({bigint: true});
      const fdinfo = await readFile(`/proc/self/fdinfo/${authorityHandle.fd}`, "utf8");
      const mountId = /^mnt_id:\s*(\d+)$/mu.exec(fdinfo)?.[1];
      assert.ok(mountId);
      for (const failureKind of ["plan-getter", "mount-validation"] as const) {
        const closes: string[] = [];
        const host = new NodeProviderProcessCustody({launchPlans: {resolve: async () => {}}});
        privateHostCustodyReservationTestSupport.install(host, {
          descriptorLifecycle: event => {if (event === "closed") {closes.push(event);}},
          ...(failureKind === "mount-validation" ? {
            mountIdentity: ({actualMountId}: {actualMountId: string}) => `${actualMountId}:invalid`,
          } : {}),
        });
        const planFailure = new Error("synthetic throwing plan getter");
        const launchPlan = failureKind === "plan-getter"
          ? Object.defineProperty({}, "arguments", {enumerable: true, get() {throw planFailure;}})
          : Object.freeze({arguments: Object.freeze([]), environment: Object.freeze({})});
        await assert.rejects(host.reserve({
          attemptId: `attempt:${failureKind}`, intentMode: "analysis", launchPlan: launchPlan as never,
          operationId: `operation:${failureKind}`,
          providerBinding: Object.freeze({
            adapterRevision: "adapter:test", binaryRevision: "binary:test",
            capabilityManifestRevision: "manifest:test", credentialBindingDigest: "credential:test",
            provider: "codex", providerRouteRef: "route:test",
          }),
          workspaceAuthority: Object.freeze({
            canonicalPath: workspaceRef, descriptorPath: `/proc/self/fd/${authorityHandle.fd}`,
            identity: Object.freeze({dev: identity.dev, ino: identity.ino, mountId}),
          }), workspaceRef,
        }), error => failureKind === "plan-getter" ? error === planFailure : error instanceof TypeError);
        assert.deepEqual(closes, ["closed"]);
      }
    } finally {await authorityHandle.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test("prevention retires a prepared attempt without a Host or provider start", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-owner-prevention-"));
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
      hostBootId: "host-boot:prevention", hostCustody: host as any,
      hostInstanceId: "host-instance:prevention",
      launchRecords: {resolve: async () => ({
        boundary: createCodexAppServerPermissionBoundary({codexHome, workspaceRef}),
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
  const root = await mkdtemp(join(tmpdir(), "current-owner-plans-"));
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
      hostBootId: "host-boot:plans", hostCustody: host as any, hostInstanceId: "host-instance:plans",
      launchRecords: {resolve: async input => {
        const record = records.get(input.workspaceId);
        if (record === undefined || record.workspaceRef !== input.workspaceAuthority.canonicalPath) {return;}
        return {
          boundary: createCodexAppServerPermissionBoundary(record), executablePath: "/synthetic/codex",
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
  const snapshot = Object.freeze({
    adapterRevision: "claude:test", binaryRevision: "claude-binary:test",
    capabilityManifestRevision: "claude-manifest:test", provider: "claude" as const,
  });
  const manifest = Object.freeze({
    effectCardinality: "one_coarse_effect_per_operation", effectClass: "contained_unmediated_effect",
    manifestRevision: snapshot.capabilityManifestRevision, manifestVersion: 1, provider: "claude" as const,
    providerAttemptCardinality: "at_most_one", requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
    resourceScopeRevision: "contained-workspace-network-credential:1",
    supportedModes: Object.freeze(["analysis", "workspace-write"] as const), unknownCapabilityPolicy: "fail_closed",
  });
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
    privateExecutions: {async consume(input, callback) {late = callback; return null as never;}},
    processes: host as any,
  });
  assert.equal((await lateAdapter.execute(executeInput(identity, "claude", snapshot))).kind, "indeterminate");
  assert.ok(late);
  assert.equal(((await late(execution)) as {kind: string}).kind, "indeterminate");
  assert.equal(host.starts, 0);
});

test("public root remains path-free and outer composition retains the exact seven ports", async () => {
  const publicRoot = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
  for (const privateName of ["CurrentKernelOwner", "custodyRef", "descriptorPath", "privateRootPath"]) {
    assert.doesNotMatch(publicRoot, new RegExp(privateName, "u"));
  }
  const composition = await readFile(new URL(
    "../../../apps/embedded-runtime/src/composition/contained-turn-feature-composition.ts", import.meta.url,
  ), "utf8");
  const supplied = [...composition.matchAll(/^  (operationStore|security|providerAccess|workspace|artifacts|custody|provider):/gmu)]
    .map(match => match[1]);
  assert.deepEqual(supplied, ["operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider"]);
  assert.doesNotMatch(composition, /production/u);
});
