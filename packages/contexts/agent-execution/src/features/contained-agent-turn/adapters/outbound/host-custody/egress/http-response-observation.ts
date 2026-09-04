import type { HttpEgressAnomalyCode, HttpEgressOperation, HttpEgressReceipt } from "./http-egress-contracts.js";
import type { HttpEgressClock } from "./http-egress-ports.js";
import { forwardStrictHttpResponse, StrictHttpResponseError } from "./strict-http-response.js";

type ResponseEvidence = Pick<HttpEgressReceipt, "upstreamResponseBytes" | "outboundResponseBytes"
  | "outboundResponseWriteUncertain" | "outcome" | "anomalyCode">;

const responseErrorCode = (error: StrictHttpResponseError): HttpEgressAnomalyCode => ({
  cancelled: "inbound_cancelled", stalled: "upstream_stalled", malformed: "upstream_malformed",
  truncated: "upstream_truncated", oversized: "output_oversized", backpressure: "output_backpressure_failed",
  redirect: "redirect_rejected",
})[error.kind] as HttpEgressAnomalyCode;

const responseAnomaly = (status: number): HttpEgressAnomalyCode => {
  if (status === 401 || status === 403) {return "upstream_auth_rejected";}
  if (status === 429) {return "upstream_rate_limited";}
  if (status >= 500) {return "upstream_server_error";}
  return "none";
};

export const observeHttpResponse = async (
  source: AsyncIterable<Uint8Array>,
  operation: HttpEgressOperation,
  clock: HttpEgressClock,
): Promise<ResponseEvidence> => {
  try {
    const response = await forwardStrictHttpResponse(source, operation.connection, operation.limits, clock, operation.signal);
    return Object.freeze({
      upstreamResponseBytes: response.upstreamBytes, outboundResponseBytes: response.outboundBytes,
      outboundResponseWriteUncertain: false, outcome: "completed", anomalyCode: responseAnomaly(response.status),
    });
  } catch (error) {
    if (!(error instanceof StrictHttpResponseError)) {throw error;}
    return Object.freeze({
      upstreamResponseBytes: error.upstreamBytes, outboundResponseBytes: error.outboundBytes,
      outboundResponseWriteUncertain: error.outboundWriteUncertain,
      outcome: error.kind === "redirect" ? "denied" : "reconcile_required", anomalyCode: responseErrorCode(error),
    });
  }
};
