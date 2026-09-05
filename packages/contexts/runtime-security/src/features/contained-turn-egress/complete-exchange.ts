import type { ContainedTurnEgressResult } from "./composition.js";
import type { BufferedRequest, TransportResult } from "./validation.js";
import type { EgressOneShotLifecycle } from "./lifecycle.js";
import type { createFirstWriteBoundary } from "./first-write.js";
import { deny, uncertain } from "./results.js";
const freeze = Object.freeze;
export const completeExchange = (input: Readonly<{
  result: TransportResult | undefined; closed: boolean; interrupted: boolean; returnedWhilePending: boolean;
  lifecycle: EgressOneShotLifecycle; boundary: ReturnType<typeof createFirstWriteBoundary>; capturedRequest: BufferedRequest;
}>): ContainedTurnEgressResult => {
  const {result, closed, interrupted, returnedWhilePending, lifecycle, boundary, capturedRequest} = input;
  const request = capturedRequest.request;
  if (!closed) {return uncertain("close_failed");}
  if (lifecycle.quarantined) {return uncertain("first_write_indeterminate");}
  if (interrupted && !boundary.writeAttempted && boundary.callbackDenial !== undefined) {return boundary.callbackDenial;}
  if (result === undefined) {if (boundary.writeAttempted) {lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
    return uncertain("response_invalid");}
  if (result.status === "write_indeterminate") {lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
  if (result.status === "not_sent") {if (boundary.writeAttempted) {lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
    lifecycle.markUsed(); return boundary.callbackDenial ?? deny("transport_denied");}
  if (interrupted || returnedWhilePending || !boundary.matches(result.boundaryReceipt)) {
    lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
  lifecycle.markUsed(); if (result.responseBytes > request.budgets.responseBytes) {return uncertain("response_invalid");}
  return freeze({status: "completed", responseDigest: result.responseDigest, responseBytes: result.responseBytes,
    applicationBytesDigest: capturedRequest.applicationBytesDigest, applicationBytesWritten: capturedRequest.applicationBytes});
};
