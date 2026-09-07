import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  createClaudeCurrentKernelOwner,
  createCodexCurrentKernelOwner,
} from "../../../dist/composition.js";
import { createCodexAppServerPermissionBoundary } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {
  CLAUDE_AGENT_SDK_PRODUCTION_TUPLE,
  createClaudeAgentSdkPrivateProjection,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import {
  codexCredentialOutputInventory, FakeHost, ids, openInput,
  privateDirectoryCustody, syntheticCodexEffectCustody,
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

// Deliberately permissive (unlike the fixture's identity-asserting workspaceOwner):
// this test opens a *second*, differently-identified attempt after dispose, so the
// stand-in must accept any identity rather than reject the mismatch itself.
const permissiveWorkspaceOwner = (workspaceRef: string) => Object.freeze({
  async withLaunchAuthority<Result>(_input: unknown, consume: (authority: any) => Promise<Result>): Promise<Result> {
    return consume(Object.freeze({
      canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
      identity: Object.freeze({ dev: 1n, ino: 2n, mountId: "mount:dispose-refutation" }),
    }));
  },
});

type HostCounters = {
  containments: number; plans: number; refs: number; releases: number; startInputs: number; starts: number;
};
const hostCounters = (host: FakeHost): HostCounters => ({
  containments: host.containments, plans: host.plans.length, refs: host.refs.size,
  releases: host.releases, startInputs: host.startInputs.length, starts: host.starts,
});

test("Codex current-kernel owner dispose clears only in-memory records; Host Custody sees no calls", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-owner-dispose-")));
  try {
    const workspaceRef = join(root, "workspace");
    const privateRootPath = `${workspaceRef}-host-private`;
    const homeRoot = join(privateRootPath, "home");
    const tempRoot = join(privateRootPath, "temp");
    await Promise.all([
      mkdir(workspaceRef, { mode: 0o700 }),
      mkdir(homeRoot, { recursive: true, mode: 0o700 }),
      mkdir(tempRoot, { recursive: true, mode: 0o700 }),
    ]);
    const identity = ids("codex", "dispose");
    const host = new FakeHost();
    const owner = createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(),
      hostBootId: "host-boot:dispose-codex", hostCustody: host as any,
      hostInstanceId: "host-instance:dispose-codex",
      platformTarget: { architecture: "x64", platform: "linux" },
      launchRecords: { resolve: async input => ({
        boundary: createCodexAppServerPermissionBoundary({ codexHome: homeRoot, intentMode: input.intentMode, workspaceRef }),
        credentialOutputInventory: codexCredentialOutputInventory(input),
        executablePath: "/synthetic/codex", privateRootPath, tmpDir: tempRoot,
      }) },
      workspaceOwner: permissiveWorkspaceOwner(workspaceRef),
    });

    // Populate the owner's private `records` Map with a real, retained (non-empty) entry.
    await owner.custody.open(openInput(identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT));
    assert.equal(host.reserves, 1, "precondition: the attempt is reserved, so records has a live entry to clear");

    const beforeDispose = hostCounters(host);
    owner.dispose();
    owner.dispose(); // repeated dispose must be a no-op, not a second round of cleanup

    assert.deepEqual(
      hostCounters(host), beforeDispose,
      "dispose() must not call hostCustody.reserve/start/get/requestContainment/release: " +
      "codex-current-kernel-owner.ts dispose() only runs `disposed = true; records.clear();`",
    );

    // The disposed guard must fire in-memory for a brand-new attempt too, again without
    // ever reaching Host Custody (proves clearing was real, not just a no-op flag).
    const afterIdentity = ids("codex", "dispose-after");
    await assert.rejects(
      () => owner.custody.open(openInput(afterIdentity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT)),
      /unavailable/u,
    );
    assert.deepEqual(hostCounters(host), beforeDispose, "the rejected post-dispose attempt still never reaches Host Custody");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude current-kernel owner dispose clears only in-memory records; Host Custody sees no calls", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-owner-dispose-")));
  try {
    const workspaceRef = join(root, "workspace");
    const privateRootPath = `${workspaceRef}-host-private`;
    const [configRoot, homeRoot, tempRoot] = ["config", "home", "temp"].map(name => join(privateRootPath, name));
    await Promise.all([
      mkdir(workspaceRef, { mode: 0o700 }),
      ...[configRoot, homeRoot, tempRoot].map(path => mkdir(path, { recursive: true, mode: 0o700 })),
    ]);
    const identity = ids("claude", "dispose");
    const host = new FakeHost();
    const owner = createClaudeCurrentKernelOwner({
      adapterSnapshot: claudeSnapshot, executablePath: "/synthetic/claude",
      executableSha256: CLAUDE_AGENT_SDK_PRODUCTION_TUPLE.executableSha256,
      hostBootId: "host-boot:dispose-claude", hostCustody: host as any,
      hostInstanceId: "host-instance:dispose-claude",
      launchRecords: { resolve: async () => ({
        privateProjection: createClaudeAgentSdkPrivateProjection({
          configRoot, homeRoot, projectionRef: "projection:claude:dispose", tempRoot, workspaceRef,
        }),
        privateRootPath,
      }) },
      manifest: claudeManifest, privateDirectoryCustody,
      platformTarget: { architecture: "x64", platform: "linux" },
      workspaceOwner: permissiveWorkspaceOwner(workspaceRef),
    });

    await owner.custody.open(openInput(identity, "claude", claudeSnapshot));
    assert.equal(host.reserves, 1, "precondition: the attempt is reserved, so records has a live entry to clear");

    const beforeDispose = hostCounters(host);
    owner.dispose();
    owner.dispose(); // repeated dispose must be a no-op, not a second round of cleanup

    assert.deepEqual(
      hostCounters(host), beforeDispose,
      "dispose() must not call hostCustody.reserve/start/get/requestContainment/release: " +
      "claude-current-kernel-owner.ts dispose() only runs `disposed = true; records.clear();`",
    );

    const afterIdentity = ids("claude", "dispose-after");
    await assert.rejects(
      () => owner.custody.open(openInput(afterIdentity, "claude", claudeSnapshot)),
      /unavailable/u,
    );
    assert.deepEqual(hostCounters(host), beforeDispose, "the rejected post-dispose attempt still never reaches Host Custody");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
