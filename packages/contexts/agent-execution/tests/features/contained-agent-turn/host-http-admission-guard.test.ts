import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createHostHttpAdmissionGuard,
  type HostHttpAdmissionGuard,
  type HostHttpAdmissionLease,
} from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-admission-guard.ts";

const reservation = () => ({
  operationId: "operation-1",
  attemptId: "attempt-1",
  custodyId: "custody-1",
  hostGeneration: "host-generation-1",
  liveProcessSessionIdentity: Object.freeze({}),
});

const completeSuccess = () => ({
  response: "observed_policy_accepted" as const,
  delivery: "delivered" as const,
  upstreamClosure: "closed" as const,
  inboundClosure: "closed" as const,
  evidenceAcknowledgement: "acknowledged" as const,
});

const acquired = (guard: HostHttpAdmissionGuard): HostHttpAdmissionLease => {
  const lease = guard.acquire();
  assert.ok(lease);
  return lease;
};

describe("Host-private monotonic HTTP admission", () => {
  test("has one synchronous winner and denies reentrant or concurrent acquisition", () => {
    const guard = createHostHttpAdmissionGuard(reservation());
    const results = Array.from({length: 32}, () => guard.acquire());
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(guard.snapshot(), {state: "active", closePending: false});
    assert.equal(guard.finish(results.find(Boolean), completeSuccess()), "available");
    assert.deepEqual(guard.snapshot(), {state: "available", closePending: false});
  });

  test("closes before an SDK can retry an ambiguous POST with a fresh boundary", async () => {
    const guard = createHostHttpAdmissionGuard(reservation());
    const counters = {boundary: 0, pa: 0, rs: 0, sql: 0, socket: 0};
    const dispatch = async (sdkRequest: number): Promise<void> => {
      const lease = guard.acquire();
      if (lease === undefined) {throw new Error(`admission closed for SDK request ${sdkRequest}`);}
      counters.boundary += 1;
      counters.pa += 1;
      counters.rs += 1;
      counters.sql += 1;
      counters.socket += 1;
      guard.invalidate(lease);
      throw new Error("ambiguous POST write acknowledgement");
    };

    await assert.rejects(dispatch(1), /ambiguous POST/);
    const afterFirst = {...counters};
    await assert.rejects(dispatch(2), /admission closed/);
    assert.deepEqual(counters, afterFirst);
    assert.deepEqual(counters, {boundary: 1, pa: 1, rs: 1, sql: 1, socket: 1});
    assert.deepEqual(guard.snapshot(), {state: "closed", closePending: false});
  });

  for (const [name, disposition] of [
    ["write acknowledgement loss", {response: "unknown"}],
    ["partial write", {response: "partial_write"}],
    ["truncated response", {...completeSuccess(), response: "truncated"}],
    ["stalled response", {...completeSuccess(), response: "stalled"}],
    ["unknown response delivery", {...completeSuccess(), delivery: "unknown"}],
    ["unknown upstream closure", {...completeSuccess(), upstreamClosure: "unknown"}],
    ["unknown inbound closure", {...completeSuccess(), inboundClosure: "unknown"}],
    ["evidence acknowledgement loss", {...completeSuccess(), evidenceAcknowledgement: "unknown"}],
  ] as const) {
    test(`${name} permanently closes admission`, () => {
      const guard = createHostHttpAdmissionGuard(reservation());
      assert.equal(guard.finish(acquired(guard), disposition), "closed");
      assert.equal(guard.acquire(), undefined);
      assert.equal(guard.finish(Object.freeze({}), completeSuccess()), "rejected");
      assert.deepEqual(guard.snapshot(), {state: "closed", closePending: false});
    });
  }

  for (const response of ["http_401", "http_403", "http_429", "http_500", "retry_eligible"] as const) {
    test(`${response} cannot release for retry`, () => {
      const guard = createHostHttpAdmissionGuard(reservation());
      const disposition = {...completeSuccess(), response};
      assert.equal(guard.finish(acquired(guard), disposition), "closed");
      assert.equal(guard.acquire(), undefined);
    });
  }

  test("complete success permits a legitimate identical-body next tool round", () => {
    const body = new Uint8Array([1, 2, 3]);
    const guard = createHostHttpAdmissionGuard(reservation());
    const first = acquired(guard);
    assert.equal(guard.finish(first, completeSuccess()), "available");
    const second = acquired(guard);
    assert.notEqual(second, first);
    assert.deepEqual(body, new Uint8Array([1, 2, 3]));
    assert.equal(guard.finish(second, completeSuccess()), "available");
  });

  test("stale and copied leases cannot displace a newer active lease", () => {
    const guard = createHostHttpAdmissionGuard(reservation());
    const stale = acquired(guard);
    assert.equal(guard.finish(stale, completeSuccess()), "available");
    const current = acquired(guard);
    assert.equal(guard.finish(stale, completeSuccess()), "rejected");
    assert.deepEqual(guard.snapshot(), {state: "active", closePending: true});
    assert.equal(guard.finish(current, completeSuccess()), "closed");

    const copiedGuard = createHostHttpAdmissionGuard(reservation());
    const exact = acquired(copiedGuard);
    const copy = {...exact};
    assert.equal(copiedGuard.finish(copy, completeSuccess()), "rejected");
    assert.deepEqual(copiedGuard.snapshot(), {state: "active", closePending: true});
    assert.equal(copiedGuard.finish(exact, completeSuccess()), "closed");
  });

  test("forged, mutated, and cross-guard leases never release another live lease", () => {
    const left = createHostHttpAdmissionGuard(reservation());
    const right = createHostHttpAdmissionGuard({...reservation(), operationId: "operation-2"});
    const leftLease = acquired(left);
    const rightLease = acquired(right);
    assert.equal(Reflect.set(leftLease as object, "forged", true), false);
    assert.equal(left.finish(Object.freeze({forged: true}), completeSuccess()), "rejected");
    assert.equal(left.finish(rightLease, completeSuccess()), "rejected");
    assert.deepEqual(right.snapshot(), {state: "active", closePending: false});
    assert.equal(right.finish(rightLease, completeSuccess()), "available");
    assert.equal(left.finish(leftLease, completeSuccess()), "closed");
  });

  test("late success cannot reopen invalidated or explicitly closed admission", () => {
    const guard = createHostHttpAdmissionGuard(reservation());
    const lease = acquired(guard);
    assert.equal(guard.invalidate(lease), "closed");
    assert.equal(guard.finish(lease, completeSuccess()), "rejected");
    guard.close();
    guard.close();
    assert.equal(guard.acquire(), undefined);
    assert.deepEqual(guard.snapshot(), {state: "closed", closePending: false});
  });

  test("snapshots reservation inputs and rejects accessors without invoking them", () => {
    const input = reservation();
    const guard = createHostHttpAdmissionGuard(input);
    input.operationId = "mutated";
    input.liveProcessSessionIdentity = {};
    assert.equal(guard.finish(acquired(guard), completeSuccess()), "available");

    let getterCalls = 0;
    const hostile = reservation();
    Object.defineProperty(hostile, "attemptId", {get: () => {
      getterCalls += 1;
      return "attempt-hostile";
    }});
    assert.throws(() => createHostHttpAdmissionGuard(hostile), /invalid Host HTTP reservation identity/);
    assert.equal(getterCalls, 0);
  });

  test("malformed completion accessors are not invoked and seal the lease", () => {
    const guard = createHostHttpAdmissionGuard(reservation());
    const disposition = completeSuccess() as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(disposition, "delivery", {get: () => {
      getterCalls += 1;
      return "delivered";
    }});
    assert.equal(guard.finish(acquired(guard), disposition), "closed");
    assert.equal(getterCalls, 0);
    assert.equal(guard.acquire(), undefined);
  });

  test("extra or unknown completion facts cannot manufacture success", () => {
    for (const disposition of [
      {...completeSuccess(), receiptDigest: "claimed-proof"},
      {...completeSuccess(), delivery: undefined},
      null,
      [],
    ]) {
      const guard = createHostHttpAdmissionGuard(reservation());
      assert.equal(guard.finish(acquired(guard), disposition), "closed");
    }
  });
});
