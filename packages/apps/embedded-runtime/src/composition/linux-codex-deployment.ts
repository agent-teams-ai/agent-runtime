import {types} from "node:util";
import {
  bindContainedTurnRouteEnforcement, readContainedTurnRouteEnforcementTarget, type ContainedTurnRouteEnforcementCapability,
  NodeHttpEgressBoundaryIds, NodeHttpEgressTrustedResolver, PostgresHttpEgressEvidence,
} from "@agent-teams/agent-execution/composition";
import type {LinuxCodexContainedTurnResources} from "./linux-codex-contained-turn-owner.js";
import {captureLinuxCodexDeploymentData, captureLinuxCodexDeploymentPort, createLinuxCodexDeploymentAuthority} from "./linux-codex-deployment-authority.js";
import {createContainedTurnHttpUpstreamTransport} from "./contained-turn-http-egress-upstream.js";

type Selection = ReturnType<LinuxCodexContainedTurnResources["select"]>;
type SelectInput = Parameters<LinuxCodexContainedTurnResources["select"]>[0];
type Current = Selection["currentAuthority"];

/** Trusted deployment infrastructure, borrowed from existing owners. The recipe
 * supplies pinned Engine/tools/image, private journals and native files through
 * their existing contracts; it runs only after committed claim. No workspace,
 * environment, credential discovery, migrations or qualification flags here.
 */
export interface LinuxCodexDeploymentInfrastructure {
  readonly imageInitLock: LinuxCodexContainedTurnResources["imageInitLock"];
  readonly cleanupMilliseconds: number;
  readonly sourceRevision: string;
  readonly deploymentId: string;
  readonly pool: ConstructorParameters<typeof PostgresHttpEgressEvidence>[0];
  readonly dns: ConstructorParameters<typeof NodeHttpEgressTrustedResolver>[0];
  readonly transport: Parameters<typeof createContainedTurnHttpUpstreamTransport>[0];
  readonly currentAuthority: Pick<Current, "runtimeSecurity" | "providerAccess">;
  /** Select an independently approved RS policy for the acknowledged operation.
   * This callback must not mint approval from the operation's requested policy. */
  currentPolicy(input: ReturnType<ReturnType<typeof createLinuxCodexDeploymentAuthority>["take"]>):
    Omit<Current, "operation" | "acceptedDispatch" | "runtimeSecurity" | "providerAccess">;
  readonly authorities: Omit<Selection["authorities"], "providerAccess">;
  /** Allocate one concrete rendering lifetime after acknowledgement and claim.
   * Bind its signal, deadline and material to this acknowledged operation.
   * The factory owns cleanup if it throws before returning an owner. */
  createProviderAccess(input: SelectInput,
    acknowledged: ReturnType<ReturnType<typeof createLinuxCodexDeploymentAuthority>["take"]>):
    Selection["authorities"]["providerAccess"];
  readonly signer: Omit<Selection["signer"], "scope" | "hostReservationId">;
  readonly clock: Selection["broker"]["clock"];
  recipe(input: SelectInput): Readonly<{
    preparation: Selection["preparation"];
    /** Exact operation recipe projection; the nominal owner validates provenance. */
    route: Omit<Selection["route"], "binding">;
    nativeFiles: Selection["nativeFiles"];
    connection: Selection["connection"];
    /** These slots are replaced by Host activation; their supplied values must
     * still be fail-closed, never observations of an unallocated reservation. */
    hostSession: Pick<Selection["broker"], "identity" | "localAuthorityCut" | "journal">;
  }>;
}

const captureInfrastructure = (value: LinuxCodexDeploymentInfrastructure): LinuxCodexDeploymentInfrastructure => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Linux Codex deployment infrastructure unavailable");
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.values(fields).some(field => !("value" in field))) {
    throw new TypeError("Linux Codex deployment infrastructure accessor unavailable");
  }
  const current = fields.currentAuthority?.value as LinuxCodexDeploymentInfrastructure["currentAuthority"];
  if (current === null || typeof current !== "object" || types.isProxy(current)) {
    throw new TypeError("Linux Codex deployment current authority unavailable");
  }
  const readers = Object.getOwnPropertyDescriptors(current);
  if (!readers.runtimeSecurity || !("value" in readers.runtimeSecurity) ||
      !readers.providerAccess || !("value" in readers.providerAccess)) {
    throw new TypeError("Linux Codex deployment current authority accessor unavailable");
  }
  return captureLinuxCodexDeploymentData({...value,
    ...captureLinuxCodexDeploymentPort(value, ["currentPolicy", "recipe", "createProviderAccess"]),
    pool: captureLinuxCodexDeploymentPort(fields.pool?.value as LinuxCodexDeploymentInfrastructure["pool"], ["connect"]),
    currentAuthority: {
      runtimeSecurity: captureLinuxCodexDeploymentPort(readers.runtimeSecurity.value as Current["runtimeSecurity"], ["readAuthority"]),
      providerAccess: captureLinuxCodexDeploymentPort(readers.providerAccess.value as Current["providerAccess"], ["readCurrent"]),
    },
  });
};

export interface LinuxCodexDeploymentResources {
  readonly resources: LinuxCodexContainedTurnResources;
  readonly bindAuthority: ReturnType<typeof createLinuxCodexDeploymentAuthority>["bind"];
  readonly bindOperationStore: ReturnType<typeof createLinuxCodexDeploymentAuthority>["bindStore"];
  dispose(): void;
}

/** Private real caller of the HTTP resource owners. There is no selectable
 * authority until the same feature's PA and RS ports acknowledge publication.
 * The Host still owns the sole claim/start/cleanup lifecycle and seven ports.
 */
export const createLinuxCodexDeploymentResources = (infrastructure: LinuxCodexDeploymentInfrastructure,
  host: Readonly<{hostBootId: string; hostInstanceId: string}>,
  routeEnforcement: ContainedTurnRouteEnforcementCapability): LinuxCodexDeploymentResources => {
  const target = readContainedTurnRouteEnforcementTarget(routeEnforcement);
  if (target === undefined || target.provider !== "codex" || target.platform !== `${process.platform}-${process.arch}`) {
    throw new TypeError("Linux Codex deployment route qualification unavailable");
  }
  infrastructure = captureInfrastructure(infrastructure);
  const {hostBootId, hostInstanceId} = captureLinuxCodexDeploymentData(host);
  const authority = createLinuxCodexDeploymentAuthority(infrastructure.currentAuthority, infrastructure.sourceRevision);
  const selectedOwners = new WeakSet<object>();
  const resources: LinuxCodexContainedTurnResources = Object.freeze({
    imageInitLock: infrastructure.imageInitLock, cleanupMilliseconds: infrastructure.cleanupMilliseconds,
    select(input: SelectInput): Selection {
      const acknowledged = authority.take(input.kernel);
      const {subject} = acknowledged.input;
      if (subject.hostBootId !== hostBootId || subject.hostInstanceId !== hostInstanceId) {
        throw new TypeError("Linux Codex acknowledged Host binding mismatch");
      }
      const policy = infrastructure.currentPolicy(acknowledged);
      const recipe = infrastructure.recipe(input);
      const route = bindContainedTurnRouteEnforcement(routeEnforcement, acknowledged.binding, recipe);
      const scope = Object.freeze({...subject.scope, scopeDigest: subject.scopeDigest, operationId: subject.operationId});
      const ids = new NodeHttpEgressBoundaryIds();
      const resolver = new NodeHttpEgressTrustedResolver(infrastructure.dns, infrastructure.clock);
      const evidence = new PostgresHttpEgressEvidence(infrastructure.pool, {
        tenantId: scope.tenantId, projectId: scope.projectId, deploymentId: infrastructure.deploymentId,
      });
      const transport = createContainedTurnHttpUpstreamTransport(infrastructure.transport);
      const selection = {preparation: recipe.preparation, route,
        nativeFiles: recipe.nativeFiles, connection: recipe.connection,
        currentAuthority: Object.freeze({...policy, ...infrastructure.currentAuthority, acceptedDispatch: acknowledged.acceptedDispatch,
          operation: Object.freeze({scope, providerId: "codex", authorityGeneration: acknowledged.acceptedDispatch.authority!.authorityGeneration,
            claimBindingDigest: subject.runtimeSecurityRequest.claimBindingDigest})}),
        signer: Object.freeze({...infrastructure.signer, scope, hostReservationId: subject.custodyId}),
        broker: Object.freeze({...recipe.hostSession, ...acknowledged.upstream, clock: infrastructure.clock,
          ids: Object.freeze({fresh: ids.fresh.bind(ids)}),
          resolver: Object.freeze({resolve: resolver.resolve.bind(resolver)}),
          evidence: Object.freeze({digest: evidence.digest.bind(evidence), record: (receipt: Parameters<typeof evidence.record>[0]) => {
            if (receipt.operationId !== input.kernel.operationId || receipt.attemptId !== input.kernel.attemptId) {
              throw new TypeError("Linux Codex HTTP receipt binding mismatch");
            }
            return evidence.record(receipt);
          }}),
          transport: Object.freeze({beginOpen: transport.beginOpen.bind(transport)}),
        }),
      };
      const owner = infrastructure.createProviderAccess(input, acknowledged);
      // Reusing a concrete owner would couple sibling cancellation. Do not
      // dispose a rejected duplicate: its original operation still owns it.
      if (selectedOwners.has(owner)) {throw new TypeError("Linux Codex rendering owner already selected");}
      const disposeOwner = captureLinuxCodexDeploymentPort(owner, ["dispose"]).dispose;
      selectedOwners.add(owner);
      let disposed = false;
      const dispose = (): void => {if (!disposed) {disposed = true; disposeOwner();}};
      try {
        const providerAccess = Object.freeze({...captureLinuxCodexDeploymentData(owner), dispose});
        return Object.freeze({...selection, dispose,
          authorities: Object.freeze({...infrastructure.authorities, providerAccess})});
      } catch (error) {dispose(); throw error;}
    },
  });
  return Object.freeze({resources, bindAuthority: authority.bind, bindOperationStore: authority.bindStore, dispose: authority.dispose});
};
