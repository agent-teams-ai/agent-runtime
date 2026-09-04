import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { createEgressFixture, outputText, SECRET_MARKER } from "./http-egress-test-fixture.ts";

describe("strict Host HTTP/1.1 request boundary", () => {
  test("forwards fragmented input to the fixed manifest route and streams SSE with backpressure", async () => {
    const request = "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nAuthorization: child-secret\r\nProxy-Authorization: proxy-secret\r\nX-Api-Key: child-key\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
    const fixture = createEgressFixture({
      request: [...request].map(character => character),
      response: [
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        "5\r\nda", "ta:\r\n", "2\r\n\n\n\r\n", "0\r\n\r\n",
      ],
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);

    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.anomalyCode, "none");
    assert.equal(receipt.attemptCount, 1);
    assert.equal(receipt.firstByteState, "sent");
    assert.equal(receipt.inboundClosure, "closed");
    assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(outputText(fixture), "HTTP/1.1 200 Upstream\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata:\n\n");
    const outbound = new TextDecoder().decode(fixture.observations.dispatchedRequests[0]);
    assert.match(outbound, /^POST \/fixed-provider-route HTTP\/1\.1\r\n/);
    assert.match(outbound, /Host: provider\.example\r\n/);
    assert.match(outbound, new RegExp(`authorization: Bearer ${SECRET_MARKER}\\r\\n`));
    assert.match(outbound, /Content-Length: 2\r\n\r\n\{\}$/);
    assert.doesNotMatch(outbound, /Connection:/i);
    assert.doesNotMatch(outbound, /child-secret|proxy-secret|child-key|keep-alive/);
    assert.deepEqual(fixture.observations.order.slice(0, 9), [
      "authorize-materialization",
      "render-credential",
      "observe-materialization",
      "provisional",
      "resolve",
      "open",
      "observe-materialization",
      "final",
      "dispatch",
    ]);
    const serializedReceipt = JSON.stringify(receipt);
    assert.doesNotMatch(serializedReceipt, /synthetic-secret|child-secret|proxy-secret|child-key|fixed-provider-route|invoke|data:/);
  });

  const rejected: readonly Readonly<{ name: string; request: string; anomaly?: string }>[] = [
    { name: "missing Content-Length", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\n\r\n" },
    { name: "duplicate equal Content-Length", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n" },
    { name: "duplicate conflicting Content-Length", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\nX" },
    { name: "Transfer-Encoding", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n0\r\n\r\n" },
    { name: "Trailer", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nTrailer: X-Foo\r\nContent-Length: 0\r\n\r\n" },
    { name: "Expect", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n" },
    { name: "Upgrade", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nUpgrade: websocket\r\nContent-Length: 0\r\n\r\n" },
    { name: "CONNECT", request: "CONNECT broker.invalid:443 HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n" },
    { name: "absolute form", request: "POST https://provider.example/x HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n" },
    { name: "authority form", request: "POST provider.example:443 HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n" },
    { name: "asterisk form", request: "POST * HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n" },
    { name: "pipelining", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\nGET / HTTP/1.1\r\n\r\n" },
    { name: "obs-fold", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\n X-Folded: yes\r\nContent-Length: 0\r\n\r\n" },
    { name: "duplicate Host", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n" },
    { name: "duplicate Authorization", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nAuthorization: a\r\nAuthorization: b\r\nContent-Length: 0\r\n\r\n" },
    { name: "duplicate Connection", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nConnection: close\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n" },
    { name: "comma Content-Length", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0, 0\r\n\r\n" },
    { name: "signed Content-Length", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: +0\r\n\r\n" },
    { name: "truncated body", request: "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 2\r\n\r\nX", anomaly: "inbound_malformed" },
  ];

  for (const scenario of rejected) {
    test(`rejects ${scenario.name} with zero upstream attempts`, async () => {
      const fixture = createEgressFixture({ request: [scenario.request] });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.outcome, "rejected");
      assert.equal(receipt.anomalyCode, scenario.anomaly ?? "inbound_smuggling");
      assert.equal(receipt.attemptCount, 0);
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(fixture.observations.opens, 0);
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  const mismatches = [
    "GET /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n",
    "POST /other HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n",
    "POST /invoke?destination=evil HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 0\r\n\r\n",
    "POST /invoke HTTP/1.1\r\nHost: provider.example\r\nContent-Length: 0\r\n\r\n",
  ] as const;

  for (const request of mismatches) {
    test("rejects an inbound route mismatch before Provider Access observation", async () => {
      const fixture = createEgressFixture({ request: [request] });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, request.includes("?") ? "inbound_smuggling" : "inbound_route_mismatch");
      assert.equal(fixture.observations.order[0], "inbound-close");
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  test("rejects bounded headers and bodies before route observation", async () => {
    const headerFixture = createEgressFixture({
      request: [`POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nX-Large: ${"a".repeat(2_100)}\r\nContent-Length: 0\r\n\r\n`],
    });
    const headerReceipt = await createStrictHttpEgressBroker(headerFixture.ports).execute(headerFixture.operation);
    assert.equal(headerReceipt.anomalyCode, "inbound_headers_oversized");

    const bodyFixture = createEgressFixture({
      request: [`POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 1025\r\n\r\n${"x".repeat(1025)}`],
    });
    const bodyReceipt = await createStrictHttpEgressBroker(bodyFixture.ports).execute(bodyFixture.operation);
    assert.equal(bodyReceipt.anomalyCode, "inbound_body_oversized");
    assert.equal(headerFixture.observations.dispatches + bodyFixture.observations.dispatches, 0);
  });
});
