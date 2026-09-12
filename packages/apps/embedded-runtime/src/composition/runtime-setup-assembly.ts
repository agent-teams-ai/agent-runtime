import { defineModule } from "@get-modular/core";
import { assemblyFor, type CapabilityContract } from "@get-modular/assembly";
import { createAgentRuntimeHost, type AgentRuntimeHost, type AgentRuntimeHostDependencies, type CodexSetupCapabilityBundle, type ClaudeCodeSetupCapabilityBundle } from "./agent-runtime-host.js";
import { randomBytes } from "node:crypto";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV2,
  createClaudeCodeConfigurationSourceReaderAdapter,
  createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1,
  createNodeClaudeCodeConfigurationDigest,
  createNodeCodexConfigurationDigest,
  createNodeConfigurationSourceReader,
  createSmolTomlParser,
  createStrictClaudeCodeJsonParser,
} from "@agent-teams/runtime-configuration/composition";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "@agent-teams/runtime-security/composition";

import { createCodexSetupInspectionPlanner } from "./codex-setup-inspection-planner.js";
import { createClaudeCodeSetupInspectionPlanner } from "./claude-code-setup-inspection-planner.js";

const compatibility = { family: "exact", familyVersion: 1, token: "agent-runtime/setup-v1" } as const;
export type RuntimeSetupCapabilities = {
  "agent-runtime/codex-authorization": CapabilityContract<CodexSetupCapabilityBundle["authorizeSetupInspection"], "agent-runtime/setup-v1">;
  "agent-runtime/claude-authorization": CapabilityContract<ClaudeCodeSetupCapabilityBundle["authorizeClaudeCodeSetupInspection"], "agent-runtime/setup-v1">;
  "agent-runtime/codex-installations": CapabilityContract<CodexSetupCapabilityBundle["discoverCodexInstallations"], "agent-runtime/setup-v1">;
  "agent-runtime/claude-installations": CapabilityContract<ClaudeCodeSetupCapabilityBundle["discoverClaudeCodeInstallations"], "agent-runtime/setup-v1">;
  "agent-runtime/codex-configuration": CapabilityContract<CodexSetupCapabilityBundle["inspectCodexConfiguration"], "agent-runtime/setup-v1">;
  "agent-runtime/claude-configuration": CapabilityContract<ClaudeCodeSetupCapabilityBundle["inspectClaudeCodeConfiguration"], "agent-runtime/setup-v1">;
  "agent-runtime/codex-planner": CapabilityContract<CodexSetupCapabilityBundle["planCodexSetupInspection"], "agent-runtime/setup-v1">;
  "agent-runtime/claude-planner": CapabilityContract<ClaudeCodeSetupCapabilityBundle["planClaudeCodeSetupInspection"], "agent-runtime/setup-v1">;
};
const setupSecurityDeclaration = defineModule({
  kind: "get-modular.module-declaration", schemaVersion: 1,
  moduleId: "agent-runtime/setup-security", implementationId: "agent-runtime/setup-security",
  owner: { authority: "agent-teams", path: ["runtime-security"] },
  provides: [
    { capabilityId: "agent-runtime/codex-authorization", compatibility },
    { capabilityId: "agent-runtime/claude-authorization", compatibility },
  ], slots: [
  ],
});
const installationDiscoveryDeclaration = defineModule({
  kind: "get-modular.module-declaration", schemaVersion: 1,
  moduleId: "agent-runtime/installation-discovery", implementationId: "agent-runtime/installation-discovery",
  owner: { authority: "agent-teams", path: ["agent-execution"] },
  provides: [
    { capabilityId: "agent-runtime/codex-installations", compatibility },
    { capabilityId: "agent-runtime/claude-installations", compatibility },
  ], slots: [
  ],
});
const codexConfigurationDeclaration = defineModule({
  kind: "get-modular.module-declaration", schemaVersion: 1,
  moduleId: "agent-runtime/codex-configuration", implementationId: "agent-runtime/codex-configuration",
  owner: { authority: "agent-teams", path: ["runtime-configuration"] },
  provides: [
    { capabilityId: "agent-runtime/codex-configuration", compatibility },
  ], slots: [
  ],
});
const claudeConfigurationDeclaration = defineModule({
  kind: "get-modular.module-declaration", schemaVersion: 1,
  moduleId: "agent-runtime/claude-configuration", implementationId: "agent-runtime/claude-configuration",
  owner: { authority: "agent-teams", path: ["runtime-configuration"] },
  provides: [
    { capabilityId: "agent-runtime/claude-configuration", compatibility },
  ], slots: [
  ],
});
const codexPlannerDeclaration = defineModule({
  kind: "get-modular.module-declaration", schemaVersion: 1,
  moduleId: "agent-runtime/codex-planner", implementationId: "agent-runtime/codex-planner",
  owner: { authority: "agent-teams", path: ["embedded-runtime"] },
  provides: [
    { capabilityId: "agent-runtime/codex-planner", compatibility },
  ], slots: [
  ],
});
const claudePlannerDeclaration = defineModule({
  kind: "get-modular.module-declaration", schemaVersion: 1,
  moduleId: "agent-runtime/claude-planner", implementationId: "agent-runtime/claude-planner",
  owner: { authority: "agent-teams", path: ["embedded-runtime"] },
  provides: [
    { capabilityId: "agent-runtime/claude-planner", compatibility },
  ], slots: [
  ],
});
const runtimeHostDeclaration = defineModule({
  kind: "get-modular.module-declaration", schemaVersion: 1,
  moduleId: "agent-runtime/runtime-host", implementationId: "agent-runtime/runtime-host",
  owner: { authority: "agent-teams", path: ["embedded-runtime"] },
  provides: [
  ], slots: [
    { slotId: "authorize-setup-inspection", capabilityId: "agent-runtime/codex-authorization", compatibility, cardinality: { kind: "required" } },
    { slotId: "authorize-claude-code-setup-inspection", capabilityId: "agent-runtime/claude-authorization", compatibility, cardinality: { kind: "required" } },
    { slotId: "discover-codex-installations", capabilityId: "agent-runtime/codex-installations", compatibility, cardinality: { kind: "required" } },
    { slotId: "discover-claude-code-installations", capabilityId: "agent-runtime/claude-installations", compatibility, cardinality: { kind: "required" } },
    { slotId: "inspect-codex-configuration", capabilityId: "agent-runtime/codex-configuration", compatibility, cardinality: { kind: "required" } },
    { slotId: "inspect-claude-code-configuration", capabilityId: "agent-runtime/claude-configuration", compatibility, cardinality: { kind: "required" } },
    { slotId: "plan-codex-setup-inspection", capabilityId: "agent-runtime/codex-planner", compatibility, cardinality: { kind: "required" } },
    { slotId: "plan-claude-code-setup-inspection", capabilityId: "agent-runtime/claude-planner", compatibility, cardinality: { kind: "required" } },
  ],
});
export const runtimeSetupDeclarations = [setupSecurityDeclaration, installationDiscoveryDeclaration, codexConfigurationDeclaration, claudeConfigurationDeclaration, codexPlannerDeclaration, claudePlannerDeclaration, runtimeHostDeclaration] as const;
export const runtimeSetupProfile = {
  kind: "get-modular.composition-profile", schemaVersion: 1, profileId: "agent-runtime/passive-setup",
  roots: [runtimeHostDeclaration.moduleId],
  selections: runtimeSetupDeclarations.map(({ moduleId, implementationId }) => ({ moduleId, implementationId })),
  bindings: [
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "authorize-setup-inspection", providerImplementationIds: [setupSecurityDeclaration.implementationId] },
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "authorize-claude-code-setup-inspection", providerImplementationIds: [setupSecurityDeclaration.implementationId] },
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "discover-codex-installations", providerImplementationIds: [installationDiscoveryDeclaration.implementationId] },
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "discover-claude-code-installations", providerImplementationIds: [installationDiscoveryDeclaration.implementationId] },
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "inspect-codex-configuration", providerImplementationIds: [codexConfigurationDeclaration.implementationId] },
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "inspect-claude-code-configuration", providerImplementationIds: [claudeConfigurationDeclaration.implementationId] },
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "plan-codex-setup-inspection", providerImplementationIds: [codexPlannerDeclaration.implementationId] },
    { consumerImplementationId: runtimeHostDeclaration.implementationId, slotId: "plan-claude-code-setup-inspection", providerImplementationIds: [claudePlannerDeclaration.implementationId] },
  ],
} as const;

export const createRuntimeSetupFactories = (platform: NodeJS.Platform) => ({
  security: async () => createSetupInspectionAuthorizationFeature({ pathCanonicalizer: createNodePathCanonicalizer() }),
  discovery: async () => createRuntimeInstallationDiscoveryFeature({ executableFileObserver: createNodeExecutableFileObserver() }),
  codexConfiguration: async () => createCodexConfigurationInspectionFeature({ digest: createNodeCodexConfigurationDigest(), parser: createSmolTomlParser(), semanticClassifier: createCodexConfigurationSemanticClassifierV1(), sourceIdentityKey: randomBytes(32), sourceReader: createNodeConfigurationSourceReader() }),
  claudeConfiguration: async () => createClaudeCodeConfigurationInspectionFeature({ digest: createNodeClaudeCodeConfigurationDigest(), parser: createStrictClaudeCodeJsonParser(), semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(), sourceIdentityKey: randomBytes(32), sourceReader: createClaudeCodeConfigurationSourceReaderAdapter() }),
  codexPlanner: async () => createCodexSetupInspectionPlanner(platform),
  claudePlanner: async () => createClaudeCodeSetupInspectionPlanner(platform),
  host: (dependencies: AgentRuntimeHostDependencies) => createAgentRuntimeHost(dependencies),
});
export type RuntimeSetupFactories = ReturnType<typeof createRuntimeSetupFactories>;

// Fixed owner-local completion seam for synthetic envelope/ownership tests.
export type RuntimeSetupRootProduct = { readonly instance: AgentRuntimeHost; readonly capabilities: Record<string, never> };
export type RuntimeSetupRootCompletion = (product: RuntimeSetupRootProduct) => Promise<RuntimeSetupRootProduct>;

export function bindRuntimeSetup(factories: RuntimeSetupFactories, captureHost: (host: AgentRuntimeHost) => void,
  completeRoot?: RuntimeSetupRootCompletion) {
  const assembly = assemblyFor<RuntimeSetupCapabilities>();
  const setupSecurity = assembly.bindFactory(setupSecurityDeclaration, async () => {
    const instance = await factories.security();
    return { instance, capabilities: {
      "agent-runtime/codex-authorization": instance.authorizeSetupInspection,
      "agent-runtime/claude-authorization": instance.authorizeClaudeCodeSetupInspection,
    } };
  });
  const installationDiscovery = assembly.bindFactory(installationDiscoveryDeclaration, async () => {
    const instance = await factories.discovery();
    return { instance, capabilities: {
      "agent-runtime/codex-installations": instance.discoverCodexInstallations,
      "agent-runtime/claude-installations": instance.discoverClaudeCodeInstallations,
    } };
  });
  const codexConfiguration = assembly.bindFactory(codexConfigurationDeclaration, async () => {
    const instance = await factories.codexConfiguration();
    return { instance, capabilities: {
      "agent-runtime/codex-configuration": instance.inspectCodexConfiguration,
    } };
  });
  const claudeConfiguration = assembly.bindFactory(claudeConfigurationDeclaration, async () => {
    const instance = await factories.claudeConfiguration();
    return { instance, capabilities: {
      "agent-runtime/claude-configuration": instance,
    } };
  });
  const codexPlanner = assembly.bindFactory(codexPlannerDeclaration, async () => {
    const instance = await factories.codexPlanner();
    return { instance, capabilities: {
      "agent-runtime/codex-planner": instance,
    } };
  });
  const claudePlanner = assembly.bindFactory(claudePlannerDeclaration, async () => {
    const instance = await factories.claudePlanner();
    return { instance, capabilities: {
      "agent-runtime/claude-planner": instance,
    } };
  });
  const runtimeHost = assembly.bindFactory(runtimeHostDeclaration, async (dependencies) => {
    const host = factories.host({
      codexSetup: {
        authorizeSetupInspection: dependencies["authorize-setup-inspection"],
        discoverCodexInstallations: dependencies["discover-codex-installations"],
        inspectCodexConfiguration: dependencies["inspect-codex-configuration"],
        planCodexSetupInspection: dependencies["plan-codex-setup-inspection"],
      }, claudeCodeSetup: {
        authorizeClaudeCodeSetupInspection: dependencies["authorize-claude-code-setup-inspection"],
        discoverClaudeCodeInstallations: dependencies["discover-claude-code-installations"],
        inspectClaudeCodeConfiguration: dependencies["inspect-claude-code-configuration"],
        planClaudeCodeSetupInspection: dependencies["plan-claude-code-setup-inspection"],
      },
    });
    captureHost(host);
    if (completeRoot !== undefined) {return await completeRoot({ instance: host, capabilities: {} });}
    return { instance: host, capabilities: {} };
  });
  return { assembly, factories: [setupSecurity, installationDiscovery, codexConfiguration, claudeConfiguration, codexPlanner, claudePlanner, runtimeHost], roots: { host: runtimeHost } };
}
