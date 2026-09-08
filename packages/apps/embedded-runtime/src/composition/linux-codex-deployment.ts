import {
  NodeHttpEgressBoundaryIds, NodeHttpEgressTrustedResolver, PostgresHttpEgressEvidence,
} from "@agent-teams/agent-execution/composition";
import type {LinuxCodexContainedTurnResources} from "./linux-codex-contained-turn-owner.js";
import {createLinuxCodexDeploymentAuthority} from "./linux-codex-deployment-authority.js";
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
  readonly authorities: Selection["authorities"];
  readonly signer: Omit<Selection["signer"], "scope" | "hostReservationId">;
  readonly clock: Selection["broker"]["clock"];
  recipe(input: SelectInput): Readonly<{
    preparation: Selection["preparation"];
    route: Omit<Selection["route"], "binding">;
    nativeFiles: Selection["nativeFiles"];
    connection: Selection["connection"];
    /** These slots are replaced by Host activation; their supplied values must
     * still be fail-closed, never observations of an unallocated reservation. */
    hostSession: Pick<Selection["broker"], "identity" | "localAuthorityCut" | "journal">;
  }>;
}

/** Private real caller of the HTTP resource owners. There is no selectable
 * authority until the same feature's PA and RS ports acknowledge publication.
 * The Host still owns the sole claim/start/cleanup lifecycle and seven ports.
 */
export const createLinuxCodexDeploymentResources = (infrastructure: LinuxCodexDeploymentInfrastructure,
  host: Readonly<{hostBootId: string; hostInstanceId: string}>): Readonly<{resources: LinuxCodexContainedTurnResources; bindAuthority: ReturnType<typeof createLinuxCodexDeploymentAuthority>["bind"]}> => {
  const {hostBootId, hostInstanceId} = host;
  const authority = createLinuxCodexDeploymentAuthority(infrastructure.currentAuthority, infrastructure.sourceRevision);
  const resources: LinuxCodexContainedTurnResources = Object.freeze({
    imageInitLock: infrastructure.imageInitLock, cleanupMilliseconds: infrastructure.cleanupMilliseconds,
    select(input: SelectInput) {
      const acknowledged = authority.take(input.kernel);
      const {subject} = acknowledged.input;
      if (subject.hostBootId !== hostBootId || subject.hostInstanceId !== hostInstanceId) {
        throw new TypeError("Linux Codex acknowledged Host binding mismatch");
      }
      const policy = infrastructure.currentPolicy(acknowledged);
      const recipe = infrastructure.recipe(input);
      const scope = Object.freeze({...subject.scope, scopeDigest: subject.scopeDigest, operationId: subject.operationId});
      const ids = new NodeHttpEgressBoundaryIds();
      const resolver = new NodeHttpEgressTrustedResolver(infrastructure.dns, infrastructure.clock);
      const evidence = new PostgresHttpEgressEvidence(infrastructure.pool, {
        tenantId: scope.tenantId, projectId: scope.projectId, deploymentId: infrastructure.deploymentId,
      });
      const transport = createContainedTurnHttpUpstreamTransport(infrastructure.transport);
      return Object.freeze({preparation: recipe.preparation, route: Object.freeze({...recipe.route, binding: acknowledged.binding}),
        nativeFiles: recipe.nativeFiles, connection: recipe.connection,
        currentAuthority: Object.freeze({...policy, ...infrastructure.currentAuthority, acceptedDispatch: acknowledged.acceptedDispatch,
          operation: Object.freeze({scope, providerId: "codex", authorityGeneration: acknowledged.acceptedDispatch.authority!.authorityGeneration,
            claimBindingDigest: subject.runtimeSecurityRequest.claimBindingDigest})}),
        signer: Object.freeze({...infrastructure.signer, scope, hostReservationId: subject.custodyId}),
        authorities: infrastructure.authorities,
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
      });
    },
  });
  return Object.freeze({resources, bindAuthority: authority.bind});
};
