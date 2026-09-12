import {createDarwinCodexRouteEnforcement, NodeHttpEgressBoundaryIds,
  NodeHttpEgressTrustedResolver, PostgresHttpEgressEvidence,
  type DarwinCodexRouteEnforcementInput} from "@agent-teams/agent-execution/composition";
import {createCredentialMaterializationRequestDigest, type createPostgresCredentialRenderingOwner} from "@agent-teams/provider-access/composition";
import {createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate} from "@agent-teams/runtime-security/composition";
import {createDarwinContainedTurnAuthority, captureDarwinDeploymentData as captureData,
  captureDarwinDeploymentPort as capturePort} from "./darwin-contained-turn-authority.js";
import {createContainedTurnCurrentEgressOwners, type ContainedTurnCurrentEgressOwnersInput} from "../../composition/contained-turn-current-egress-owners.js";
import {bindContainedTurnHttpEgressAuthorities, composeContainedTurnHttpEgressSession} from "../../composition/contained-turn-http-egress-authorities.js";
import {createContainedTurnHttpUpstreamTransport} from "../../composition/contained-turn-http-egress-upstream.js";
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
  /** Borrow the authorized deployment policy owner, as in Linux deployment infrastructure.
   * Select an independently approved exact policy AFTER fresh claimed acknowledgement.
   * This contract does not issue approval or authenticate an arbitrary supplied owner. */
  readonly policyOwner: {
    currentPolicy(acknowledged: ReturnType<ReturnType<typeof createDarwinContainedTurnAuthority>["take"]>):
      Pick<ContainedTurnCurrentEgressOwnersInput, "rule" | "approval" | "timing" | "monotonicNow">;
  };
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
export const createDarwinContainedTurnDeployment = (raw: DarwinContainedTurnDeploymentInput): Readonly<{
  routeEnforcement: ReturnType<typeof createDarwinCodexRouteEnforcement>;
  bindAuthority: ReturnType<typeof createDarwinContainedTurnAuthority>["bind"];
  bindStore: ReturnType<typeof createDarwinContainedTurnAuthority>["bindStore"];
  dispose: ReturnType<typeof createDarwinContainedTurnAuthority>["dispose"];
}> => {
  if (raw === null || typeof raw !== "object" || types.isProxy(raw)) {
    throw new TypeError("Invalid Darwin deployment input");
  }
  const required = ["owner", "preparation", "qualificationTarget", "runtimeSecurity", "providerAccess",
    "rendering", "pool", "deploymentId", "policyOwner", "signer", "dns", "transport", "clock"] as const;
  const record = Object.create(null) as DarwinContainedTurnDeploymentInput;
  for (const key of Reflect.ownKeys(raw)) {
    const field = Object.getOwnPropertyDescriptor(raw, key)!;
    if (typeof key !== "string" || !("value" in field)) {throw new TypeError("Invalid Darwin deployment field");}
    Object.defineProperty(record, key, {value: field.value, enumerable: true});
  }
  if (required.some(key => !Object.hasOwn(record, key))) {throw new TypeError("Missing Darwin deployment field");}
  const input = Object.freeze({...record,
    runtimeSecurity: capturePort(record.runtimeSecurity, ["readAuthority"]),
    providerAccess: capturePort(record.providerAccess, ["readCurrent"]),
    rendering: capturePort(record.rendering, ["createRendering"]),
    pool: capturePort(record.pool, ["connect"]),
    policyOwner: capturePort(record.policyOwner, ["currentPolicy"]), signer: captureData(record.signer),
    dns: captureData(record.dns), transport: captureData(record.transport), clock: captureData(record.clock),
  });
  const bridge = createDarwinContainedTurnAuthority(input);
  const retained: Array<() => void> = [];
  const cleanupFailures: unknown[] = [];
  let disposed = false;
  // Attempt all independent actions once. Unknown outcomes are never retried;
  // failure debt survives rollback and every subsequent disposal.
  const drain = (start: number): void => {
    while (retained.length > start) {
      const action = retained.pop()!;
      try {action();} catch (error) {cleanupFailures.push(error);}
    }
  };
  const assertClean = (): void => {
    if (cleanupFailures.length === 1) {throw cleanupFailures[0];}
    if (cleanupFailures.length > 1) {throw new AggregateError(cleanupFailures, "Darwin deployment cleanup unproven");}
  };
  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      try {bridge.dispose();} catch (error) {cleanupFailures.push(error);}
      drain(0);
    }
    assertClean();
  };
  const sessionOwner: SessionOwner = Object.freeze({acquire(proof: Parameters<SessionOwner["acquire"]>[0]): Session {
    if (disposed || cleanupFailures.length > 0) {throw new TypeError("Darwin deployment disposed");}
    const start = retained.length;
    try {
        const acknowledged = captureData(bridge.take(proof));
        const {subject} = acknowledged.input;
        const scope = {...subject.scope, scopeDigest: subject.scopeDigest, operationId: subject.operationId};
        const policy = captureData(input.policyOwner.currentPolicy(acknowledged));
        const current = createContainedTurnCurrentEgressOwners({...policy,
          runtimeSecurity: input.runtimeSecurity, providerAccess: input.providerAccess,
          acceptedDispatch: acknowledged.acceptedDispatch,
          operation: {scope, providerId: 'codex', authorityGeneration: acknowledged.acceptedDispatch.authority!.authorityGeneration,
            claimBindingDigest: subject.runtimeSecurityRequest.claimBindingDigest}});
        retained.push(current.dispose);
        const signer = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({...input.signer,
          authorityOwner: current, scope, hostReservationId: subject.custodyId});
        retained.push(signer.dispose);
        const rendering = input.rendering.createRendering(subject.operationId);
        const renderingDispose = capturePort(rendering.owner, ["dispose"]).dispose;
        retained.push(renderingDispose);
        const authorities = bindContainedTurnHttpEgressAuthorities({providerAccess: captureData(rendering.owner),
          runtimeSecurity: signer, createRequestDigest: createCredentialMaterializationRequestDigest});
        // ACL now owns the sole PA disposal path.
        retained[retained.length - 1] = authorities.dispose;
        const ids = new NodeHttpEgressBoundaryIds();
        const resolver = new NodeHttpEgressTrustedResolver(input.dns, input.clock);
        const transport = createContainedTurnHttpUpstreamTransport(input.transport);
        const evidence = new PostgresHttpEgressEvidence(input.pool, {...subject.scope, deploymentId: input.deploymentId});
        const session = composeContainedTurnHttpEgressSession(authorities, {
          ...acknowledged.upstream, ids: {fresh: ids.fresh.bind(ids)}, clock: input.clock,
          resolver: {resolve: resolver.resolve.bind(resolver)}, transport: {beginOpen: transport.beginOpen.bind(transport)},
          evidence: {digest: evidence.digest.bind(evidence), record(receipt) {
            if (receipt.operationId !== subject.operationId || receipt.attemptId !== subject.attemptId) {throw new Error('MAC_RECEIPT_IDENTITY_MISMATCH');}
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
      drain(start);
      if (cleanupFailures.length > 0) {
        // oxlint-disable-next-line eslint/preserve-caught-error -- original error is retained in errors; preserve the existing cause/redaction surface
        throw new AggregateError([error, ...cleanupFailures], "Darwin acquisition and cleanup failed");
      }
      throw error;
    }
  }});
  try {
    const routeEnforcement = createDarwinCodexRouteEnforcement({owner: input.owner,
      preparation: input.preparation, qualificationTarget: input.qualificationTarget, sessionOwner});
    return Object.freeze({routeEnforcement, bindAuthority: bridge.bind, bindStore: bridge.bindStore, dispose});
  } catch (error) {dispose(); throw error;}
};
