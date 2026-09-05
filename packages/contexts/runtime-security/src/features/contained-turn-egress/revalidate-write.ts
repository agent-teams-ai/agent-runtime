import type { FirstWriteInput } from "./first-write.js";
import { frozenExact } from "./write-authorization.js";
import { monotonicNow } from "./node-boundary.js";
import { authorizationBody } from "./authorization-evidence.js";
import { deny } from "./results.js";
const currentIssuedAt = (timed: Readonly<Record<string, unknown>> | undefined, observedAt: number) =>
  timed?.status === "current" && Number.isSafeInteger(timed.observedAt) &&
    (timed.observedAt as number) >= observedAt ? timed.observedAt as number : undefined;
export const revalidateWrite = async (rawObservation: unknown, input: FirstWriteInput & Readonly<{active(): boolean}>) => {
  const {validation, owners, route, policy, request, capturedRequest, lifecycle, identity} = input;
  const observation = validation.snapshotObservation(rawObservation);
  if (observation === undefined) {return deny("address_denied");}
  if (observation.resolutionAuthorityId !== route.resolutionAuthorityId ||
      observation.resolutionGeneration !== route.resolutionGeneration || observation.tlsServerName !== route.tlsServerName ||
      observation.peerPort !== route.port || !route.allowedTlsSpkiDigests.includes(observation.tlsSpkiDigest)) {
    return deny("tls_peer_mismatch");
  }
  if (observation.applicationBytesDigest !== capturedRequest.applicationBytesDigest ||
      observation.applicationBytes !== capturedRequest.applicationBytes) {
    return deny("authorization_invalid");
  }
  let receipt; let timed; let routeCurrent = false; const startedAt = monotonicNow();
  try {
    receipt = validation.committedReceipt(await lifecycle.owner(() => owners.dispatchAuthority.observeDispatchConsumption(request.dispatch)), request.dispatch);
    timed = frozenExact(validation, await lifecycle.owner(() => owners.policyAuthority.revalidateExact(policy)), ["status", "observedAt"]);
    routeCurrent = frozenExact(validation, await lifecycle.owner(() => owners.routeAuthority.revalidateExact(route)), ["status"])?.status === "current";
  } catch {return deny("authority_unavailable");}
  if (!input.active()) {return deny("authorization_invalid");}
  if (receipt === undefined) {return deny("dispatch_not_committed");}
  if (!routeCurrent) {return deny("authority_drift");}
  const issuedAt = currentIssuedAt(timed, policy.observedAt);
  if (issuedAt === undefined) {return deny("authority_drift");}
  if (issuedAt >= policy.expiresAt || issuedAt - policy.observedAt > request.budgets.deadlineMs) {
    return deny("expired");}
  const body = authorizationBody({route, request, receipt, identity, policy, issuedAt,
    capturedRequest, observation});
  return {body, issuedAt, startedAt};
};
