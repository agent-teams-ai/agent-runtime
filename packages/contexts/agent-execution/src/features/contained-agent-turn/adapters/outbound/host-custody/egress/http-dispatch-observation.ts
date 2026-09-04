import type { HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HttpEgressDispatch } from "./http-egress-ports.js";

type FailedWriteEvidence = Pick<HttpEgressReceipt,
  "upstreamRequestBytes" | "firstByteState" | "outcome" | "anomalyCode">;

type DispatchObservation = Readonly<{
  kind: "response";
  upstreamRequestBytes: number;
  response: AsyncIterable<Uint8Array>;
}> | Readonly<{ kind: "failed"; evidence: FailedWriteEvidence }>;

const invalidWrite = (): DispatchObservation => Object.freeze({ kind: "failed", evidence: Object.freeze({
  upstreamRequestBytes: 0, firstByteState: "uncertain", outcome: "reconcile_required", anomalyCode: "upstream_write_failed",
}) });

/** Transport evidence normalization only, not operation state or retry policy. */
export const observeHttpDispatch = (dispatch: HttpEgressDispatch, expectedBytes: number): DispatchObservation => {
  if (dispatch === null || typeof dispatch !== "object"
    || (dispatch.status !== "response" && dispatch.status !== "failed")
    || (dispatch.acknowledgement !== "acknowledged" && dispatch.acknowledgement !== "lost")) {
    return invalidWrite();
  }
  const accepted = dispatch.acceptedRequestBytes;
  if (accepted === "unknown" || !Number.isSafeInteger(accepted) || accepted < 0 || accepted > expectedBytes) {
    return invalidWrite();
  }
  if (dispatch.status === "response" && accepted !== expectedBytes) {
    return Object.freeze({ kind: "failed", evidence: Object.freeze({
      upstreamRequestBytes: accepted, firstByteState: accepted > 0 ? "sent" : "uncertain",
      outcome: "reconcile_required", anomalyCode: "upstream_write_failed",
    }) });
  }
  if (dispatch.acknowledgement === "lost" || dispatch.status === "failed") {
    return Object.freeze({ kind: "failed", evidence: Object.freeze({
      upstreamRequestBytes: accepted, firstByteState: accepted > 0 ? "sent" : "not_sent",
      outcome: accepted > 0 ? "reconcile_required" : "denied",
      anomalyCode: dispatch.acknowledgement === "lost" ? "upstream_ack_lost" : "upstream_write_failed",
    }) });
  }
  return Object.freeze({ kind: "response", upstreamRequestBytes: accepted, response: dispatch.response });
};
