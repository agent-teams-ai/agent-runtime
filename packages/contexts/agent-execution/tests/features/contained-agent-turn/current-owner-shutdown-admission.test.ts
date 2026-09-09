import assert from "node:assert/strict";
import test from "node:test";
import {createCodexCurrentKernelOwner} from "../../../dist/features/contained-agent-turn/composition/codex-current-kernel-owner.js";
import {createClaudeCurrentKernelOwner} from "../../../dist/features/contained-agent-turn/composition/claude-current-kernel-owner.js";
import {createDockerCodexHostKernelOwner} from "../../../dist/features/contained-agent-turn/composition/docker-codex-host-kernel-owner.js";
import {CLAUDE_AGENT_SDK_PRODUCTION_TUPLE as tuple} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import {CONTAINED_TURN_REQUIRED_PROOF_KINDS} from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";

// Each owner gets a new in-memory synthetic fixture. No filesystem, provider,
// credential, Docker, or network operation is permitted by these dependencies.
for (const provider of ["codex", "claude", "docker"] as const) {
  test(`${provider} current owner forwards its private admission fence before any dependency effect`, async () => {
    let effects = 0;
    const forbidden = (): never => {effects++; throw new Error("unexpected synthetic dependency effect");};
    const common = {
      hostBootId: "host-boot:shutdown", hostInstanceId: "host-instance:shutdown",
      platformTarget: {platform: "linux" as const, architecture: "x64" as const},
      workspaceOwner: {withLaunchAuthority: forbidden}, launchRecords: {resolve: forbidden},
      effectCustody: {admit: forbidden},
      hostCustody: {get: forbidden, start: forbidden, reserve: forbidden, open: forbidden,
        evidence: forbidden, requestContainment: forbidden, release: forbidden},
    };
    const owner = provider === "docker"
      ? createDockerCodexHostKernelOwner({...common, cleanupMilliseconds: 100, preparation: forbidden})
      : provider === "codex" ? createCodexCurrentKernelOwner(common as never)
        : createClaudeCurrentKernelOwner({...common,
          executablePath: "/synthetic/never-executed", executableSha256: tuple.executableSha256,
          adapterSnapshot: {provider: "claude", adapterRevision: tuple.adapterRevision,
            binaryRevision: tuple.binaryRevision, capabilityManifestRevision: tuple.manifestRevision},
          manifest: {provider: "claude", manifestVersion: 1, manifestRevision: tuple.manifestRevision,
            resourceScopeRevision: tuple.resourceScopeRevision, effectClass: "contained_unmediated_effect",
            effectCardinality: "one_coarse_effect_per_operation", providerAttemptCardinality: "at_most_one",
            unknownCapabilityPolicy: "fail_closed", supportedModes: ["analysis", "workspace-write"],
            requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS},
          privateDirectoryCustody: {assertPrivateDirectory: forbidden},
        } as never);
    owner.sealAdmission(); owner.sealAdmission();
    await assert.rejects(owner.custody.open({} as never), /admission is unavailable/u);
    await assert.rejects(owner.custody.start({} as never), /admission is unavailable/u);
    assert.equal(effects, 0);
    owner.dispose(); owner.dispose();
    await assert.rejects(owner.custody.open({} as never), /admission is unavailable/u);
    assert.equal(effects, 0);
  });
}
