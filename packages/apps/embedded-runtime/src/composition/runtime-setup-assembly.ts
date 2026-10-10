import {bindContainedTurnCapabilityAuthority} from "./contained-turn-authority-capability.js";
import {createOrdinaryModuleFactories, ordinaryRuntimeDeclarations, ordinaryRuntimeBindings, ordinaryStoreDeclaration, ordinarySecurityDeclaration, ordinaryProviderAccessDeclaration, ordinaryWorkspaceDeclaration, ordinaryArtifactsDeclaration, ordinaryProcessDeclaration, ordinaryProviderDeclaration, ordinaryTurnDeclaration, OrdinaryTurn, type OrdinaryRuntimeCapabilities, type OrdinaryRuntimeFactories} from "./ordinary-runtime-assembly.js";
import type {createOrdinaryTurnFeature} from "@agent-teams/agent-execution/composition";
type OrdinaryFeature = ReturnType<typeof createOrdinaryTurnFeature>;
import { required } from "@get-modular/core";
import { declareModule, defineContract, type Assembly, type CapabilitiesOf, type FactoryDependencies, type SuccessfulComposition } from "@get-modular/assembly";
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

const CodexAuthorization = defineContract<CodexSetupCapabilityBundle["authorizeSetupInspection"]>()({ id: "agent-runtime/codex-authorization", revision: 1 });
const ClaudeAuthorization = defineContract<ClaudeCodeSetupCapabilityBundle["authorizeClaudeCodeSetupInspection"]>()({ id: "agent-runtime/claude-authorization", revision: 1 });
const CodexInstallations = defineContract<CodexSetupCapabilityBundle["discoverCodexInstallations"]>()({ id: "agent-runtime/codex-installations", revision: 1 });
const ClaudeInstallations = defineContract<ClaudeCodeSetupCapabilityBundle["discoverClaudeCodeInstallations"]>()({ id: "agent-runtime/claude-installations", revision: 1 });
const CodexConfiguration = defineContract<CodexSetupCapabilityBundle["inspectCodexConfiguration"]>()({ id: "agent-runtime/codex-configuration", revision: 1 });
const ClaudeConfiguration = defineContract<ClaudeCodeSetupCapabilityBundle["inspectClaudeCodeConfiguration"]>()({ id: "agent-runtime/claude-configuration", revision: 1 });
const CodexPlanner = defineContract<CodexSetupCapabilityBundle["planCodexSetupInspection"]>()({ id: "agent-runtime/codex-planner", revision: 1 });
const ClaudePlanner = defineContract<ClaudeCodeSetupCapabilityBundle["planClaudeCodeSetupInspection"]>()({ id: "agent-runtime/claude-planner", revision: 1 });
interface SetupCapabilities extends CapabilitiesOf<typeof CodexAuthorization | typeof ClaudeAuthorization | typeof CodexInstallations | typeof ClaudeInstallations | typeof CodexConfiguration | typeof ClaudeConfiguration | typeof CodexPlanner | typeof ClaudePlanner> {}
export interface RuntimeSetupCapabilities extends SetupCapabilities, OrdinaryRuntimeCapabilities {}
const owner = (path: string) => ({ authority: "agent-runtime", path: [path] }) as const;
const setupSecurityDeclaration = declareModule({
  moduleId: "agent-runtime/setup-security", implementationId: "agent-runtime/setup-security/default",
  owner: owner("runtime-security"),
  provides: [CodexAuthorization.provide(), ClaudeAuthorization.provide()],
  slots: [],
});
const installationDiscoveryDeclaration = declareModule({
  moduleId: "agent-runtime/installation-discovery", implementationId: "agent-runtime/installation-discovery/default",
  owner: owner("agent-execution"),
  provides: [CodexInstallations.provide(), ClaudeInstallations.provide()],
  slots: [],
});
const codexConfigurationDeclaration = declareModule({
  moduleId: "agent-runtime/codex-configuration", implementationId: "agent-runtime/codex-configuration/default",
  owner: owner("runtime-configuration"),
  provides: [CodexConfiguration.provide()],
  slots: [],
});
const claudeConfigurationDeclaration = declareModule({
  moduleId: "agent-runtime/claude-configuration", implementationId: "agent-runtime/claude-configuration/default",
  owner: owner("runtime-configuration"),
  provides: [ClaudeConfiguration.provide()],
  slots: [],
});
const codexPlannerDeclaration = declareModule({
  moduleId: "agent-runtime/codex-planner", implementationId: "agent-runtime/codex-planner/default",
  owner: owner("embedded-runtime"),
  provides: [CodexPlanner.provide()],
  slots: [],
});
const claudePlannerDeclaration = declareModule({
  moduleId: "agent-runtime/claude-planner", implementationId: "agent-runtime/claude-planner/default",
  owner: owner("embedded-runtime"),
  provides: [ClaudePlanner.provide()],
  slots: [],
});
// The passive and ordinary Host variants come from one spec: `declareModule` refuses an object that already has `kind`.
const hostSpec = {
  moduleId: "agent-runtime/runtime-host", owner: owner("embedded-runtime"), provides: [],
  slots: [
    CodexAuthorization.slot("authorize-setup-inspection", required()),
    ClaudeAuthorization.slot("authorize-claude-code-setup-inspection", required()),
    CodexInstallations.slot("discover-codex-installations", required()),
    ClaudeInstallations.slot("discover-claude-code-installations", required()),
    CodexConfiguration.slot("inspect-codex-configuration", required()),
    ClaudeConfiguration.slot("inspect-claude-code-configuration", required()),
    CodexPlanner.slot("plan-codex-setup-inspection", required()),
    ClaudePlanner.slot("plan-claude-code-setup-inspection", required()),
  ],
} as const;
const runtimeHostDeclaration = declareModule({ ...hostSpec, implementationId: "agent-runtime/runtime-host/passive" });
const ordinaryHostDeclaration = declareModule({ ...hostSpec, implementationId: "agent-runtime/runtime-host/ordinary",
  slots: [...hostSpec.slots, OrdinaryTurn.slot("ordinary-turn", required())] });
export const runtimeSetupDeclarations = [setupSecurityDeclaration, installationDiscoveryDeclaration, codexConfigurationDeclaration, claudeConfigurationDeclaration, codexPlannerDeclaration, claudePlannerDeclaration, runtimeHostDeclaration] as const;
const setupBindings = (hostImplementationId: string) => [
  { consumerImplementationId: hostImplementationId, slotId: "authorize-setup-inspection", providerImplementationIds: [setupSecurityDeclaration.implementationId] },
  { consumerImplementationId: hostImplementationId, slotId: "authorize-claude-code-setup-inspection", providerImplementationIds: [setupSecurityDeclaration.implementationId] },
  { consumerImplementationId: hostImplementationId, slotId: "discover-codex-installations", providerImplementationIds: [installationDiscoveryDeclaration.implementationId] },
  { consumerImplementationId: hostImplementationId, slotId: "discover-claude-code-installations", providerImplementationIds: [installationDiscoveryDeclaration.implementationId] },
  { consumerImplementationId: hostImplementationId, slotId: "inspect-codex-configuration", providerImplementationIds: [codexConfigurationDeclaration.implementationId] },
  { consumerImplementationId: hostImplementationId, slotId: "inspect-claude-code-configuration", providerImplementationIds: [claudeConfigurationDeclaration.implementationId] },
  { consumerImplementationId: hostImplementationId, slotId: "plan-codex-setup-inspection", providerImplementationIds: [codexPlannerDeclaration.implementationId] },
  { consumerImplementationId: hostImplementationId, slotId: "plan-claude-code-setup-inspection", providerImplementationIds: [claudePlannerDeclaration.implementationId] },
] as const;
export const runtimeSetupProfile = {
  kind: "get-modular.composition-profile", schemaVersion: 1, profileId: "agent-runtime/passive-setup",
  roots: [runtimeHostDeclaration.moduleId],
  selections: runtimeSetupDeclarations.map(({ moduleId, implementationId }) => ({ moduleId, implementationId })),
  bindings: setupBindings(runtimeHostDeclaration.implementationId),
} as const;

export const runtimeOrdinarySetupDeclarations = [...runtimeSetupDeclarations.filter(item => item !== runtimeHostDeclaration), ordinaryHostDeclaration, ...ordinaryRuntimeDeclarations];
export const runtimeOrdinarySetupProfile = {...runtimeSetupProfile, profileId: "agent-runtime/ordinary-session", selections: runtimeOrdinarySetupDeclarations.map(({moduleId, implementationId}) => ({moduleId, implementationId})), bindings: [
  ...setupBindings(ordinaryHostDeclaration.implementationId),
  ...ordinaryRuntimeBindings,
  {consumerImplementationId: ordinaryHostDeclaration.implementationId, slotId: "ordinary-turn", providerImplementationIds: ["agent-runtime/ordinary/turn/default"]},
]};
export interface OrdinaryRuntimeAssemblyInput {readonly factories: OrdinaryRuntimeFactories; readonly decorateHost: (host: AgentRuntimeHost, feature: OrdinaryFeature) => AgentRuntimeHost;}

export const createRuntimeSetupFactories = (platform: NodeJS.Platform) => ({
  security: async () => createSetupInspectionAuthorizationFeature({ pathCanonicalizer: createNodePathCanonicalizer() }),
  discovery: async () => createRuntimeInstallationDiscoveryFeature({ executableFileObserver: createNodeExecutableFileObserver() }),
  codexConfiguration: async () => createCodexConfigurationInspectionFeature({ digest: createNodeCodexConfigurationDigest(), parser: createSmolTomlParser(), semanticClassifier: createCodexConfigurationSemanticClassifierV1(), sourceIdentityKey: randomBytes(32), sourceReader: createNodeConfigurationSourceReader() }),
  claudeConfiguration: async () => createClaudeCodeConfigurationInspectionFeature({ digest: createNodeClaudeCodeConfigurationDigest(), parser: createStrictClaudeCodeJsonParser(), semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(), sourceIdentityKey: randomBytes(32), sourceReader: createClaudeCodeConfigurationSourceReaderAdapter() }),
  codexPlanner: async () => createCodexSetupInspectionPlanner(platform),
  claudePlanner: async () => createClaudeCodeSetupInspectionPlanner(platform),
  host: (dependencies: AgentRuntimeHostDependencies, ordinaryOwner?: OrdinaryFeature) => createAgentRuntimeHost(dependencies, ordinaryOwner),
});
// Trusted owner-local factories must return Hosts satisfying the repeatable
// disposal observation contract, including synthetic substitutes. Structural
// typing does not authorize a weaker resource-owner implementation.
export type RuntimeSetupFactories = ReturnType<typeof createRuntimeSetupFactories>;

// Fixed owner-local completion seam for synthetic envelope/ownership tests.
export type RuntimeSetupRootProduct = { readonly instance: AgentRuntimeHost; readonly capabilities: Record<string, never> };
export type RuntimeSetupRootCompletion = (product: RuntimeSetupRootProduct) => Promise<RuntimeSetupRootProduct>;

export function bindRuntimeSetup(api: Assembly<RuntimeSetupCapabilities>, factories: RuntimeSetupFactories,
  captureHost: (host: AgentRuntimeHost) => void, completeRoot?: RuntimeSetupRootCompletion, ordinary?: OrdinaryRuntimeAssemblyInput) {
  const setupSecurity = api.bindFactory(setupSecurityDeclaration, async () => {
    const instance = await factories.security();
    return { instance, capabilities: {
      "agent-runtime/codex-authorization": instance.authorizeSetupInspection,
      "agent-runtime/claude-authorization": instance.authorizeClaudeCodeSetupInspection,
    } };
  });
  const installationDiscovery = api.bindFactory(installationDiscoveryDeclaration, async () => {
    const instance = await factories.discovery();
    return { instance, capabilities: {
      "agent-runtime/codex-installations": instance.discoverCodexInstallations,
      "agent-runtime/claude-installations": instance.discoverClaudeCodeInstallations,
    } };
  });
  const codexConfiguration = api.bindFactory(codexConfigurationDeclaration, async () => {
    const instance = await factories.codexConfiguration();
    return { instance, capabilities: {
      "agent-runtime/codex-configuration": instance.inspectCodexConfiguration,
    } };
  });
  const claudeConfiguration = api.bindFactory(claudeConfigurationDeclaration, async () => {
    const instance = await factories.claudeConfiguration();
    return { instance, capabilities: {
      "agent-runtime/claude-configuration": instance,
    } };
  });
  const codexPlanner = api.bindFactory(codexPlannerDeclaration, async () => {
    const instance = await factories.codexPlanner();
    return { instance, capabilities: {
      "agent-runtime/codex-planner": instance,
    } };
  });
  const claudePlanner = api.bindFactory(claudePlannerDeclaration, async () => {
    const instance = await factories.claudePlanner();
    return { instance, capabilities: {
      "agent-runtime/claude-planner": instance,
    } };
  });
  type OrdinaryHostInputs = FactoryDependencies<RuntimeSetupCapabilities, typeof ordinaryHostDeclaration>;
  type HostInputs = Omit<OrdinaryHostInputs, "ordinary-turn"> & { readonly "ordinary-turn"?: OrdinaryHostInputs["ordinary-turn"] };
  const buildHost = async (dependencies: HostInputs) => {
    const rawHost = factories.host({
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
      ...(dependencies["ordinary-turn"] === undefined ? {} : {containedTurn: bindContainedTurnCapabilityAuthority(dependencies["ordinary-turn"], "runtime-access-authority:ordinary-user-session-v1")}),
    }, dependencies["ordinary-turn"]);
    const host = ordinary !== undefined && dependencies["ordinary-turn"] !== undefined ? ordinary.decorateHost(rawHost, dependencies["ordinary-turn"]) : rawHost;
    captureHost(host);
    if (completeRoot !== undefined) {return await completeRoot({ instance: host, capabilities: {} });}
    return { instance: host, capabilities: {} };
  };
  const runtimeHost = ordinary === undefined ? api.bindFactory(runtimeHostDeclaration, buildHost) : api.bindFactory(ordinaryHostDeclaration, buildHost);
  const modules = ordinary === undefined ? undefined : createOrdinaryModuleFactories(ordinary.factories);
  const activeFactories = modules === undefined ? [] : [
    api.bindFactory(ordinaryStoreDeclaration, modules.store),
    api.bindFactory(ordinarySecurityDeclaration, modules.security),
    api.bindFactory(ordinaryProviderAccessDeclaration, modules.providerAccess),
    api.bindFactory(ordinaryWorkspaceDeclaration, modules.workspace),
    api.bindFactory(ordinaryArtifactsDeclaration, modules.artifacts),
    api.bindFactory(ordinaryProcessDeclaration, modules.process),
    api.bindFactory(ordinaryProviderDeclaration, modules.provider),
    api.bindFactory(ordinaryTurnDeclaration, modules.turn),
  ];
  return { factories: [setupSecurity, installationDiscovery, codexConfiguration, claudeConfiguration, codexPlanner, claudePlanner, ...activeFactories, runtimeHost], roots: { host: runtimeHost } };
}

type RuntimeSetupBindArguments = [factories: RuntimeSetupFactories, captureHost: (host: AgentRuntimeHost) => void,
  completeRoot?: RuntimeSetupRootCompletion, ordinary?: OrdinaryRuntimeAssemblyInput];

/** The production composition root. A function of Assembly, so `smoke` can pass its own api. Not async: a
 * synchronous binding failure still surfaces in the "bind" phase. */
export function composeRuntimeSetup(api: Assembly<RuntimeSetupCapabilities>, composition: SuccessfulComposition,
  ...bindArguments: RuntimeSetupBindArguments) {
  const bound = bindRuntimeSetup(api, ...bindArguments);
  return api.prepare({ composition, factories: bound.factories, roots: bound.roots });
}
