import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyCmsPinReview } from "../ci/cms-pin-review.ts";

// One-step Consumer Module Standard pin check, added by owner decision
// 2026-10-02 (AR-0) in place of the hardcoded commit chain kept in
// consumer-module-standard-pin.mjs. It holds no commit or digest literals: the
// current step is proved by the retained bytes, the review and its delta. A pin
// migration adds a new review and delta, updates both profiles and the retained
// standard bytes, and points `cmsPinReviewPath` at the new review. Git keeps
// the history of earlier steps.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const cmsPinReviewPath = "architecture/get-modular/evidence/capability-map-cms-pin-review.json";
export const passiveProfilePath = "architecture/get-modular/consumer-profile.json";
export const containedProfilePath = "architecture/consumer-module-standard/contained-turn-profile.json";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export const retainedEvidencePath = path => {
  assert.ok(typeof path === "string" && path.length > 0 && !isAbsolute(path)
    && !path.split(/[\\/]/u).includes(".."), `unsafe retained CMS evidence path: ${String(path)}`);
  return path;
};

const identity = ({ repository, path, anchor }) => ({ repository, path, anchor });
const documentIdentity = pin => ({ commit: pin?.commit, sha256: pin?.sha256, byteLength: pin?.byteLength });

/** Walk authenticated retained predecessors to the separately verified historical head.
 * This compares source evidence only; it does not promote any composition scope.
 */
export async function verifyCmsPinHistory(review, expectedHead, readBytes) {
  let current = review;
  const seen = new Set();
  for (let step = 0; step < 64; step++) {
    if (JSON.stringify(documentIdentity(current.before)) === JSON.stringify(documentIdentity(expectedHead))) {return;}
    const predecessor = current.predecessorReview;
    assert.ok(predecessor && !seen.has(predecessor.path), 'CMS predecessor history is missing or cyclic');
    seen.add(predecessor.path);
    const bytes = await readBytes(retainedEvidencePath(predecessor.path));
    assert.equal(sha256(bytes), predecessor.sha256, 'CMS historical predecessor review digest drift');
    const previous = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(documentIdentity(previous.after), documentIdentity(current.before), 'CMS historical predecessor linkage drift');
    // The successor retains its predecessor's after bytes under a fixed name;
    // preserve historical review bytes even when their old after path was mutable.
    const standardBytes = await readBytes(retainedEvidencePath(current.before.evidencePath));
    const beforeBytes = await readBytes(retainedEvidencePath(previous.before.evidencePath));
    const deltaBytes = await readBytes(retainedEvidencePath(previous.delta.path));
    assert.equal(sha256(standardBytes), previous.after.sha256, 'CMS historical successor bytes drift');
    assert.equal(sha256(deltaBytes), previous.delta.sha256, 'CMS historical delta digest drift');
    verifyCmsPinReview({ review: previous, standardBytes, beforeBytes, deltaBytes,
      predecessorReviewBytes: await readBytes(retainedEvidencePath(previous.predecessorReview.path)),
      exactDeltaBytes: await exactCmsDelta(previous.before.evidencePath, previous.after.evidencePath, beforeBytes, standardBytes),
      adoption: { passiveAndOrdinary: previous.adoption.passiveAndOrdinary, containedTurn: previous.adoption.containedTurn,
        sdkExternalAuthority: previous.adoption.sdkExternalAuthority } });
    current = previous;
  }
  assert.fail('CMS predecessor history exceeds its bounded retained chain');
}

/**
 * `standard` is the passive consumer profile pin, `contained` the contained-turn
 * authority record. Returns the verified pin for callers that compare records.
 */
export function verifyCmsPin(inputs) {
  const { standard, contained = {}, standardBytes, review, deltaBytes } = inputs;
  const pinned = { ...identity(standard), commit: standard.commit, sha256: standard.sha256 };
  assert.deepEqual({ ...identity(contained), commit: contained.gitCommit, sha256: contained.sha256 }, pinned,
    "passive and contained-turn standard pins must agree");
  assert.equal(sha256(standardBytes), standard.sha256, "retained standard bytes must match the pinned sha256");
  const after = review.after ?? {};
  assert.deepEqual({ ...identity(review), commit: after.commit, sha256: after.sha256, evidencePath: after.evidencePath },
    { ...pinned, evidencePath: standard.evidencePath }, "CMS pin review must end at the pinned standard");
  assert.notEqual(review.delta?.path, standard.evidencePath, "CMS pin delta cannot be the retained standard itself");
  assert.equal(sha256(deltaBytes), review.delta?.sha256, "retained CMS pin delta must match its review digest");
  verifyCmsPinReview(inputs);
  return Object.freeze({ commit: standard.commit, sha256: standard.sha256 });
}

export async function exactCmsDelta(beforePath, afterPath, beforeBytes, afterBytes) {
  const root = await mkdtemp(join(tmpdir(), "TEST-cms-delta-"));
  try {
    const before = basename(retainedEvidencePath(beforePath)), after = basename(retainedEvidencePath(afterPath));
    assert.notEqual(before, after, "CMS delta filenames must differ");
    await writeFile(join(root, before), beforeBytes);
    await writeFile(join(root, after), afterBytes);
    const result = spawnSync("git", ["--no-pager", "-c", "diff.suppressBlankEmpty=true", "diff", "--no-index", "--no-ext-diff", "--no-textconv",
      "--no-color", "--no-renames", "--text", "--full-index", "--diff-algorithm=myers", "--indent-heuristic", "--unified=3", "--inter-hunk-context=0",
      "--src-prefix=a/", "--dst-prefix=b/", "--", before, after], { cwd: root, maxBuffer: 1024 * 1024 });
    assert.ok(!result.error && result.signal === null && [0, 1].includes(result.status), "CMS Git delta generation failed");
    return result.stdout;
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function loadCmsPinInputs(root = repositoryRoot) {
  const consumerRoot = await realpath(root);
  const bytes = async path => {
    const full = await realpath(resolve(consumerRoot, retainedEvidencePath(path)));
    const rel = relative(consumerRoot, full);
    assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"), "CMS evidence escapes consumer checkout");
    return readFile(full);
  };
  const json = async path => JSON.parse((await bytes(path)).toString("utf8"));
  const passive = await json(passiveProfilePath), pending = await json(containedProfilePath);
  const { standard } = passive;
  const contained = pending.authority.consumerModuleStandard;
  const review = await json(cmsPinReviewPath);
  const beforeBytes = await bytes(review.before.evidencePath), standardBytes = await bytes(standard.evidencePath);
  return {
    standard, contained, review, beforeBytes, standardBytes,
    predecessorReviewBytes: await bytes(review.predecessorReview.path),
    deltaBytes: await bytes(review.delta?.path),
    exactDeltaBytes: await exactCmsDelta(review.before.evidencePath, standard.evidencePath, beforeBytes, standardBytes),
    adoption: { passiveAndOrdinary: passive.status, containedTurn: pending.status, sdkExternalAuthority: passive.sdkGrowth.status },
  };
}
