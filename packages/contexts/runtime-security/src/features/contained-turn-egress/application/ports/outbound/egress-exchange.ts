import type { BufferedEgressRequestV1, EgressAuthorizationBodyV1, EgressAuthorizationEnvelopeV1 } from
  "../../../domain/egress-authorization.js";

export interface TrustedEgressFirstWriteV1 {
  writeExact(input: Readonly<{authorization: Readonly<{body: EgressAuthorizationBodyV1; canonicalBody: Uint8Array;
    envelope: EgressAuthorizationEnvelopeV1}>; applicationBytes: Uint8Array;
    /** Consume once immediately adjacent to emission, with no intervening await or owner callback.
     * A false result forbids all application bytes. */
    consumeAuthorization(): boolean}>): void;
}
export interface EgressTransportV1 {
  execute(input: Readonly<{target: Readonly<{scheme: "https"; host: string; port: 443;
      tlsServerName: string; path: string}>; request: BufferedEgressRequestV1; responseByteLimit: number;
    deadlineMs: number; beforeFirstWrite(observation: unknown): Promise<Readonly<{status: "written";
      boundaryReceipt: object}> | Readonly<{status: "denied"}>>}>): PromiseLike<unknown>;
  close(): PromiseLike<void>;
}
export interface EgressTransportGatewayV1 { openOneShotHttps(): PromiseLike<unknown> }
