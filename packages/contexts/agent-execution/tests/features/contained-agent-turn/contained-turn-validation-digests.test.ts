import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  asContainedTurnCommandFingerprint,
  digestContainedTurnCanonicalInput,
  parseContainedTurnCanonicalDigest,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnSatisfactionDigest } from "../../../dist/features/contained-agent-turn/domain/contained-turn-satisfaction.js";
import { validateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-validation.js";
import {
  canonicalContainedTurnPostgresJson,
  decodeContainedTurnState,
  digestContainedTurnPostgresJson,
  encodeContainedTurnState,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { createOperation, createReservedOperation } from "../../contained-turn-kernel-fixtures.ts";

test("operation counters reject negative zero before canonical serialization can alias zero", () => {
  const operation = createOperation();
  const reserved = createReservedOperation();
  assert.ok(reserved.dispatch.kind === "claimed");
  const malformed: readonly unknown[] = [
    { ...operation, revision: -0 },
    { ...operation, operationCutoff: { ...operation.operationCutoff, revision: -0 } },
    { ...reserved, dispatch: { ...reserved.dispatch, grantReceipts: reserved.dispatch.grantReceipts.map(
      receipt => ({ ...receipt, consumedAtControlTime: -0 }),
    ) } },
  ];
  for (const candidate of malformed) {
    assert.throws(() => validateContainedTurnOperation(candidate), /safe integer/u);
  }
});

test("unknown canonical inputs match independent SHA-256 bytes and preserve distinctions", () => {
  const expectedBytes = '{"a":[null,true,0,"π😀"],"z":{"x":1,"y":2}}';
  const expected = `sha256:${createHash("sha256").update(expectedBytes, "utf8").digest("hex")}`;
  const input: unknown = { z: { y: 2, x: 1 }, a: [null, true, 0, "π😀"] };
  assert.equal(digestContainedTurnCanonicalInput(input), expected);
  assert.equal(digestContainedTurnCanonicalInput(JSON.parse(expectedBytes)), expected);
  for (const changed of [
    { z: { y: 2, x: 2 }, a: [null, true, 0, "π😀"] },
    { z: { y: 2, x: 1 }, a: [null, true, "0", "π😀"] },
    { z: { y: 2, x: 1 }, a: [true, null, 0, "π😀"] },
  ]) {
    assert.notEqual(digestContainedTurnCanonicalInput(changed), expected);
  }
});

test("unknown digest preimages reject coercion and hidden data without evaluating getters", () => {
  let reads = 0;
  const getter = { get value() { reads += 1; return 1; } };
  const arrayGetter = Object.defineProperty([1], "0", { get() { reads += 1; return 1; } });
  const sparse = Array(1);
  const values: readonly unknown[] = [
    undefined, 1n, Symbol("digest"), () => 1, NaN, Infinity, -0, 0.5, Number.MAX_SAFE_INTEGER + 1,
    "\ud800", { "\udfff": 1 }, { value: undefined }, [undefined], sparse, getter, arrayGetter,
    Object.assign([1], { extra: 2 }), Object.assign({}, { [Symbol("hidden")]: 1 }),
    Object.defineProperty({}, "hidden", { value: 1 }), Object.create(null), new Date(0),
  ];
  for (const value of values) {
    assert.throws(() => digestContainedTurnCanonicalInput(value), TypeError);
  }
  for (const digest of [null, 1, {}, "sha256:abcd", `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => parseContainedTurnCanonicalDigest(digest), TypeError);
  }
  assert.equal(reads, 0);
});

test("satisfaction binds proof contents while ignoring record and proof ordering", () => {
  const operation = createOperation();
  const original = containedTurnSatisfactionDigest(operation);
  const reordered = {
    ...operation,
    proofs: operation.proofs.toReversed().map(proof => ({
      ...proof, binding: Object.fromEntries(Object.entries(proof.binding).toReversed()),
    })),
  };
  // Satisfaction has no acceptance-first ordering requirement; operation validation does.
  const firstProof = operation.proofs[0];
  assert.ok(firstProof);
  assert.equal(digestContainedTurnCanonicalInput(firstProof),
    digestContainedTurnCanonicalInput(Object.fromEntries(Object.entries(firstProof).toReversed())));
  assert.equal(containedTurnSatisfactionDigest({ ...operation, proofs: operation.proofs.toReversed() }), original);
  assert.equal(digestContainedTurnCanonicalInput(reordered.proofs.toReversed()),
    digestContainedTurnCanonicalInput(operation.proofs));
  const changed = {
    ...operation,
    proofs: operation.proofs.map(proof => proof.kind === "acceptance" ? {
      ...proof, binding: { ...proof.binding,
        commandFingerprint: asContainedTurnCommandFingerprint(digestContainedTurnCanonicalInput({ different: true })),
      },
    } : proof),
  };
  assert.notEqual(containedTurnSatisfactionDigest(changed), original);
  assert.throws(() => validateContainedTurnOperation(changed), /acceptance proof/u);
});

test("persisted inputs acquire operation types only after shape and semantic validation", () => {
  const operation: unknown = createOperation();
  const encoded = encodeContainedTurnState(operation);
  const state: unknown = JSON.parse(encoded.json);
  const decoded = decodeContainedTurnState(state, encoded.digest, encoded.codecVersion);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.proofs[0]?.binding));
  assert.deepEqual(decoded, operation);
  assert.throws(() => decodeContainedTurnState(state, "0".repeat(64), encoded.codecVersion), /digest mismatch/u);
  const malformed = { codecVersion: 2, payload: { ...decoded, intent: { mode: "analysis", prompt: 1 } } };
  // A correct storage checksum cannot turn malformed domain fields into authority.
  assert.throws(() => decodeContainedTurnState(malformed, digestContainedTurnPostgresJson(malformed), 2), /prompt must be text/u);
  assert.throws(() => encodeContainedTurnState(malformed.payload), /prompt must be text/u);
  const divergent = { codecVersion: 2, payload: {
    ...decoded, commandFingerprint: digestContainedTurnCanonicalInput({ wrong: "intent" }),
  } };
  assert.throws(() => decodeContainedTurnState(divergent, digestContainedTurnPostgresJson(divergent), 2), /fingerprint does not recompute/u);
  const legacy = { ...decoded, schemaVersion: 1 };
  assert.deepEqual(decodeContainedTurnState(legacy, digestContainedTurnPostgresJson(legacy), 1), decoded);
});

test("persisted shape checks reject accessors before version inference or checksum traversal", () => {
  let reads = 0;
  const versionGetter = { get codecVersion() { reads += 1; return 2; }, payload: createOperation() };
  const payloadGetter = { codecVersion: 2, get payload() { reads += 1; return createOperation(); } };
  for (const state of [versionGetter, payloadGetter]) {
    assert.throws(() => decodeContainedTurnState(state, "irrelevant"), /only enumerable data properties/u);
  }
  const nestedGetter = { codecVersion: 2, payload: { get intent() { reads += 1; return {}; } } };
  assert.throws(() => decodeContainedTurnState(nestedGetter, "irrelevant", 2), /only enumerable data properties/u);
  assert.throws(() => canonicalContainedTurnPostgresJson({ proofs: Array(1) }), /must be dense/u);
  assert.equal(reads, 0);
});
