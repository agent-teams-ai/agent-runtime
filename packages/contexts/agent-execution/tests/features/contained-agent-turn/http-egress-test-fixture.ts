import { createHash } from "node:crypto";
import type {
  HttpEgressAuthorizationDecision,
  HttpEgressBrokerPorts,
  HttpEgressDispatch,
  HttpEgressFinalAuthorization,
  HttpEgressFinalAuthorizationDecision,
  HttpEgressGenerationObservation,
  HttpEgressRoute,
  HttpEgressTransportBinding,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import type {
  HttpEgressConnection,
  HttpEgressLimits,
  HttpEgressOperation,
  HttpEgressReceipt,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-contracts.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SECRET_MARKER = "synthetic-secret-never-observe";

export const bytes = (value: string): Uint8Array => encoder.encode(value);

export async function* chunks(values: readonly (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const value of values) {yield typeof value === "string" ? bytes(value) : value;}
}

const defaultRequest = "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
const defaultResponse = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\ndata:\r\n2\r\n\n\n\r\n0\r\n\r\n";

const defaultLimits: HttpEgressLimits = Object.freeze({
  maxInboundHeaderBytes: 2_048,
  maxInboundBodyBytes: 1_024,
  maxUpstreamHeaderBytes: 2_048,
  maxOutputBytes: 4_096,
  maxBufferedBytes: 128,
  maxUpstreamWireBytes: 8_192,
  deadline: 1_000,
  closureDeadline: 1_100,
});

export const defaultRoute: HttpEgressRoute = Object.freeze({
  routeReceiptDigest: "route-receipt-digest",
  materializationReceiptDigest: "materialization-receipt-digest",
  originHost: "provider.example",
  originPort: 443,
  upstreamMethod: "POST",
  upstreamPath: "/fixed-provider-route",
  sni: "provider.example",
  sniDigest: "sni-digest",
  certificateDigest: "certificate-digest",
  pinDigest: "pin-digest",
  alpn: "http/1.1",
  policyGeneration: "policy-generation-7",
  keyGeneration: "key-generation-3",
  routeGeneration: "route-generation-11",
  credentialGeneration: "credential-generation-5",
  forwardedRequestHeaderNames: Object.freeze(["accept", "content-type"]),
});

const defaultBinding: HttpEgressTransportBinding = Object.freeze({
  peerAddress: "93.184.216.34",
  peerPort: 443,
  tlsProtocol: "TLSv1.3",
  sni: "provider.example",
  sniDigest: "sni-digest",
  certificateDigest: "certificate-digest",
  pinDigest: "pin-digest",
  alpn: "http/1.1",
});

const decision = (route: HttpEgressRoute, receiptDigest: string): HttpEgressAuthorizationDecision => Object.freeze({
  decision: "allow",
  receiptDigest,
  validUntil: 900,
  policyGeneration: route.policyGeneration,
  keyGeneration: route.keyGeneration,
  routeGeneration: route.routeGeneration,
  credentialGeneration: route.credentialGeneration,
  materializationReceiptDigest: route.materializationReceiptDigest,
});

export type FixtureOptions = Readonly<{
  request?: readonly (string | Uint8Array)[];
  response?: readonly (string | Uint8Array)[];
  responseSource?: AsyncIterable<Uint8Array>;
  route?: HttpEgressRoute;
  binding?: Partial<HttpEgressTransportBinding>;
  bindingAtFirstByte?: Partial<HttpEgressTransportBinding>;
  provisional?: HttpEgressAuthorizationDecision | "timeout";
  final?: HttpEgressAuthorizationDecision | HttpEgressFinalAuthorizationDecision | "timeout"
    | ((input: HttpEgressFinalAuthorization) => HttpEgressFinalAuthorizationDecision);
  generation?: HttpEgressGenerationObservation;
  generationAtFirstByte?: HttpEgressGenerationObservation;
  addresses?: readonly string[];
  selectedAddress?: string;
  dispatch?: HttpEgressDispatch | "throw";
  openThrows?: boolean;
  openReady?: Promise<void>;
  renderThrows?: boolean;
  connectionWriteThrows?: boolean;
  inboundClosure?: "closed" | "unknown";
  upstreamClosure?: "closed" | "unknown";
  upstreamCloseThrows?: boolean;
  upstreamCloseNever?: boolean;
  evidence?: "recorded" | "conflict" | "unknown" | "throw";
  abortOnDispatch?: AbortController;
  signal?: AbortSignal;
  deadlineNow?: number;
}>;

export type EgressFixture = Readonly<{
  ports: HttpEgressBrokerPorts;
  operation: HttpEgressOperation;
  observations: {
    readonly order: string[];
    readonly outboundWrites: Uint8Array[];
    readonly dispatchedRequests: Uint8Array[];
    readonly receipts: HttpEgressReceipt[];
    readonly finalAuthorizationInputs: HttpEgressFinalAuthorization[];
    dispatches: number;
    opens: number;
    renders: number;
    closes: number;
  };
}>;

const fixtureTransport = (
  options: FixtureOptions,
  binding: HttpEgressTransportBinding,
  observations: EgressFixture["observations"],
  defaultDispatch: HttpEgressDispatch,
): HttpEgressBrokerPorts["transport"] => Object.freeze({
  beginOpen: () => {
    observations.order.push("open");
    observations.opens += 1;
    let firstByte = false;
    let closed = false;
    let closeResult: Promise<Readonly<{ state: "closed" | "unknown"; receiptDigest: string }>> | undefined;
    const session = Object.freeze({
      get binding(): HttpEgressTransportBinding {
        return firstByte ? Object.freeze({ ...binding, ...options.bindingAtFirstByte }) : binding;
      },
      dispatch: async (consume: () => Uint8Array | undefined) => {
        observations.order.push("dispatch");
        if (closed) {return Object.freeze({
          status: "failed" as const, acceptedRequestBytes: 0, acknowledgement: "acknowledged" as const,
        });}
        firstByte = true;
        const wireRequest = consume();
        if (wireRequest === undefined) {return Object.freeze({
          status: "failed" as const, acceptedRequestBytes: 0, acknowledgement: "acknowledged" as const,
        });}
        observations.dispatches += 1;
        observations.dispatchedRequests.push(wireRequest.slice());
        options.abortOnDispatch?.abort();
        if (options.dispatch === "throw") {throw new Error("synthetic dispatch crash");}
        return options.dispatch ?? Object.freeze({ ...defaultDispatch, acceptedRequestBytes: wireRequest.byteLength });
      },
    });
    return Object.freeze({
      ready: async () => {
        await options.openReady;
        if (options.openThrows) {throw new Error("synthetic open failure");}
        if (closed) {throw new Error("synthetic attempt closed before ready");}
        return session;
      },
      close: () => {
        if (closeResult !== undefined) {return closeResult;}
        closeResult = (async () => {
          closed = true;
          observations.order.push("upstream-close");
          observations.closes += 1;
          if (options.upstreamCloseThrows) {throw new Error("synthetic close failure");}
          if (options.upstreamCloseNever) {return await new Promise<never>(() => {});}
          return Object.freeze({
            state: options.upstreamClosure ?? "closed", receiptDigest: "upstream-closure-digest",
          });
        })();
        return closeResult;
      },
    });
  },
});

export const createEgressFixture = (options: FixtureOptions = {}): EgressFixture => {
  const route = options.route ?? defaultRoute;
  const binding = Object.freeze({ ...defaultBinding, ...options.binding });
  const responseSource = options.response ?? [defaultResponse];
  const observations = {
    order: [] as string[],
    outboundWrites: [] as Uint8Array[],
    dispatchedRequests: [] as Uint8Array[],
    receipts: [] as HttpEgressReceipt[],
    finalAuthorizationInputs: [] as HttpEgressFinalAuthorization[],
    dispatches: 0,
    opens: 0,
    renders: 0,
    closes: 0,
  };
  let credentialUsed = false;
  const provisional = options.provisional ?? decision(route, "provisional-receipt-digest");
  const baseFinal = decision(route, "final-receipt-digest");
  const final = options.final;
  const defaultDispatch: HttpEgressDispatch = Object.freeze({
    status: "response",
    acceptedRequestBytes: 1,
    acknowledgement: "acknowledged",
    response: options.responseSource ?? chunks(responseSource),
  });
  const ports: HttpEgressBrokerPorts = Object.freeze({
    resolver: Object.freeze({
      resolve: async () => {
        observations.order.push("resolve");
        const selectedAddress = options.selectedAddress ?? "93.184.216.34";
        return Object.freeze({ addresses: Object.freeze([...(options.addresses ?? [selectedAddress])]), selectedAddress });
      },
    }),
    transport: fixtureTransport(options, binding, observations, defaultDispatch),
    provisionalAuthorization: Object.freeze({
      authorize: async () => {
        observations.order.push("provisional");
        if (provisional === "timeout") {throw new Error("synthetic timeout");}
        return provisional;
      },
    }),
    finalAuthorization: Object.freeze({
      authorize: async (input: HttpEgressFinalAuthorization) => {
        observations.order.push("final");
        observations.finalAuthorizationInputs.push(input);
        if (final === "timeout") {throw new Error("synthetic timeout");}
        if (typeof final === "function") {return final(input);}
        if (final !== undefined) {
          return Object.freeze({ ...final,
            bindingDigest: "bindingDigest" in final ? final.bindingDigest : "stale-binding-digest",
          });
        }
        return Object.freeze({ ...baseFinal, bindingDigest: input.bindingDigest });
      },
    }),
    routeAuthority: Object.freeze({
      observe: async () => {
        observations.order.push("observe-route");
        return Object.freeze({ status: "available" as const, route });
      },
      revalidate: async () => {
        observations.order.push("revalidate-route");
        return options.generation ?? currentGeneration(route);
      },
      revalidateAtFirstByte: () => options.generationAtFirstByte ?? currentGeneration(route),
    }),
    credentialCustody: Object.freeze({
      renderAuthorization: async () => {
        observations.order.push("render-credential");
        observations.renders += 1;
        if (options.renderThrows || credentialUsed) {throw new Error("synthetic credential failure");}
        credentialUsed = true;
        return bytes(`Bearer ${SECRET_MARKER}`);
      },
    }),
    clock: Object.freeze({
      now: () => options.deadlineNow ?? 0,
      within: async <T>(_deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        signal?.throwIfAborted();
        return await operation();
      },
    }),
    evidence: Object.freeze({
      digest: (parts: readonly Uint8Array[]) => {
        const hash = createHash("sha256");
        for (const part of parts) {hash.update(part);}
        return hash.digest("hex");
      },
      record: async (receipt: HttpEgressReceipt) => {
        observations.order.push("record-evidence");
        observations.receipts.push(receipt);
        if (options.evidence === "throw") {throw new Error("synthetic lost ack");}
        return options.evidence ?? "recorded";
      },
    }),
  });
  const connection: HttpEgressConnection = Object.freeze({
    request: chunks(options.request ?? [defaultRequest]),
    write: async (value: Uint8Array) => {
      observations.order.push("write-output");
      if (options.connectionWriteThrows) {throw new Error("synthetic backpressure failure");}
      observations.outboundWrites.push(value.slice());
    },
    close: async () => {
      observations.order.push("inbound-close");
      return Object.freeze({ state: options.inboundClosure ?? "closed", receiptDigest: "inbound-closure-digest" });
    },
  });
  const operation: HttpEgressOperation = Object.freeze({
    operationId: "operation-egress-1",
    attemptId: "attempt-egress-1",
    expectedRequest: Object.freeze({ requestId: "request-egress-1", method: "POST", path: "/invoke", host: "broker.invalid" }),
    connection,
    limits: defaultLimits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return Object.freeze({ ports, operation, observations });
};

const currentGeneration = (route: HttpEgressRoute): HttpEgressGenerationObservation => Object.freeze({
  status: "current", policyGeneration: route.policyGeneration,
  keyGeneration: route.keyGeneration, routeGeneration: route.routeGeneration,
  credentialGeneration: route.credentialGeneration,
  materializationReceiptDigest: route.materializationReceiptDigest,
});

export const outputText = (fixture: EgressFixture): string => decoder.decode(
  fixture.observations.outboundWrites.reduce((all, part) => {
    const joined = new Uint8Array(all.byteLength + part.byteLength);
    joined.set(all);
    joined.set(part, all.byteLength);
    return joined;
  }, new Uint8Array()),
);

export const denyDecision = (route: HttpEgressRoute, receiptDigest: string): HttpEgressAuthorizationDecision => Object.freeze({
  ...decision(route, receiptDigest),
  decision: "deny",
});
