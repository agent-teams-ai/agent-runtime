import {defineModule} from "@get-modular/core";
import {assemblyFor, type CapabilityContract} from "@get-modular/assembly";
import {createOrdinaryTurnFeature, type OrdinaryTurnDependencies, type OrdinaryProcessPort} from "@agent-teams/agent-execution/composition";
import type {RuntimeSetupCapabilities} from "../../../composition/runtime-setup-assembly.js";

type OrdinaryFeature = ReturnType<typeof createOrdinaryTurnFeature>;
const compatibility = {family: "exact", familyVersion: 1, token: "agent-runtime/ordinary-v1"} as const;
type Contract<T> = CapabilityContract<T, "agent-runtime/ordinary-v1">;
type RegisterSecrets = (operationId: string, tokens: readonly string[]) => boolean;
export interface OrdinaryRuntimeCapabilities {
  "ordinary/store": Contract<OrdinaryTurnDependencies["operationStore"]>;
  "ordinary/security": Contract<OrdinaryTurnDependencies["security"]>;
  "ordinary/register-secrets": Contract<RegisterSecrets>;
  "ordinary/provider-access": Contract<OrdinaryTurnDependencies["providerAccess"]>;
  "ordinary/workspace": Contract<OrdinaryTurnDependencies["workspace"]>;
  "ordinary/artifacts": Contract<OrdinaryTurnDependencies["artifacts"]>;
  "ordinary/process": Contract<OrdinaryTurnDependencies["process"]>;
  "ordinary/provider": Contract<OrdinaryTurnDependencies["provider"]>;
  "ordinary/turn": Contract<OrdinaryFeature>;
}
const owner = {authority: "agent-teams", path: ["agent-execution"]} as const;
const store = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/store", implementationId: "ordinary/store", owner, provides: [{capabilityId: "ordinary/store", compatibility}], slots: []});
const security = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/security", implementationId: "ordinary/security", owner: {authority: "agent-teams", path: ["runtime-security"]}, provides: [{capabilityId: "ordinary/security", compatibility}, {capabilityId: "ordinary/register-secrets", compatibility}], slots: []});
const providerAccess = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/provider-access", implementationId: "ordinary/provider-access", owner: {authority: "agent-teams", path: ["provider-access"]}, provides: [{capabilityId: "ordinary/provider-access", compatibility}], slots: [{slotId: "register-secrets", capabilityId: "ordinary/register-secrets", compatibility, cardinality: {kind: "required"}}]});
const workspace = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/workspace", implementationId: "ordinary/workspace", owner, provides: [{capabilityId: "ordinary/workspace", compatibility}], slots: []});
const artifacts = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/artifacts", implementationId: "ordinary/artifacts", owner, provides: [{capabilityId: "ordinary/artifacts", compatibility}], slots: []});
const processOwner = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/process", implementationId: "ordinary/process", owner, provides: [{capabilityId: "ordinary/process", compatibility}], slots: []});
const provider = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/provider", implementationId: "ordinary/provider", owner, provides: [{capabilityId: "ordinary/provider", compatibility}], slots: []});
const turn = defineModule({kind: "get-modular.module-declaration", schemaVersion: 1, moduleId: "ordinary/turn", implementationId: "ordinary/turn", owner, provides: [{capabilityId: "ordinary/turn", compatibility}], slots: [
  {slotId: "operation-store", capabilityId: "ordinary/store", compatibility, cardinality: {kind: "required"}},
  {slotId: "security", capabilityId: "ordinary/security", compatibility, cardinality: {kind: "required"}},
  {slotId: "provider-access", capabilityId: "ordinary/provider-access", compatibility, cardinality: {kind: "required"}},
  {slotId: "workspace", capabilityId: "ordinary/workspace", compatibility, cardinality: {kind: "required"}},
  {slotId: "artifacts", capabilityId: "ordinary/artifacts", compatibility, cardinality: {kind: "required"}},
  {slotId: "process", capabilityId: "ordinary/process", compatibility, cardinality: {kind: "required"}},
  {slotId: "provider", capabilityId: "ordinary/provider", compatibility, cardinality: {kind: "required"}},
]});
export const ordinaryRuntimeDeclarations = [store, security, providerAccess, workspace, artifacts, processOwner, provider, turn] as const;
export const ordinaryTurnHostSlot = {slotId: "ordinary-turn", capabilityId: "ordinary/turn", compatibility, cardinality: {kind: "required"}} as const;
export const ordinaryRuntimeBindings = [
  {consumerImplementationId: "ordinary/provider-access", slotId: "register-secrets", providerImplementationIds: ["ordinary/security"]},
  {consumerImplementationId: "ordinary/turn", slotId: "operation-store", providerImplementationIds: ["ordinary/store"]},
  {consumerImplementationId: "ordinary/turn", slotId: "security", providerImplementationIds: ["ordinary/security"]},
  {consumerImplementationId: "ordinary/turn", slotId: "provider-access", providerImplementationIds: ["ordinary/provider-access"]},
  {consumerImplementationId: "ordinary/turn", slotId: "workspace", providerImplementationIds: ["ordinary/workspace"]},
  {consumerImplementationId: "ordinary/turn", slotId: "artifacts", providerImplementationIds: ["ordinary/artifacts"]},
  {consumerImplementationId: "ordinary/turn", slotId: "process", providerImplementationIds: ["ordinary/process"]},
  {consumerImplementationId: "ordinary/turn", slotId: "provider", providerImplementationIds: ["ordinary/provider"]},
  {consumerImplementationId: "agent-runtime/runtime-host", slotId: "ordinary-turn", providerImplementationIds: ["ordinary/turn"]},
] as const;
export interface OrdinaryRuntimeFactories {
  operationStore(): Promise<OrdinaryTurnDependencies["operationStore"]>;
  security(): Promise<{readonly port: OrdinaryTurnDependencies["security"]; readonly registerSecrets: RegisterSecrets}>;
  providerAccess(registerSecrets: RegisterSecrets): Promise<OrdinaryTurnDependencies["providerAccess"]>;
  workspace(): Promise<OrdinaryTurnDependencies["workspace"]>;
  artifacts(): Promise<OrdinaryTurnDependencies["artifacts"]>;
  process(): Promise<OrdinaryProcessPort>;
  provider(): Promise<OrdinaryTurnDependencies["provider"]>;
}
export function bindOrdinaryRuntime(assembly: ReturnType<typeof assemblyFor<RuntimeSetupCapabilities>>, factories: OrdinaryRuntimeFactories) {
  const storeBinding = assembly.bindFactory(store, async () => {const instance = await factories.operationStore(); return {instance, capabilities: {"ordinary/store": instance}};});
  const securityBinding = assembly.bindFactory(security, async () => {const instance = await factories.security(); return {instance, capabilities: {"ordinary/security": instance.port, "ordinary/register-secrets": instance.registerSecrets}};});
  const accessBinding = assembly.bindFactory(providerAccess, async dependencies => {const instance = await factories.providerAccess(dependencies["register-secrets"]); return {instance, capabilities: {"ordinary/provider-access": instance}};});
  const workspaceBinding = assembly.bindFactory(workspace, async () => {const instance = await factories.workspace(); return {instance, capabilities: {"ordinary/workspace": instance}};});
  const artifactsBinding = assembly.bindFactory(artifacts, async () => {const instance = await factories.artifacts(); return {instance, capabilities: {"ordinary/artifacts": instance}};});
  const processBinding = assembly.bindFactory(processOwner, async () => {const instance = await factories.process(); return {instance, capabilities: {"ordinary/process": instance}};});
  const providerBinding = assembly.bindFactory(provider, async () => {const instance = await factories.provider(); return {instance, capabilities: {"ordinary/provider": instance}};});
  const turnBinding = assembly.bindFactory(turn, async dependencies => {
    const instance = createOrdinaryTurnFeature({operationStore: dependencies["operation-store"], security: dependencies.security, providerAccess: dependencies["provider-access"], workspace: dependencies.workspace, artifacts: dependencies.artifacts, process: dependencies.process, provider: dependencies.provider});
    return {instance, capabilities: {"ordinary/turn": instance}};
  });
  return [storeBinding, securityBinding, accessBinding, workspaceBinding, artifactsBinding, processBinding, providerBinding, turnBinding];
}
