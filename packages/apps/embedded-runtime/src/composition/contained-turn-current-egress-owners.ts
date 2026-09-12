import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { nativeHttpRequestProfile } from "@agent-teams/agent-execution/composition";
import { snapshotRouteSelectionCurrent,
  type createPostgresRouteSelectionOwner } from "@agent-teams/provider-access/composition";
import { createCurrentEgressOwner, snapshotDispatchAuthorityHead,
  type CurrentEgressDispatchHead, type CurrentEgressEndorsement, type CurrentEgressOperation,
  type CurrentEgressOwnerInput, type PostgresDispatchConsumptionRepository } from
  "@agent-teams/runtime-security/composition";

type RsReader = Pick<PostgresDispatchConsumptionRepository, "readAuthority">;
type PaReader = Pick<ReturnType<typeof createPostgresRouteSelectionOwner>, "readCurrent">;
type AcceptedHead = Awaited<ReturnType<RsReader["readAuthority"]>>;

/** Actual owner contracts; none of the borrowed capabilities transfer disposal. */
export type ContainedTurnCurrentEgressOwnersInput = Omit<CurrentEgressOwnerInput,
  "acceptedDispatch" | "readRsHead" | "readPaEndorsement"> & Readonly<{
    acceptedDispatch: AcceptedHead;
    runtimeSecurity: RsReader;
    providerAccess: PaReader;
  }>;

const invalid = (): never => {throw new TypeError("Invalid current egress owner projection");};

// Only the repository's optional-head envelope is translated here. RS's existing
// validator owns the authority schema; the current owner validates the CAS version.
const projectHead = (value: AcceptedHead): CurrentEgressDispatchHead => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {return invalid();}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return invalid();}
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (!fields.headVersion || !("value" in fields.headVersion) ||
      keys.some(key => key !== "headVersion" && key !== "authority") ||
      (fields.authority && !("value" in fields.authority))) {return invalid();}
  const raw: unknown = fields.authority?.value;
  if (raw === undefined) {return { headVersion: fields.headVersion.value, authority: null };}
  if (raw === null || typeof raw !== "object" || types.isProxy(raw)) {return invalid();}
  // The domain snapshot uses own-data reflection. Reject proxy scope before that
  // reflection too, without invoking a getter on the supplied head.
  const scope = Object.getOwnPropertyDescriptor(raw, "scope");
  if (!scope || !("value" in scope) || types.isProxy(scope.value)) {return invalid();}
  const head = snapshotDispatchAuthorityHead(raw) ?? invalid();
  return {
    headVersion: fields.headVersion.value,
    authority: {
      operation: {
        scope: { ...head.scope, operationId: head.operationId },
        providerId: head.providerId,
        authorityGeneration: head.authorityGeneration,
        claimBindingDigest: head.claimBindingDigest,
      },
      decision: head.decision,
      purpose: head.purpose,
      authorityRevision: head.authorityRevision,
      acceptedAuthorityDigest: head.acceptedAuthorityDigest,
      authorityHeadDigest: head.authorityHeadDigest,
      constraintsDigest: head.constraintsDigest,
      containmentPolicyDigest: head.containmentPolicyDigest,
      requestDigest: head.requestDigest,
      providerBindingDigest: head.providerBindingDigest,
      claimBeforeControlTime: head.claimBeforeControlTime,
      revoked: head.revoked,
      ownerEvidenceRef: head.ownerEvidenceRef,
    },
  };
};

const projectRoute = async (raw: Awaited<ReturnType<PaReader["readCurrent"]>>,
  operation: CurrentEgressOperation): Promise<CurrentEgressEndorsement | null> => {
  if (raw === undefined) {return null;}
  // PA validates and detaches its full binding, descriptor, generation and digest
  // before any of those returned facts can become an RS endorsement.
  const current = await snapshotRouteSelectionCurrent(raw);
  const { binding, descriptor } = current;
  if (binding.tenantId !== operation.scope.tenantId || binding.projectId !== operation.scope.projectId ||
      binding.scopeDigest !== operation.scope.scopeDigest || binding.provider !== operation.providerId) {
    return invalid();
  }
  const profile = nativeHttpRequestProfile(descriptor.id);
  if (profile === undefined || !isDeepStrictEqual(descriptor, profile)) {return invalid();}
  const path = Buffer.from(descriptor.upstreamPath, "utf8");
  return {
    operation,
    accessRef: binding.accessRef,
    accountRef: binding.providerAccountRef,
    providerRouteRef: binding.providerRouteRef,
    bindingRevision: binding.bindingRevision,
    credentialBindingDigest: binding.credentialBindingDigest,
    credentialGeneration: String(binding.credentialGeneration),
    routeAuthorityDigest: current.routeAuthorityDigest,
    available: binding.availability === "available",
    revoked: binding.revocation !== "active",
    route: {
      method: descriptor.upstreamMethod,
      origin: { scheme: "https", hostname: descriptor.originHost, port: descriptor.originPort },
      requestTarget: { digest: `sha256:${createHash("sha256").update(path).digest("hex")}`,
        byteLength: path.byteLength },
      credentialSlots: descriptor.credentialFieldNames.toSorted(),
      credentialRecipeRef: current.recipe,
      framing: { protocol: "http/1.1", requestTarget: "origin-form", authoritySource: "host",
        contentLength: "body-byte-length", transferEncoding: "absent", connectionSpecificHeaders: "absent" },
    },
  };
};

/**
 * Private, inert outer ACL for an already accepted operation and explicitly
 * approved RS rule. The existing current owner snapshots configuration and owns
 * RS / PA / RS observations, lifetime and fail-closed behavior. This factory does
 * not approve policy, endorse a route, read a database, or create a signer.
 *
 * These native async wrappers trust reader implementation code and intact Promise
 * intrinsics, never returned data. Snapshot each borrowed method and its receiver;
 * a bound Promise supplier alone would violate the current owner's input contract.
 * The returned dispose closes only the newly created current owner. Async database
 * observations are never a synchronous Host localAuthorityCut.
 */
export const createContainedTurnCurrentEgressOwners = (input: ContainedTurnCurrentEgressOwnersInput):
  ReturnType<typeof createCurrentEgressOwner> => {
  const rs = input.runtimeSecurity;
  const pa = input.providerAccess;
  const readAuthority = rs.readAuthority;
  const readCurrent = pa.readCurrent;
  if (typeof readAuthority !== "function" || typeof readCurrent !== "function" ||
      types.isProxy(readAuthority) || types.isProxy(readCurrent)) {return invalid();}
  return createCurrentEgressOwner({
    operation: input.operation,
    acceptedDispatch: projectHead(input.acceptedDispatch),
    rule: input.rule,
    approval: input.approval,
    timing: input.timing,
    monotonicNow: input.monotonicNow,
    async readRsHead(operation) {
      const { tenantId, projectId, scopeDigest, operationId } = operation.scope;
      return projectHead(await Reflect.apply(readAuthority, rs, [{
        scope: { tenantId, projectId, scopeDigest }, operationId,
        providerId: operation.providerId, authorityGeneration: operation.authorityGeneration,
      }]));
    },
    async readPaEndorsement(operation) {
      return projectRoute(await Reflect.apply(readCurrent, pa, []), operation);
    },
  });
};
