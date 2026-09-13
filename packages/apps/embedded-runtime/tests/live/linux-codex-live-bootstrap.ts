// Test-only assembly of the production Linux Codex owners.
// Importing this module performs no setup, discovery, migration or launch.
import {
  applyContainedTurnPostgresSchema, initializePostgresHttpEgressEvidence,
  createNodeContainedTurnArtifacts, createCodexAppServerPermissionBoundary,
  PostgresContainedTurnOperationStore, createNodeContainedTurnWorkspaceOwner,
  type CreateCodexCurrentKernelOwnerOptions,
} from "@agent-teams/agent-execution/composition";
import {
  createPostgresOperationDispatchConsumption, createPostgresCurrentProviderAccess,
  createPostgresRouteSelectionOwner,createPostgresMaterializationRepository
} from "@agent-teams/provider-access/composition";
import {
  createDispatchAcceptanceFeature, createNodeSha256DispatchDigest,
  createPostgresDispatchAcceptanceStore,createPostgresDispatchConsumptionRepository
} from "@agent-teams/runtime-security/composition";
import {
  createHostCustodiedAgentRuntimeHost, type HostCustodiedAgentRuntimeHostDependencies,
} from "../../dist/composition/host-custodied-agent-runtime-host.js";
import {createLinuxCodexNodeRecipe} from "../../dist/composition/linux-codex-node-recipe.js";
import {ContainedTurnConstructionCleanupError, ContainedTurnOwnerDisposalError} from
  "../../dist/composition/contained-turn-construction-failure.js";
import type {LinuxCodexDeploymentInfrastructure} from "../../dist/composition/linux-codex-deployment.js";
import {createLinuxCodexNodeSelection, type LinuxCodexNodeSelectionPins} from "../package/live/linux-codex-node-selection.ts";
import {createLinuxCodexPaRenderingFactory, type LinuxCodexOwnedPaMaterial} from "../package/live/linux-codex-pa-rendering.ts";

import {createLinuxCodexLiveFirewallWiring, type LinuxCodexLiveFirewallPins} from "../package/live/linux-codex-live-firewall-wiring.ts";

import {createLiveNativeStartCollector} from "./linux-codex-live-native-start.ts";

type Pool = ConstructorParameters<typeof PostgresContainedTurnOperationStore>[0]["pool"];
type Host = ReturnType<typeof createHostCustodiedAgentRuntimeHost>;
type Selection = Parameters<typeof createPostgresOperationDispatchConsumption>[1];
type Acceptance = Parameters<typeof createDispatchAcceptanceFeature>[0];
type Recipe = ReturnType<typeof createLinuxCodexNodeRecipe>;
type Launch = CreateCodexCurrentKernelOwnerOptions["launchRecords"];
type LaunchInput = Parameters<Launch["resolve"]>[0];
type LaunchRecord = NonNullable<Awaited<ReturnType<Launch["resolve"]>>>;
type Dispose = () => void | Promise<void>;

/** All facts come from trusted test administration, independently of submit.
 * The caller owns an empty disposable database and private filesystem layout.
 * No URL, environment, home-directory or credential lookup is performed here.
 */
export interface LinuxCodexLivePins {
  readonly sourceRevision: string;
  readonly authorityRevision: string;
  readonly hostBootId: string;
  readonly hostInstanceId: string;
  readonly issuance: Selection;
  readonly route: Parameters<typeof createPostgresRouteSelectionOwner>[1];
  readonly policy: Acceptance["policy"];
  readonly clock: Acceptance["clock"];
  readonly policyRevision: string;
  readonly intentAuthority: NonNullable<ConstructorParameters<typeof PostgresContainedTurnOperationStore>[0]["intentAuthority"]>;
  readonly workspace: Omit<Parameters<typeof createNodeContainedTurnWorkspaceOwner>[0], "testFaults" | "testDigest">;
  readonly artifacts: Omit<Parameters<typeof createNodeContainedTurnArtifacts>[0], "testFaults" | "testDigest">;
  readonly capabilities: HostCustodiedAgentRuntimeHostDependencies["capabilities"];
  readonly platformTarget: CreateCodexCurrentKernelOwnerOptions["platformTarget"];
  readonly routeEnforcement: NonNullable<HostCustodiedAgentRuntimeHostDependencies["containedTurn"]["routeEnforcement"]>;
  /** Borrowed concrete host owner; retained until this assembly reports released. */
  readonly hostCustody: HostCustodiedAgentRuntimeHostDependencies["containedTurn"]["hostCustody"];
  readonly node: Omit<LinuxCodexNodeSelectionPins, "readAcknowledged" | "decorateListener">;
  /** Explicit authorization for the exact temporary disposable-host rule. */
  readonly firewall?: LinuxCodexLiveFirewallPins;
  readonly deployment: Omit<LinuxCodexDeploymentInfrastructure,
    "pool" | "recipe" | "currentAuthority" | "sourceRevision" | "createProviderAccess">;
  /** Owned secret material remains in this input's lifetime, never in diagnostics.
   * Each call must construct a fresh actual PA rendering owner, bound to the
   * acknowledged operation, abort signal, deadline and independently pinned material.
   */
  readonly credentials: Readonly<{
    takeOwnedMaterial(operationId: string): LinuxCodexOwnedPaMaterial;
    inventory: LaunchRecord["credentialOutputInventory"];
  }>;
  /** Independently allocated private directories and executable pins per attempt.
   * This does not supply a fabricated boundary or workspace authority.
   */
  launchPaths(input: LaunchInput): Promise<Readonly<{
    codexHome: string;
    executablePath: string;
    privateRootPath: string;
    tmpDir: string;
  }>>;
}

/** Explicit binding avoids prototype-method loss at the strict seven-port capture. */
const bindOperationStore = (store: PostgresContainedTurnOperationStore) => Object.freeze({
  accept: store.accept.bind(store),
  appendOutput: store.appendOutput.bind(store),
  claimPreparedDispatch: store.claimPreparedDispatch.bind(store),
  commit: store.commit.bind(store),
  identifyAcceptance: store.identifyAcceptance.bind(store),
  listDispatchPreparations: store.listDispatchPreparations.bind(store),
  preventIntent: store.preventIntent.bind(store),
  prepareCancellation: store.prepareCancellation.bind(store),
  prepareDispatch: store.prepareDispatch.bind(store),
  proofsForAcceptedEffect: store.proofsForAcceptedEffect.bind(store),
  proofsForPrevention: store.proofsForPrevention.bind(store),
  proofsForProcessNoStart: store.proofsForProcessNoStart.bind(store),
  proveDispatchPreparationClosure: store.proveDispatchPreparationClosure.bind(store),
  read: store.read.bind(store),
  recordDispatchPreparationCleanup: store.recordDispatchPreparationCleanup.bind(store),
  requestCancellation: store.requestCancellation.bind(store),
  retireDispatchPreparation: store.retireDispatchPreparation.bind(store),
  terminalProof: store.terminalProof.bind(store),
});

export type LinuxCodexLiveSetupStage = "configuration" | "schema" | "pa" | "rs" |
  "operation-store" | "workspace" | "artifacts" | "node-recipe" | "host-composition";

export const createLinuxCodexLiveLaunchRecords = (
  pins: Pick<LinuxCodexLivePins, "credentials" | "launchPaths">, isClosing: () => boolean,
): Launch => Object.freeze({async resolve(input: LaunchInput) {
  if (isClosing()) {return;}
  const inventory = pins.credentials.inventory;
  if (input.credentialBindingDigest !== inventory.credentialBindingDigest ||
      input.credentialGeneration !== inventory.credentialGeneration) {return;}
  const paths = await pins.launchPaths(input);
  if (isClosing()) {return;}
  const boundary = createCodexAppServerPermissionBoundary({codexHome: paths.codexHome,
    workspaceRef: input.workspaceAuthority.canonicalPath, intentMode: input.intentMode});
  return Object.freeze({boundary, executablePath: paths.executablePath,
    privateRootPath: paths.privateRootPath, tmpDir: paths.tmpDir,
    credentialOutputInventory: Object.freeze({...inventory,
      sensitiveOutputTokens: Object.freeze([...inventory.sensitiveOutputTokens])})});
}});

/** Retains the cleanup handle even when construction failed. Errors intentionally
 * omit underlying causes, which may contain PG configuration or secret material.
 */
export class LinuxCodexLiveSetupError extends Error {
  public readonly cleanup: (call: Parameters<Recipe["releaseAfterHostCleanup"]>[0]) => Promise<"released" | "pending">;
  public readonly setupStage: LinuxCodexLiveSetupStage;
  public constructor(cleanup: LinuxCodexLiveSetupError["cleanup"], setupStage: LinuxCodexLiveSetupStage = "configuration") {
    super("Linux Codex live setup incomplete; retain inputs until cleanup releases");
    this.name = "LinuxCodexLiveSetupError";
    this.cleanup = cleanup;
    this.setupStage = setupStage;
  }
}

/** This function is administrative I/O, never an auto-running test. Invoke only
 * in a separately authorized disposable environment. Pool.end(), borrowed host
 * disposal, secret erasure and directory removal belong to
 * the caller, strictly AFTER cleanup returns released. Pending preserves debt.
 */
export const setupLinuxCodexLiveBootstrap = async (pool: Pool, pins: LinuxCodexLivePins) => {
  const actions: Dispose[] = [];
  const nativeStart = createLiveNativeStartCollector();
  const acknowledgedSelections = new Map<string, NonNullable<ReturnType<LinuxCodexNodeSelectionPins["readAcknowledged"]>>>();
  let host: Host | undefined;
  let node: Recipe | undefined;
  let closing = false;
  let constructionCleanupUnknown = false;
  let hostReleased = false;
  let nodeReleased = false;
  let cleanupInFlight: Promise<"released" | "pending"> | undefined;
  const cleanup = (call: Parameters<Recipe["releaseAfterHostCleanup"]>[0]): Promise<"released" | "pending"> => {
    closing = true;
    acknowledgedSelections.clear();
    if (cleanupInFlight !== undefined) {return cleanupInFlight;}
    cleanupInFlight = (async () => {
      try {
        if (constructionCleanupUnknown) {return "pending";}
        // Host settlement and physical cleanup precede recipe journals/workspace.
        if (!hostReleased) {await host?.dispose(); hostReleased = true;}
        if (!nodeReleased) {
          if (node !== undefined && await node.releaseAfterHostCleanup(call) !== "released") {return "pending";}
          nodeReleased = true;
        }
        while (actions.length > 0) {
          await actions[actions.length - 1]!();
          actions.pop();
        }
        nativeStart.release();
        return "released";
      } catch {return "pending";}
    })();
    void cleanupInFlight.finally(() => {cleanupInFlight = undefined;});
    return cleanupInFlight;
  };
  let setupStage: LinuxCodexLiveSetupStage = "configuration";
  try {
    if (process.platform !== "linux" || pins.platformTarget.platform !== "linux" ||
        !/^[a-f0-9]{40}$/u.test(pins.sourceRevision)) {
      throw new TypeError("Pinned Linux configuration is required");
    }
    const selectCurrentPolicy = pins.deployment.currentPolicy.bind(pins.deployment);
    setupStage = "schema";
    // Same empty-owner-database guard and migration order as postgres-authority-join.
    const existing = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_execution','provider_access','runtime_security_dispatch_v1','runtime_security_dispatch_acceptance_v1','host_http_egress')");
    if (existing.rows.length !== 0) {throw new Error("Disposable database must have no owner schemas");}
    await applyContainedTurnPostgresSchema(pool);
    await initializePostgresHttpEgressEvidence(pool);
    setupStage = "pa";
    const pa = createPostgresOperationDispatchConsumption(pool, pins.issuance);
    actions.push(pa.dispose);
    await pa.control.migrate();
    const material = createPostgresMaterializationRepository(pool);
    actions.push(material.dispose);
    await material.migrate();
    const bindingVersion = await material.replaceBinding(pins.issuance.binding, 0);
    if (bindingVersion !== 1) {throw new Error("Initial PA binding was not acknowledged");}
    await pa.control.provisionIssuance();
    const {tenantId, projectId, scopeDigest} = pins.issuance.binding;
    const scope = Object.freeze({tenantId, projectId});
    const current = createPostgresCurrentProviderAccess(pool, {...scope, provider: "codex", scopeDigest});
    actions.push(current.dispose);
    // Route facts are supplied independently; the owner checks the actual CAS head.
    const route = createPostgresRouteSelectionOwner(pool, pins.route);
    actions.push(route.dispose);
    await route.control.migrate();
    await route.control.endorse(bindingVersion);
    setupStage = "rs";
    const digest = createNodeSha256DispatchDigest();
    const sql = {pool, connectTimeoutMs: 2000, queryTimeoutMs: 5000, transactionTimeoutMs: 10000};
    const repository = createPostgresDispatchConsumptionRepository({...sql, digest});
    actions.push(repository.close);
    const decisions = createPostgresDispatchAcceptanceStore(sql);
    actions.push(decisions.close);
    await repository.migrate();
    await decisions.migrate();
    const acceptance = createDispatchAcceptanceFeature({repository, decisions, digest,
      policy: pins.policy, clock: pins.clock});
    setupStage = "operation-store";
    const durable = new PostgresContainedTurnOperationStore({pool, intentAuthority: pins.intentAuthority});
    setupStage = "workspace";
    const workspace = await createNodeContainedTurnWorkspaceOwner(pins.workspace);
    actions.push(workspace.dispose);
    setupStage = "artifacts";
    const artifacts = await createNodeContainedTurnArtifacts(pins.artifacts);
    setupStage = "node-recipe";
    node = createLinuxCodexNodeRecipe({hostBootId: pins.hostBootId,
      hostInstanceId: pins.hostInstanceId, select: createLinuxCodexNodeSelection({...pins.node,
      ...(pins.firewall === undefined ? {} : {decorateListener: createLinuxCodexLiveFirewallWiring(pins.firewall)}),
        readAcknowledged(input) {
          const value = acknowledgedSelections.get(input.kernel.custodyId);
          acknowledgedSelections.delete(input.kernel.custodyId);
          return value;
        },
      })});
    const launchRecords = createLinuxCodexLiveLaunchRecords(pins, () => closing);
    setupStage = "host-composition";
    host = createHostCustodiedAgentRuntimeHost({authorityRevision: pins.authorityRevision,
      capabilities: pins.capabilities,
      containedTurn: {
        authority: "current",
        operationStore: bindOperationStore(durable), workspace: workspace.workspace, artifacts,
        providerAccess: Object.freeze({...current.providerAccess, dispatchConsumption: pa.dispatchConsumption}),
        security: Object.freeze({acceptance, profile: Object.freeze({policyRevision: pins.policyRevision})}),
        hostCustody: pins.hostCustody, routeEnforcement: pins.routeEnforcement,
        selectedProvider: Object.freeze({kind: "codex", owner: Object.freeze({
          hostBootId: pins.hostBootId, hostInstanceId: pins.hostInstanceId,
          platformTarget: pins.platformTarget, workspaceOwner: workspace,
          launchRecords,
        })}),
        linuxCodexDeployment: {...pins.deployment, sourceRevision: pins.sourceRevision,
          pool, recipe: nativeStart.wrap(node),
          createProviderAccess: createLinuxCodexPaRenderingFactory(pool,
            pins.credentials.takeOwnedMaterial.bind(pins.credentials)),
          currentPolicy(acknowledged) {
            const policy = selectCurrentPolicy(acknowledged);
            if (closing || acknowledgedSelections.has(acknowledged.input.subject.custodyId)) {
              throw new TypeError("Live acknowledged selection unavailable");
            }
            acknowledgedSelections.set(acknowledged.input.subject.custodyId, structuredClone({
              subject: acknowledged.input.subject,
              acceptedAuthorityVectorDigest: acknowledged.input.accepted.acceptedAuthorityVectorDigest,
              securityDecisionDigest: acknowledged.input.accepted.acceptedAuthorityVector.securityDecisionDigest,
            }));
            return policy;
          },
          currentAuthority: {runtimeSecurity: repository, providerAccess: route}},
      },
    });
    const containedTurn = host.bindAccess({containedTurn: scope}).containedTurn;
    let submitted = false;
    return Object.freeze({
      /** Exactly one dispatch attempt per bootstrap, including thrown/unknown
       * outcomes. Reconciliation uses observe; cleanup retries never resubmit. */
      async submit(input: Parameters<typeof containedTurn.submit>[0],
        options?: Parameters<typeof containedTurn.submit>[1]) {
        if (closing || submitted) {throw new Error("Live bootstrap dispatch already consumed or closed");}
        submitted = true;
        return nativeStart.settle(() => containedTurn.submit(input, options));
      },
      collectNativeStart: nativeStart.collect,
      observe: containedTurn.observe.bind(containedTurn),
      cancel: containedTurn.cancel.bind(containedTurn),
      cleanup,
      get cleanupState(): "open" | "pending" | "released" {
        return !closing ? "open" : hostReleased && nodeReleased && actions.length === 0 ? "released" : "pending";
      },
    });
  } catch (error) {
    constructionCleanupUnknown = error instanceof ContainedTurnConstructionCleanupError ||
      error instanceof ContainedTurnOwnerDisposalError;
    // Failed internal disposal exposes no recoverable Host handle. Keep the
    // borrowed authorities and all owned state quarantined in that case.
    // Do not discard partial owners or automatically repeat ambiguous PG writes.
    // Caller supplies a fresh cleanup deadline and retains this exception's handle.
    throw new LinuxCodexLiveSetupError(cleanup, setupStage);
  }
};
