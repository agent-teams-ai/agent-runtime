import { checkServerIdentity, connect, type ConnectionOptions } from "node:tls";

import type { HttpEgressTransportAttempt, HttpEgressUpstreamTransport } from "./http-egress-ports.js";
import {
  NodeTlsHttpEgressAttempt,
  type NodeTlsHttpEgressConnector,
  type OwnedNodeTlsSocket,
} from "./node-tls-http-egress-transport-attempt.js";
import {
  canonicalLiteralAddress,
  canonicalSni,
  fixLimits,
  fixTrust,
  NodeTlsHttpEgressError,
  type NodeTlsTrustInput,
} from "./node-tls-http-egress-transport-support.js";

export type NodeTlsHttpEgressTransportOptions = Readonly<{
  certificateAuthorities: readonly NodeTlsTrustInput[];
  connectTimeoutMs?: number;
  responseIdleTimeoutMs?: number;
  closeTimeoutMs?: number;
}>;

const DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  responseIdleTimeoutMs: 30_000,
  closeTimeoutMs: 2_000,
});

const productionConnector: NodeTlsHttpEgressConnector = (options: ConnectionOptions): OwnedNodeTlsSocket => connect(options);

/**
 * One-shot HTTP/1.1 TLS transport for a previously resolved literal peer.
 *
 * Trust and all resource bounds are snapshotted by construction. This adapter
 * intentionally has no DNS, retry, redirect, pooling, proxy, HTTP/2, HTTP/3 or
 * session-resumption facility.
 */
export class NodeTlsHttpEgressTransport implements HttpEgressUpstreamTransport {
  readonly #trust;
  readonly #limits;
  readonly #connector: NodeTlsHttpEgressConnector;

  public constructor(options: NodeTlsHttpEgressTransportOptions, connector: NodeTlsHttpEgressConnector = productionConnector) {
    this.#trust = fixTrust(options.certificateAuthorities);
    this.#limits = fixLimits({
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      responseIdleTimeoutMs: options.responseIdleTimeoutMs ?? DEFAULTS.responseIdleTimeoutMs,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULTS.closeTimeoutMs,
    });
    this.#connector = connector;
  }

  public beginOpen(input: Readonly<{
    originHost: string;
    originPort: number;
    selectedAddress: string;
    sni: string;
    alpn: "http/1.1";
  }>): HttpEgressTransportAttempt {
    const selectedAddress = canonicalLiteralAddress(input.selectedAddress);
    const sni = canonicalSni(input.sni);
    if (selectedAddress === undefined || sni === undefined
      || !Number.isSafeInteger(input.originPort) || input.originPort < 1 || input.originPort > 65_535
      || input.alpn !== "http/1.1") {
      throw new NodeTlsHttpEgressError("invalid_target");
    }
    return new NodeTlsHttpEgressAttempt({
      selectedAddress,
      originPort: input.originPort,
      sni,
      trust: this.#trust,
      limits: this.#limits,
      connector: this.#connector,
      checkServerIdentity,
    });
  }
}

export { NodeTlsHttpEgressError } from "./node-tls-http-egress-transport-support.js";
