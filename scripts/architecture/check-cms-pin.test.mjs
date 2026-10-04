import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { exactCmsDelta, loadCmsPinInputs, retainedEvidencePath, verifyCmsPin } from "./check-cms-pin.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fresh = async () => {
  const inputs = await loadCmsPinInputs();
  return {
    ...inputs,
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

test("retains exact CMS delta bytes under conflicting Git inter-hunk context", () => {
  const env = { ...process.env, GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "diff.interHunkContext", GIT_CONFIG_VALUE_0: "10000" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    const { loadCmsPinInputs, verifyCmsPin } = await import(${JSON.stringify(new URL("./check-cms-pin.mjs", import.meta.url).href)});
    const inputs = await loadCmsPinInputs();
    const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
    const digest = "670810e035da54ae00b1b7f45c5516851232439e58673fecc12a83b129be2c99";
    console.log(JSON.stringify({ byteLength: inputs.exactDeltaBytes.length,
      hunks: inputs.exactDeltaBytes.toString("utf8").split("\\n").filter(line => line.startsWith("@@ ")).length,
      sha256: sha256(inputs.exactDeltaBytes) }));
    assert.equal(inputs.deltaBytes.length, 36534);
    assert.equal(sha256(inputs.deltaBytes), digest, "independent retained delta digest");
    assert.equal(sha256(inputs.exactDeltaBytes), digest, "Git must preserve the retained delta digest");
    assert.deepEqual(inputs.exactDeltaBytes, inputs.deltaBytes);
    assert.deepEqual(verifyCmsPin(inputs), {
      commit: "81063add7de50ffe2b91cc74bf7271b298624c21",
      sha256: "49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7",
    });
  `], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(result.stdout.trim());
});

test("accepts a later pin step without any checker edit", async () => {
  const next = await fresh();
  const standardBytes = Buffer.from(`${next.standardBytes.toString("utf8")}\nNext reviewed guidance.\n`);
  const beforePath = "architecture/get-modular/evidence/next-predecessor.md";
  const deltaBytes = await exactCmsDelta(beforePath, next.standard.evidencePath, next.standardBytes, standardBytes);
  const commit = "1".repeat(40);
  const digest = sha256(standardBytes);
  Object.assign(next.standard, { commit, sha256: digest });
  Object.assign(next.contained, { gitCommit: commit, sha256: digest });
  next.predecessorReviewBytes = Buffer.from(JSON.stringify(next.review));
  next.review.predecessorReview = { path: "architecture/get-modular/evidence/previous-review.json",
    sha256: sha256(next.predecessorReviewBytes) };
  next.beforeBytes = next.standardBytes;
  next.review.before = { ...next.review.after, evidencePath: beforePath };
  next.review.after = { ...next.review.after, commit, sha256: digest, byteLength: standardBytes.length };
  next.review.delta = { ...next.review.delta, path: "architecture/get-modular/evidence/next-cms-pin-delta.diff",
    sha256: sha256(deltaBytes), byteLength: deltaBytes.length,
    hunks: 1, removedLines: 0, addedLines: 2 };
  Object.assign(next.review.provenance, { beforeCommit: next.review.before.commit, afterCommit: commit });
  assert.deepEqual(verifyCmsPin({ ...next, standardBytes, deltaBytes, exactDeltaBytes: deltaBytes }), { commit, sha256: digest });
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

test("rejects the retained standard presented as its own delta", async () => {
  const inputs = await fresh();
  inputs.review.delta = { ...inputs.review.delta, path: inputs.standard.evidencePath,
    sha256: sha256(inputs.standardBytes) };
  inputs.deltaBytes = inputs.standardBytes;
  assert.throws(() => verifyCmsPin(inputs), /delta cannot be the retained standard itself/u);
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

test("rejects corrupted predecessor, false linkage, fabricated delta and unsupported scope", async () => {
  for (const mutate of [
    x => { x.beforeBytes = Buffer.from("drift"); },
    x => { x.review.before.byteLength++; },
    x => { x.review.after.byteLength++; },
    x => { x.review.before.commit = "f".repeat(40); },
    x => { x.predecessorReviewBytes = Buffer.from("{}"); },
    x => { x.review.delta.hunks++; },
    x => { x.deltaBytes = Buffer.from("fabricated delta\n");
      Object.assign(x.review.delta, { sha256: sha256(x.deltaBytes), byteLength: x.deltaBytes.length }); },
    x => { x.review.provenance.afterCommit = "main"; },
    x => { x.review.provenance.independentRetrieval = true; },
    x => { delete x.review.applicability; },
    x => { x.review.adoption.containedTurn = "active"; },
    x => { x.review.successorProductionConformance = "established"; },
  ]) {
    const inputs = await fresh(); mutate(inputs);
    assert.throws(() => verifyCmsPin(inputs));
  }
});
