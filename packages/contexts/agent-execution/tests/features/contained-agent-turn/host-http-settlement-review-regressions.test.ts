import assert from "node:assert/strict";
import {test} from "node:test";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {createEgressFixture, outputText, SECRET_MARKER} from "./http-egress-test-fixture.ts";

for (const [framing, response] of [
  ["fixed", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nxy"],
  ["chunked", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n1\r\ny\r\n0\r\n\r\n"],
] as const) {
  test(`enforces the final one-byte response grant for ${framing} forwarding`, async () => {
    const fixture = createEgressFixture({response: [response], mutateProvisional: value => Object.freeze({...value,
      policy: Object.freeze({...value.policy, limits: Object.freeze({...value.policy.limits, responseBytes: 1})})})});
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "output_oversized");
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(fixture.observations.finalAuthorizationInputs[0].provisional.policy.limits.responseBytes, 1);
    assert.equal(fixture.operation.limits.maxOutputBytes, 4096);
    assert.equal(outputText(fixture).split("\r\n\r\n")[1] ?? "", framing === "fixed" ? "" : "x");
    assert.equal(receipt.attemptCount, 1);
    assert.equal(fixture.observations.dispatches, 1);
    assert.equal(fixture.observations.receipts.length, 1);
    assert.equal(receipt.upstreamClosure, "closed");
    assert.equal(receipt.inboundClosure, "closed");
  });
}

test("a throwing beginOpen retains claimed upstream custody uncertainty", async () => {
  const fixture = createEgressFixture(); let opens = 0;
  const ports = {...fixture.ports, transport: {beginOpen: () => {
    opens += 1; throw new Error(SECRET_MARKER);
  }}};
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "reconcile_required");
  assert.equal(receipt.anomalyCode, "closure_unproved");
  assert.equal(receipt.attemptCount, 1);
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(receipt.upstreamClosure, "unknown");
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(opens, 1);
  assert.equal(fixture.observations.dispatches, 0);
  assert.equal(fixture.observations.receipts.length, 1);
  assert.deepEqual(fixture.observations.receipts[0], receipt);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(SECRET_MARKER));
});

for (const failure of ["exhausted", "throw", "pending"] as const) {
  test(`initiates inbound cleanup when upstream close is ${failure}`, {timeout: 1000}, async () => {
    const fixture = createEgressFixture(); let now = 0; let upstreamCloses = 0; let inboundCloses = 0;
    let rejectLate: ((error: Error) => void) | undefined;
    const ports = {...fixture.ports, clock: {now: () => now,
      within: async <T>(deadline: number, operation: () => Promise<T>): Promise<T> => {
        if (now >= deadline) {throw new Error("synthetic deadline");}
        const pending = operation();
        if (now >= deadline) {void pending.catch(() => {}); throw new Error("synthetic deadline");}
        return await pending;
      }}, transport: {beginOpen: (input: Parameters<typeof fixture.ports.transport.beginOpen>[0]) => {
        const attempt = fixture.ports.transport.beginOpen(input);
        return {...attempt, close: () => {
          upstreamCloses += 1; now = fixture.operation.limits.closureDeadline;
          if (failure === "throw") {throw new Error(SECRET_MARKER);}
          if (failure === "pending") {return new Promise<Awaited<ReturnType<typeof attempt.close>>>((_resolve, reject) => {
            rejectLate = reject;
          });}
          return Promise.resolve({state: "closed" as const, receiptDigest: "upstream-closure-digest"});
        }};
      }}};
    const operation = {...fixture.operation, connection: {...fixture.operation.connection, close: async () => {
      inboundCloses += 1;
      return {state: "closed" as const, receiptDigest: "inbound-closure-digest"};
    }}};
    const receipt = await createStrictHttpEgressBroker(ports).execute(operation);
    assert.equal(upstreamCloses, 1);
    assert.equal(inboundCloses, 1);
    assert.equal(receipt.upstreamClosure, "unknown");
    assert.equal(receipt.inboundClosure, "unknown");
    assert.equal(receipt.outcome, "reconcile_required");
    assert.equal(receipt.anomalyCode, "evidence_ack_lost");
    assert.equal(fixture.observations.opens, 1);
    assert.equal(fixture.observations.dispatches, 1);
    assert.equal(fixture.observations.receipts.length, 0);
    rejectLate?.(new Error(SECRET_MARKER));
    await new Promise(resolve => {setImmediate(resolve);});
    assert.equal(receipt.upstreamClosure, "unknown");
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(SECRET_MARKER));
  });
}

test("bounds a hanging upstream acknowledgement while independently acknowledging inbound", {timeout: 1000}, async () => {
  const fixture = createEgressFixture({upstreamCloseNever: true}); let now = 0;
  const ports = {...fixture.ports, clock: {now: () => now,
    within: async <T>(deadline: number, operation: () => Promise<T>): Promise<T> => {
      if (now >= deadline) {throw new Error("synthetic deadline");}
      if (deadline !== fixture.operation.limits.closureDeadline) {return await operation();}
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {now = deadline; reject(new Error("synthetic deadline"));}, 10);
      })]);} finally {clearTimeout(timer);}
    }}};
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(fixture.observations.order.filter(value => value === "inbound-close").length, 1);
  assert.equal(fixture.observations.closes, 1);
  assert.equal(receipt.inboundClosure, "closed");
  assert.equal(receipt.upstreamClosure, "unknown");
  assert.equal(receipt.outcome, "reconcile_required");
  assert.equal(receipt.anomalyCode, "evidence_ack_lost");
  assert.equal(fixture.observations.dispatches, 1);
});
