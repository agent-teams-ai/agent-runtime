import type { ContainedTurnEgressDependencies, ContainedTurnEgressRequest, ContainedTurnEgressResult,
  ProviderRouteAuthoritySnapshotV1, TrustedEgressHostIdentityV1 } from "./composition.js";
import { type createEgressValidation, type BufferedRequest, type EgressSecurityPrimitives,
  type PolicyAuthority } from "./validation.js";
import type { EgressOneShotLifecycle } from "./lifecycle.js";
import { createWriteAuthorization } from "./write-authorization.js";
import { deny, sameBytes } from "./results.js";
import { revalidateWrite } from "./revalidate-write.js";
import { signWrite } from "./sign-write.js";
const freeze = Object.freeze;
export type FirstWriteInput = Readonly<{
  owners: ContainedTurnEgressDependencies; request: ContainedTurnEgressRequest;
  route: ProviderRouteAuthoritySnapshotV1; policy: PolicyAuthority; capturedRequest: BufferedRequest;
  identity: TrustedEgressHostIdentityV1; validation: ReturnType<typeof createEgressValidation>;
  lifecycle: EgressOneShotLifecycle; primitives: EgressSecurityPrimitives;
}>;
export const createFirstWriteBoundary = (input: FirstWriteInput) => {
  const {owners, request, route, policy, capturedRequest, validation, lifecycle} = input;
  let boundaryOpen = true; let callbackCount = 0; let writeAttempted = false; let wrote = false; let callbackPending = false;
  let boundaryReceipt: object | undefined; let callbackDenial: Extract<ContainedTurnEgressResult, {status: "denied"}> | undefined;
  let expectedCanonical: Uint8Array | undefined; let writtenCanonical: Uint8Array | undefined;
  let writtenApplication: Uint8Array | undefined;
  const active = () => boundaryOpen && callbackCount === 1 && lifecycle.active;
  const callbacks = new Set<Promise<unknown>>();
  const beforeFirstWrite = (rawObservation: unknown) => {
    callbackCount += 1; callbackPending = true;
    if (!active()) {
      lifecycle.quarantine(); callbackDenial = deny("authorization_invalid"); callbackPending = false;
      return Promise.resolve(freeze({status: "denied" as const}));
    }
    const pending = (async () => {
      const checked = await revalidateWrite(rawObservation, {...input, active});
      if ("status" in checked) {callbackDenial = checked; return freeze({status: "denied" as const});}
      const {body, issuedAt, startedAt} = checked;
      const canonicalBody = validation.canonicalAuthorization(body); const envelope = signWrite(canonicalBody, input);
      if (envelope === undefined) {callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
      if (!active()) {
        callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
      const exposedCanonical = canonicalBody.slice(); const exposedApplication = capturedRequest.applicationBuffer.slice();
      const authorization = freeze({body, canonicalBody: exposedCanonical, envelope});
      const permit = createWriteAuthorization({validation, owner: owners.policyAuthority, route, policy, issuedAt,
        startedAt, deadlineMs: request.budgets.deadlineMs, active});
      try {const returned = lifecycle.writeExact?.(freeze({authorization, applicationBytes: exposedApplication,
        consumeAuthorization: () => {const allowed = permit.consumeAuthorization(); writeAttempted ||= allowed; return allowed;}}));
        if (!permit.consumed && permit.rejected) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
        if (returned !== undefined || !permit.consumed || permit.rejected || !sameBytes(exposedCanonical, canonicalBody) ||
            !sameBytes(exposedApplication, capturedRequest.applicationBuffer)) {lifecycle.quarantine(); callbackDenial = deny("authorization_invalid");
          return freeze({status: "denied" as const});}}
      catch {lifecycle.quarantine(); callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
      if (!active()) {lifecycle.quarantine(); callbackDenial = deny("authorization_invalid");
        return freeze({status: "denied" as const});}
      expectedCanonical = canonicalBody.slice(); writtenCanonical = exposedCanonical; writtenApplication = exposedApplication;
      wrote = true; boundaryReceipt = freeze({}); return freeze({status: "written" as const, boundaryReceipt});
    })();
    callbacks.add(pending);
    const settled = () => {callbackPending = false; callbacks.delete(pending);};
    void pending.then(settled, settled); return pending;
  };

  return {beforeFirstWrite, get callbackPending() {return callbackPending;},
  async finish() {boundaryOpen = false; await Promise.allSettled(callbacks);},
  get writeAttempted() {return writeAttempted;}, get callbackDenial() {return callbackDenial;},
  matches(receipt: unknown) {return callbackCount === 1 && callbackDenial === undefined && wrote &&
    writtenCanonical !== undefined && writtenApplication !== undefined && expectedCanonical !== undefined &&
    sameBytes(writtenCanonical, expectedCanonical) && sameBytes(writtenApplication, capturedRequest.applicationBuffer) &&
    receipt === boundaryReceipt;},
  };
};
