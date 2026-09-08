import {createContainedTurnHttpEgressRoute} from "./contained-turn-http-egress-upstream.js";
import {createContainedTurnLinuxRouteBinding} from "./contained-turn-linux-route-binding.js";
import {isDeepStrictEqual} from "node:util";
import type {ContainedTurnFeatureDependencies} from "@agent-teams/agent-execution/composition";
import {snapshotDispatchAuthorityHead} from "@agent-teams/runtime-security/composition";
import {snapshotRouteSelectionCurrent} from "@agent-teams/provider-access/composition";
import type {ContainedTurnCurrentEgressOwnersInput} from "./contained-turn-current-egress-owners.js";
import type {LinuxCodexContainedTurnResources} from "./linux-codex-contained-turn-owner.js";

type Ports = Pick<ContainedTurnFeatureDependencies, "providerAccess" | "security">;
type Input = Parameters<Ports["security"]["consumeForDispatch"]>[0];
type PaReceipt = Extract<Awaited<ReturnType<Ports["providerAccess"]["consumeForDispatch"]>>, {kind: "consumed"}>["receipt"];
type RsReceipt = Extract<Awaited<ReturnType<Ports["security"]["consumeForDispatch"]>>, {kind: "consumed"}>["receipt"];
type Readers = Pick<ContainedTurnCurrentEgressOwnersInput, "runtimeSecurity" | "providerAccess">;
type Head = ContainedTurnCurrentEgressOwnersInput["acceptedDispatch"];
type Route = Awaited<ReturnType<typeof snapshotRouteSelectionCurrent>>;
type Retained = {input: Input; pa?: PaReceipt; rs?: RsReceipt; head?: Head; route?: Route; upstream?: Awaited<ReturnType<typeof createContainedTurnHttpEgressRoute>>; binding?: Awaited<ReturnType<typeof createContainedTurnLinuxRouteBinding>>; generation?: number; selected?: boolean};
const unavailable = (): never => {throw new TypeError("Linux Codex acknowledged deployment authority unavailable");};

const validateConsumedPair = (pa: PaReceipt, rs: RsReceipt, subject: Input["subject"], accepted: Input["accepted"]): void => {
    if (!isDeepStrictEqual(pa.authorityFacts, subject.providerAccessExpectation) ||
        !isDeepStrictEqual(rs.authorityFacts, subject.runtimeSecurityExpectation) ||
        pa.grantRequestId !== subject.providerAccessRequest.grantRequestId || rs.grantRequestId !== subject.runtimeSecurityRequest.grantRequestId ||
        pa.provider !== "codex" || rs.provider !== "codex" ||
        !isDeepStrictEqual(pa.scope, {...subject.scope, scopeDigest: subject.scopeDigest}) || !isDeepStrictEqual(pa.scope, rs.scope) ||
        pa.operationId !== subject.operationId || rs.operationId !== subject.operationId ||
        pa.requestDigest !== subject.providerAccessRequest.requestDigest ||
        rs.requestDigest !== subject.runtimeSecurityRequest.requestDigest ||
        pa.claimBindingDigest !== subject.providerAccessRequest.claimBindingDigest ||
        rs.claimBindingDigest !== subject.runtimeSecurityRequest.claimBindingDigest ||
        pa.authorityFacts.acceptedAuthorityDigest !== accepted.acceptedAuthorityVectorDigest) {return unavailable();}
};

const validatePublishedHead = (head: ReturnType<typeof snapshotDispatchAuthorityHead>, key: {scope: PaReceipt["scope"]; operationId: string; providerId: string}, rs: RsReceipt): void => {
    if (head === undefined || head === null || head.decision !== "accepted" || head.revoked ||
        head.purpose !== rs.purpose || head.ownerEvidenceRef !== rs.ownerEvidenceRef || head.operationId !== key.operationId || head.providerId !== key.providerId ||
        !isDeepStrictEqual(head.scope, key.scope) || head.claimBindingDigest !== rs.claimBindingDigest ||
        head.requestDigest !== rs.requestDigest || head.claimBeforeControlTime !== rs.claimBeforeControlTime ||
        head.authorityHeadDigest !== rs.authorityFacts.authorityHeadDigest ||
        head.authorityGeneration !== rs.authorityFacts.authorityGeneration ||
        head.acceptedAuthorityDigest !== rs.authorityFacts.acceptedAuthorityDigest ||
        head.authorityRevision !== rs.authorityFacts.authorityRevision ||
        head.constraintsDigest !== rs.authorityFacts.constraintsDigest ||
        head.containmentPolicyDigest !== rs.authorityFacts.containmentPolicyDigest ||
        head.providerBindingDigest !== rs.authorityFacts.providerBindingDigest) {return unavailable();}
};

const validatePublishedRoute = (binding: Route["binding"], scope: PaReceipt["scope"], pa: PaReceipt): void => {
    if (binding.provider !== "codex" || binding.availability !== "available" || binding.revocation !== "active" ||
        binding.tenantId !== scope.tenantId || binding.projectId !== scope.projectId || binding.scopeDigest !== scope.scopeDigest ||
        binding.accessRef !== pa.authorityFacts.accessRef || binding.providerAccountRef !== pa.authorityFacts.providerAccountRef ||
        binding.providerRouteRef !== pa.authorityFacts.providerRouteRef || binding.bindingRevision !== pa.authorityFacts.bindingRevision ||
        binding.credentialBindingRef !== pa.authorityFacts.credentialBindingRef ||
        // AE's credentialBindingDigest is a canonical wrapper. PA's published
        // authority head retains the original opaque owner digest verbatim.
        binding.credentialBindingDigest !== pa.authorityFacts.authorityHeadDigest ||
        binding.credentialGeneration !== pa.authorityFacts.credentialGeneration) {return unavailable();}
};

/** Private acknowledgement join, called after the existing PA/RS ACLs. A read
 * failure never hides an already consumed grant from AE's settlement lifecycle.
 * Only a complete matching pair becomes selectable, after committed claim.
 * There is deliberately no launch-record hook and no authority publication here.
 */
export interface LinuxCodexDeploymentAuthority {
  bind(ports: Ports): Ports;
  take(kernel: Parameters<LinuxCodexContainedTurnResources["select"]>[0]["kernel"]): Readonly<{
    input: Input; acceptedDispatch: Head; current: Route;
    upstream: NonNullable<Retained["upstream"]>; binding: NonNullable<Retained["binding"]>;
  }>;
}
export const createLinuxCodexDeploymentAuthority = (readers: Readers, sourceRevision: string): LinuxCodexDeploymentAuthority => {
  const retained = new Map<string, Retained>();
  const rsRead = readers.runtimeSecurity.readAuthority.bind(readers.runtimeSecurity);
  const paRead = readers.providerAccess.readCurrent.bind(readers.providerAccess);
  const entry = (input: Input): Retained => {
    const key = input.subject.custodyId;
    const previous = retained.get(key);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(previous.input, input) || previous.selected) {return unavailable();}
      return previous;
    }
    if (retained.size >= 64) {return unavailable();}
    const value = {input: structuredClone(input)};
    retained.set(key, value);
    return value;
  };
  const capture = async (value: Retained) => {
    const generation = (value.generation ?? 0) + 1; value.generation = generation;
    delete value.head; delete value.route;
    const {pa, rs, input: {subject, accepted}} = value;
    if (pa === undefined || rs === undefined) {return;}
    validateConsumedPair(pa, rs, subject, accepted);
    const key = {scope: {...subject.scope, scopeDigest: subject.scopeDigest}, operationId: subject.operationId,
      providerId: "codex", authorityGeneration: rs.authorityFacts.authorityGeneration};
    const before = await rsRead(key);
    const raw = await paRead();
    const after = await rsRead(key);
    if (after.headVersion !== "1" || !isDeepStrictEqual(before, after)) {return unavailable();}
    const head = snapshotDispatchAuthorityHead(after.authority);
    validatePublishedHead(head, key, rs);
    const route = await snapshotRouteSelectionCurrent(raw);
    const binding = route.binding;
    validatePublishedRoute(binding, key.scope, pa);
    const upstream = await createContainedTurnHttpEgressRoute({current: route, provider: "codex"});
    const bindingProjection = await createContainedTurnLinuxRouteBinding({current: route, provider: "codex", campaign: {
      operationId: subject.operationId, attemptId: subject.attemptId, custodyId: subject.custodyId,
      hostBootId: subject.hostBootId, executionGenerationId: subject.executionGenerationId,
      authorityVectorDigest: accepted.acceptedAuthorityVectorDigest, sourceRevision,
      adapterRevision: accepted.acceptedAuthorityVector.adapterSnapshot.adapterRevision,
      binaryRevision: accepted.acceptedAuthorityVector.adapterSnapshot.binaryRevision,
      capabilityManifestRevision: accepted.acceptedAuthorityVector.adapterSnapshot.capabilityManifestRevision,
    }});
    if (value.generation !== generation || value.selected) {return unavailable();}
    value.upstream = upstream; value.binding = bindingProjection;
    value.head = structuredClone(after); value.route = route;
  };
  return Object.freeze({
    bind(ports: Ports): Ports {
      return Object.freeze({
        providerAccess: Object.freeze({...ports.providerAccess, async consumeForDispatch(input: Parameters<Ports["providerAccess"]["consumeForDispatch"]>[0]) {
          const outcome = await ports.providerAccess.consumeForDispatch(input);
          if (outcome.kind === "consumed") {
            try {const value = entry({accepted: input.accepted, subject: input.subject}); value.pa = structuredClone(outcome.receipt); await capture(value);} catch { /* Keep the consumed grant visible to AE. */ }
          }
          return outcome;
        }}),
        security: Object.freeze({...ports.security, async consumeForDispatch(input: Input) {
          const outcome = await ports.security.consumeForDispatch(input);
          if (outcome.kind === "consumed") {
            try {const value = entry(input); value.rs = structuredClone(outcome.receipt); await capture(value);} catch { /* Selection remains unavailable. */ }
          }
          return outcome;
        }}),
      });
    },
    take(kernel: Parameters<LinuxCodexContainedTurnResources["select"]>[0]["kernel"]) {
      const value = retained.get(kernel.custodyId);
      if (value === undefined || value.selected || value.head === undefined || value.route === undefined) {return unavailable();}
      const {subject, accepted} = value.input;
      if (kernel.authorityVectorDigest !== accepted.acceptedAuthorityVectorDigest ||
          (["operationId", "attemptId", "custodyId", "effectId", "workspaceId", "preparationToken"] as const)
            .some(key => kernel[key] !== subject[key]) || kernel.adapterSnapshot.provider !== "codex" ||
          !isDeepStrictEqual(kernel.adapterSnapshot, accepted.acceptedAuthorityVector.adapterSnapshot) ||
          !isDeepStrictEqual(kernel.providerAccessSnapshot, accepted.acceptedAuthorityVector.providerAccessSnapshot) ||
          kernel.operationCutoffRevision !== subject.operationCutoffRevision ||
          kernel.providerAccessSnapshot.tenantId !== subject.scope.tenantId ||
          kernel.providerAccessSnapshot.projectId !== subject.scope.projectId) {return unavailable();}
      value.selected = true;
      return Object.freeze({input: structuredClone(value.input), acceptedDispatch: structuredClone(value.head), providerAccessReceipt: structuredClone(value.pa!), runtimeSecurityReceipt: structuredClone(value.rs!), current: value.route, upstream: value.upstream!, binding: value.binding!});
    },
  });
};
