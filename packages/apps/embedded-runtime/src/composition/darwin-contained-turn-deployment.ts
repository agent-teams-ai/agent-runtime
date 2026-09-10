import {createDarwinCodexRouteEnforcement, NodeHttpEgressBoundaryIds,
  NodeHttpEgressTrustedResolver, PostgresHttpEgressEvidence,
  type DarwinCodexRouteEnforcementInput} from "@agent-teams/agent-execution/composition";
import {createCredentialMaterializationRequestDigest, type createPostgresCredentialRenderingOwner} from "@agent-teams/provider-access/composition";
import {createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate} from "@agent-teams/runtime-security/composition";
import {createDarwinContainedTurnAuthority, captureDarwinDeploymentData as captureData,
  captureDarwinDeploymentPort as capturePort} from "./darwin-contained-turn-authority.js";
import {createContainedTurnCurrentEgressOwners, type ContainedTurnCurrentEgressOwnersInput} from "./contained-turn-current-egress-owners.js";
import {bindContainedTurnHttpEgressAuthorities, composeContainedTurnHttpEgressSession} from "./contained-turn-http-egress-authorities.js";
import {createContainedTurnHttpUpstreamTransport} from "./contained-turn-http-egress-upstream.js";
import {types} from "node:util";

type Signer = Parameters<typeof createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate>[0];
type SessionOwner = DarwinCodexRouteEnforcementInput["sessionOwner"];
type Session = ReturnType<SessionOwner["acquire"]>;
export interface DarwinContainedTurnDeploymentInput extends Omit<DarwinCodexRouteEnforcementInput, "sessionOwner"> {
  readonly runtimeSecurity: ContainedTurnCurrentEgressOwnersInput["runtimeSecurity"];
  readonly providerAccess: ContainedTurnCurrentEgressOwnersInput["providerAccess"];
  readonly rendering: {createRendering(operationRef: string): ReturnType<typeof createPostgresCredentialRenderingOwner>};
  readonly pool: ConstructorParameters<typeof PostgresHttpEgressEvidence>[0];
  readonly deploymentId: string;
  readonly currentPolicy: Pick<ContainedTurnCurrentEgressOwnersInput, "rule" | "approval" | "timing" | "monotonicNow">;
  readonly signer: Omit<Signer, "authorityOwner" | "scope" | "hostReservationId">;
  readonly dns: ConstructorParameters<typeof NodeHttpEgressTrustedResolver>[0];
  readonly transport: Parameters<typeof createContainedTurnHttpUpstreamTransport>[0];
  readonly clock: Session["clock"];
}

/** Private Embedded Runtime composition for the existing contained-agent-turn
 * profile. Fixed direct factories, outside scoped module adoption. This is the
 * single production PA/RS/AE authority root: neither a feature port nor an auth
 * acquisition owner. The internal Session-returning port never leaves this root.
 * Construction captures deployment only; acquisition starts with bridge.take. */
export const createDarwinContainedTurnDeployment = (raw: DarwinContainedTurnDeploymentInput) => {
  if (raw === null || typeof raw !== "object" || types.isProxy(raw) ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(field => !("value" in field))) {
    throw new TypeError("Invalid Darwin deployment input");
  }
  const input = Object.freeze({...raw,
    runtimeSecurity: capturePort(raw.runtimeSecurity, ["readAuthority"]),
    providerAccess: capturePort(raw.providerAccess, ["readCurrent"]),
    rendering: capturePort(raw.rendering, ["createRendering"]),
    pool: capturePort(raw.pool, ["connect"]),
    currentPolicy: captureData(raw.currentPolicy), signer: captureData(raw.signer),
    dns: captureData(raw.dns), transport: captureData(raw.transport), clock: captureData(raw.clock),
  });
  const bridge = createDarwinContainedTurnAuthority(input);
  const retained: Array<() => void> = [];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) {return;} disposed = true; bridge.dispose();
    for (const action of retained.splice(0).reverse()) {action();}
  };
  const sessionOwner: SessionOwner = Object.freeze({acquire(proof: Parameters<SessionOwner["acquire"]>[0]): Session {
    if (disposed) {throw new TypeError("Darwin deployment disposed");}
    const start = retained.length;
    try {
        const acknowledged = bridge.take(proof);
        const {subject} = acknowledged.input;
        const scope = {...subject.scope, scopeDigest: subject.scopeDigest, operationId: subject.operationId};
        const current = createContainedTurnCurrentEgressOwners({...input.currentPolicy,
          runtimeSecurity: input.runtimeSecurity, providerAccess: input.providerAccess,
          acceptedDispatch: acknowledged.acceptedDispatch,
          operation: {scope, providerId: 'codex', authorityGeneration: acknowledged.acceptedDispatch.authority!.authorityGeneration,
            claimBindingDigest: subject.runtimeSecurityRequest.claimBindingDigest}});
        retained.push(current.dispose);
        const signer = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({...input.signer,
          authorityOwner: current, scope, hostReservationId: subject.custodyId});
        retained.push(signer.dispose);
        const rendering = input.rendering.createRendering(subject.operationId);
        retained.push(rendering.owner.dispose);
        const authorities = bindContainedTurnHttpEgressAuthorities({providerAccess: rendering.owner,
          runtimeSecurity: signer, createRequestDigest: createCredentialMaterializationRequestDigest});
        retained.push(authorities.dispose);
        const ids = new NodeHttpEgressBoundaryIds();
        const resolver = new NodeHttpEgressTrustedResolver(input.dns, input.clock);
        const transport = createContainedTurnHttpUpstreamTransport(input.transport);
        const evidence = new PostgresHttpEgressEvidence(input.pool, {...subject.scope, deploymentId: input.deploymentId});
        const session = composeContainedTurnHttpEgressSession(authorities, {
          ...acknowledged.upstream, ids: {fresh: ids.fresh.bind(ids)}, clock: input.clock,
          resolver: {resolve: resolver.resolve.bind(resolver)}, transport: {beginOpen: transport.beginOpen.bind(transport)},
          evidence: {digest: evidence.digest.bind(evidence), record(receipt) {
            if (receipt.operationId !== subject.operationId || receipt.attemptId !== subject.attemptId) throw new Error('MAC_RECEIPT_IDENTITY_MISMATCH');
            return evidence.record(receipt);
          }},
          // Explicit inert slots replaced by genuine Host reservation finalizer.
          // These values confer no authority; use outside finalization always refuses.
          identity: {operationId: subject.operationId, attemptId: subject.attemptId, custodyId: subject.custodyId,
            hostBootId: subject.hostBootId, liveProcessSessionIdentity: Object.freeze({})},
          localAuthorityCut: {read() {throw new Error('UNBOUND_HOST_CUT');}}, journal: {consume() {return 'unknown';}},
        });
        return session;
    } catch (error) {
      for (const action of retained.splice(start).reverse()) {action();}
      throw error;
    }
  }});
  try {
    const routeEnforcement = createDarwinCodexRouteEnforcement({owner: input.owner,
      preparation: input.preparation, qualificationTarget: input.qualificationTarget, sessionOwner});
    return Object.freeze({routeEnforcement, bindAuthority: bridge.bind, bindStore: bridge.bindStore, dispose});
  } catch (error) {dispose(); throw error;}
};
