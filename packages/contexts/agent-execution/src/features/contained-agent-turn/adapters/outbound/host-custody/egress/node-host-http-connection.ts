import { Socket } from "node:net";
import type { HttpEgressClock } from "./http-egress-ports.js";
import { NodeHostHttpConnectionCustody } from "./node-host-http-connection-custody.js";
import { fixNodeHostHttpConnectionConfig, NodeHostHttpConnectionError } from "./node-host-http-connection-config.js";
import type { HttpEgressExpectedRequest, HttpEgressLimits } from "./http-egress-contracts.js";

/**
 * Inert, private adapter configuration. Binding is an explicit post-claim effect.
 * Transport alone confers NO ingress, route or credential authority. A future
 * listener must authenticate ingress, bind the exact owner and use this SAME
 * cutoff signal for the broker/upstream. No capability is stripped here; bytes
 * and counts remain raw. There is no listener, activation or feature export.
 *
 * The accepted socket must be pristine, binary, paused and allowHalfOpen, with
 * both HWM values <= the configured caps. This adapter never creates a socket.
 */
export const createNodeHostHttpConnection = (input: Readonly<{
  expectedRequest: HttpEgressExpectedRequest;
  limits: HttpEgressLimits;
  maxHeaderFields?: number;
  readHighWaterMark?: number;
  writeHighWaterMark?: number;
  headerTimeoutMs?: number;
  closeTimeoutMs?: number;
}>, clock: HttpEgressClock) => {
  const config = fixNodeHostHttpConnectionConfig(input);
  return Object.freeze({
    bindAcceptedSocket(socket: Socket, cutoff: AbortController) {
      if (!(socket instanceof Socket)) {throw new NodeHostHttpConnectionError("invalid_socket");}
      const owner = new NodeHostHttpConnectionCustody(config, clock, cutoff);
      return owner.bind(socket);
    },
  });
};
