import {declareModule, defineContract, type CapabilitiesOf, type Contract, type ModuleFactory} from "@get-modular/assembly";
import {required} from "@get-modular/core";
import type {ModuleContext, Resources} from "@get-modular/resources";
import {createOrdinaryTurnFeature, type OrdinaryTurnDependencies, type OrdinaryProcessPort, type OrdinaryLaunchRecipe} from "@agent-teams/agent-execution/composition";

type OrdinaryFeature = ReturnType<typeof createOrdinaryTurnFeature>;
type RegisterSecrets = (operationId: string, tokens: readonly string[]) => boolean;
export const OrdinaryStore = defineContract<OrdinaryTurnDependencies["operationStore"]>()({id: "agent-runtime/ordinary/store", revision: 1});
export const OrdinarySecurity = defineContract<OrdinaryTurnDependencies["security"]>()({id: "agent-runtime/ordinary/security", revision: 1});
export const OrdinaryRegisterSecrets = defineContract<RegisterSecrets>()({id: "agent-runtime/ordinary/register-secrets", revision: 1});
export const OrdinaryProviderAccess = defineContract<OrdinaryTurnDependencies["providerAccess"]>()({id: "agent-runtime/ordinary/provider-access", revision: 1});
export const OrdinaryWorkspace = defineContract<OrdinaryTurnDependencies["workspace"]>()({id: "agent-runtime/ordinary/workspace", revision: 1});
export const OrdinaryArtifacts = defineContract<OrdinaryTurnDependencies["artifacts"]>()({id: "agent-runtime/ordinary/artifacts", revision: 1});
export const OrdinaryProcess = defineContract<OrdinaryTurnDependencies["process"]>()({id: "agent-runtime/ordinary/process", revision: 1});
export const OrdinaryPrepareLaunch = defineContract<OrdinaryLaunchRecipe>()({id: "agent-runtime/ordinary/prepare-launch", revision: 1});
export const OrdinaryProvider = defineContract<OrdinaryTurnDependencies["provider"]>()({id: "agent-runtime/ordinary/provider", revision: 1});
export const OrdinaryTurn = defineContract<OrdinaryFeature>()({id: "agent-runtime/ordinary/turn", revision: 1});
export interface OrdinaryRuntimeCapabilities extends CapabilitiesOf<typeof OrdinaryStore | typeof OrdinarySecurity | typeof OrdinaryRegisterSecrets | typeof OrdinaryProviderAccess | typeof OrdinaryWorkspace | typeof OrdinaryArtifacts | typeof OrdinaryProcess | typeof OrdinaryPrepareLaunch | typeof OrdinaryProvider | typeof OrdinaryTurn> {}
export const ordinaryStoreDeclaration = declareModule({moduleId: "agent-runtime/ordinary/store", implementationId: "agent-runtime/ordinary/store/postgres", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [OrdinaryStore.provide()], slots: []});
export const ordinarySecurityDeclaration = declareModule({moduleId: "agent-runtime/ordinary/security", implementationId: "agent-runtime/ordinary/security/postgres", owner: {authority: "agent-runtime", path: ["runtime-security"]}, provides: [OrdinarySecurity.provide(), OrdinaryRegisterSecrets.provide()], slots: []});
export const ordinaryProviderAccessDeclaration = declareModule({moduleId: "agent-runtime/ordinary/provider-access", implementationId: "agent-runtime/ordinary/provider-access/postgres", owner: {authority: "agent-runtime", path: ["provider-access"]}, provides: [OrdinaryProviderAccess.provide()], slots: [OrdinaryRegisterSecrets.slot("register-secrets", required())]});
export const ordinaryWorkspaceDeclaration = declareModule({moduleId: "agent-runtime/ordinary/workspace", implementationId: "agent-runtime/ordinary/workspace/node", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [OrdinaryWorkspace.provide()], slots: []});
export const ordinaryArtifactsDeclaration = declareModule({moduleId: "agent-runtime/ordinary/artifacts", implementationId: "agent-runtime/ordinary/artifacts/node", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [OrdinaryArtifacts.provide()], slots: []});
export const ordinaryProcessDeclaration = declareModule({moduleId: "agent-runtime/ordinary/process", implementationId: "agent-runtime/ordinary/process/node", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [OrdinaryProcess.provide()], slots: [OrdinaryPrepareLaunch.slot("prepare-launch", required())]});
export const ordinaryProviderDeclaration = declareModule({moduleId: "agent-runtime/ordinary/provider", implementationId: "agent-runtime/ordinary/provider/codex", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [OrdinaryProvider.provide(), OrdinaryPrepareLaunch.provide()], slots: []});
export const ordinaryTurnDeclaration = declareModule({moduleId: "agent-runtime/ordinary/turn", implementationId: "agent-runtime/ordinary/turn/default", owner: {authority: "agent-runtime", path: ["agent-execution"]}, provides: [OrdinaryTurn.provide()], slots: [
  OrdinaryStore.slot("operation-store", required()),
  OrdinarySecurity.slot("security", required()),
  OrdinaryProviderAccess.slot("provider-access", required()),
  OrdinaryWorkspace.slot("workspace", required()),
  OrdinaryArtifacts.slot("artifacts", required()),
  OrdinaryProcess.slot("process", required()),
  OrdinaryProvider.slot("provider", required()),
]});
export const ordinaryRuntimeDeclarations = [ordinaryStoreDeclaration, ordinarySecurityDeclaration, ordinaryProviderAccessDeclaration, ordinaryWorkspaceDeclaration, ordinaryArtifactsDeclaration, ordinaryProcessDeclaration, ordinaryProviderDeclaration, ordinaryTurnDeclaration] as const;
export const ordinaryRuntimeBindings = [
  {consumerImplementationId: "agent-runtime/ordinary/process/node", slotId: "prepare-launch", providerImplementationIds: ["agent-runtime/ordinary/provider/codex"]},
  {consumerImplementationId: "agent-runtime/ordinary/provider-access/postgres", slotId: "register-secrets", providerImplementationIds: ["agent-runtime/ordinary/security/postgres"]},
  {consumerImplementationId: "agent-runtime/ordinary/turn/default", slotId: "operation-store", providerImplementationIds: ["agent-runtime/ordinary/store/postgres"]},
  {consumerImplementationId: "agent-runtime/ordinary/turn/default", slotId: "security", providerImplementationIds: ["agent-runtime/ordinary/security/postgres"]},
  {consumerImplementationId: "agent-runtime/ordinary/turn/default", slotId: "provider-access", providerImplementationIds: ["agent-runtime/ordinary/provider-access/postgres"]},
  {consumerImplementationId: "agent-runtime/ordinary/turn/default", slotId: "workspace", providerImplementationIds: ["agent-runtime/ordinary/workspace/node"]},
  {consumerImplementationId: "agent-runtime/ordinary/turn/default", slotId: "artifacts", providerImplementationIds: ["agent-runtime/ordinary/artifacts/node"]},
  {consumerImplementationId: "agent-runtime/ordinary/turn/default", slotId: "process", providerImplementationIds: ["agent-runtime/ordinary/process/node"]},
  {consumerImplementationId: "agent-runtime/ordinary/turn/default", slotId: "provider", providerImplementationIds: ["agent-runtime/ordinary/provider/codex"]},
] as const;
/** The value a contract carries, read from its descriptor so the Host factories follow a changed contract. */
type ValueOf<T extends Contract<string, unknown, number>> = T extends Contract<string, infer V, number> ? V : never;
export interface OrdinaryRuntimeFactories {
  operationStore(): Promise<ValueOf<typeof OrdinaryStore>>;
  security(resources: Resources): Promise<{readonly port: ValueOf<typeof OrdinarySecurity>; readonly registerSecrets: ValueOf<typeof OrdinaryRegisterSecrets>}>;
  providerAccess(registerSecrets: ValueOf<typeof OrdinaryRegisterSecrets>, resources: Resources): Promise<ValueOf<typeof OrdinaryProviderAccess>>;
  workspace(): Promise<ValueOf<typeof OrdinaryWorkspace>>;
  artifacts(): Promise<ValueOf<typeof OrdinaryArtifacts>>;
  process(prepareLaunch: ValueOf<typeof OrdinaryPrepareLaunch>): Promise<ValueOf<typeof OrdinaryProcess>>;
  provider(resources: Resources): Promise<{readonly provider: ValueOf<typeof OrdinaryProvider>; readonly prepareLaunch: ValueOf<typeof OrdinaryPrepareLaunch>}>;
}
interface OrdinaryTurnModuleCapabilities extends CapabilitiesOf<typeof OrdinaryStore | typeof OrdinarySecurity | typeof OrdinaryProviderAccess | typeof OrdinaryWorkspace | typeof OrdinaryArtifacts | typeof OrdinaryProcess | typeof OrdinaryProvider | typeof OrdinaryTurn> {}
const createTurnModule: ModuleFactory<OrdinaryTurnModuleCapabilities, typeof ordinaryTurnDeclaration, OrdinaryFeature> = async dependencies => {
  const instance = createOrdinaryTurnFeature({operationStore: dependencies["operation-store"], security: dependencies.security, providerAccess: dependencies["provider-access"], workspace: dependencies.workspace, artifacts: dependencies.artifacts, process: dependencies.process, provider: dependencies.provider});
  return {instance, capabilities: {"agent-runtime/ordinary/turn": instance}};
};
/** Unbound factories of the eight modules; the composition root binds them through the Assembly it receives. */
export function createOrdinaryModuleFactories(factories: OrdinaryRuntimeFactories) {
  const store: ModuleFactory<CapabilitiesOf<typeof OrdinaryStore>, typeof ordinaryStoreDeclaration, OrdinaryTurnDependencies["operationStore"]> =
    async () => {const instance = await factories.operationStore(); return {instance, capabilities: {"agent-runtime/ordinary/store": instance}};};
  const security: ModuleFactory<CapabilitiesOf<typeof OrdinarySecurity | typeof OrdinaryRegisterSecrets>, typeof ordinarySecurityDeclaration, Awaited<ReturnType<OrdinaryRuntimeFactories["security"]>>, ModuleContext> =
    async (_dependencies, context) => {const instance = await factories.security(context.resources); return {instance, capabilities: {"agent-runtime/ordinary/security": instance.port, "agent-runtime/ordinary/register-secrets": instance.registerSecrets}};};
  const providerAccess: ModuleFactory<CapabilitiesOf<typeof OrdinaryProviderAccess | typeof OrdinaryRegisterSecrets>, typeof ordinaryProviderAccessDeclaration, OrdinaryTurnDependencies["providerAccess"], ModuleContext> =
    async (dependencies, context) => {const instance = await factories.providerAccess(dependencies["register-secrets"], context.resources); return {instance, capabilities: {"agent-runtime/ordinary/provider-access": instance}};};
  const workspace: ModuleFactory<CapabilitiesOf<typeof OrdinaryWorkspace>, typeof ordinaryWorkspaceDeclaration, OrdinaryTurnDependencies["workspace"]> =
    async () => {const instance = await factories.workspace(); return {instance, capabilities: {"agent-runtime/ordinary/workspace": instance}};};
  const artifacts: ModuleFactory<CapabilitiesOf<typeof OrdinaryArtifacts>, typeof ordinaryArtifactsDeclaration, OrdinaryTurnDependencies["artifacts"]> =
    async () => {const instance = await factories.artifacts(); return {instance, capabilities: {"agent-runtime/ordinary/artifacts": instance}};};
  const process: ModuleFactory<CapabilitiesOf<typeof OrdinaryProcess | typeof OrdinaryPrepareLaunch>, typeof ordinaryProcessDeclaration, OrdinaryProcessPort> =
    async dependencies => {const instance = await factories.process(dependencies["prepare-launch"]); return {instance, capabilities: {"agent-runtime/ordinary/process": instance}};};
  const provider: ModuleFactory<CapabilitiesOf<typeof OrdinaryProvider | typeof OrdinaryPrepareLaunch>, typeof ordinaryProviderDeclaration, Awaited<ReturnType<OrdinaryRuntimeFactories["provider"]>>, ModuleContext> =
    async (_dependencies, context) => {const instance = await factories.provider(context.resources); return {instance, capabilities: {"agent-runtime/ordinary/provider": instance.provider, "agent-runtime/ordinary/prepare-launch": instance.prepareLaunch}};};
  return Object.freeze({store, security, providerAccess, workspace, artifacts, process, provider, turn: createTurnModule});
}
