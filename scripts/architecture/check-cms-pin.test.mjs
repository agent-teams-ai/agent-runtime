import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { loadCmsPinInputs, retainedEvidencePath, verifyCmsPin } from "./check-cms-pin.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fresh = async () => {
  const inputs = await loadCmsPinInputs();
  return {
    standard: structuredClone(inputs.standard),
    contained: structuredClone(inputs.contained),
    review: structuredClone(inputs.review),
    standardBytes: Buffer.from(inputs.standardBytes),
    deltaBytes: Buffer.from(inputs.deltaBytes),
  };
};

test("accepts the retained pin and returns the passive profile identity", async () => {
  const inputs = await fresh();
  assert.deepEqual(verifyCmsPin(inputs), { commit: inputs.standard.commit, sha256: inputs.standard.sha256 });
});

test("accepts a later pin step without any checker edit", async () => {
  const next = await fresh();
  const standardBytes = Buffer.from(`${next.standardBytes.toString("utf8")}\nNext reviewed guidance.\n`);
  const deltaBytes = Buffer.from("@@ -1 +1,2 @@\n+Next reviewed guidance.\n");
  const commit = "1".repeat(40);
  const digest = sha256(standardBytes);
  Object.assign(next.standard, { commit, sha256: digest });
  Object.assign(next.contained, { gitCommit: commit, sha256: digest });
  next.review.before = next.review.after;
  next.review.after = { ...next.review.after, commit, sha256: digest, byteLength: standardBytes.length };
  next.review.delta = { ...next.review.delta, path: "architecture/get-modular/evidence/next-cms-pin-delta.diff",
    sha256: sha256(deltaBytes) };
  assert.deepEqual(verifyCmsPin({ ...next, standardBytes, deltaBytes }), { commit, sha256: digest });
});

test("rejects split profile pins", async () => {
  for (const mutate of [
    inputs => { inputs.contained.gitCommit = "moving-main"; },
    inputs => { inputs.contained.sha256 = "0".repeat(64); },
    inputs => { inputs.standard.anchor = "another-standard"; },
    inputs => { inputs.contained = undefined; },
  ]) {
    const inputs = await fresh();
    mutate(inputs);
    assert.throws(() => verifyCmsPin(inputs), /standard pins must agree/u);
  }
});

test("rejects retained standard bytes that differ from the pin", async () => {
  const inputs = await fresh();
  inputs.standardBytes = Buffer.concat([inputs.standardBytes, Buffer.from("drift")]);
  assert.throws(() => verifyCmsPin(inputs), /retained standard bytes/u);
});

test("rejects a review that does not end at the pinned standard", async () => {
  for (const mutate of [
    review => { review.after.commit = review.before.commit; },
    review => { review.after.sha256 = review.before.sha256; },
    review => { review.after.evidencePath = "architecture/get-modular/evidence/other.md"; },
    review => { review.repository = "another/repository"; },
    review => { delete review.after; },
  ]) {
    const inputs = await fresh();
    mutate(inputs.review);
    assert.throws(() => verifyCmsPin(inputs), /review must end at the pinned standard/u);
  }
});

test("rejects a delta detached from its review digest", async () => {
  for (const mutate of [
    inputs => { inputs.deltaBytes = Buffer.concat([inputs.deltaBytes, Buffer.from("drift")]); },
    inputs => { inputs.review.delta.sha256 = "0".repeat(64); },
    inputs => { delete inputs.review.delta; },
  ]) {
    const inputs = await fresh();
    mutate(inputs);
    assert.throws(() => verifyCmsPin(inputs), /delta must match its review digest/u);
  }
});

test("rejects retained evidence paths outside the checkout", () => {
  for (const path of [undefined, "", "/etc/passwd", "../outside.diff", "architecture/../../outside.diff",
    "architecture\\..\\..\\outside.diff"]) {
    assert.throws(() => retainedEvidencePath(path), /unsafe retained CMS evidence path/u);
  }
  assert.equal(retainedEvidencePath("architecture/get-modular/evidence/delta.diff"),
    "architecture/get-modular/evidence/delta.diff");
});
