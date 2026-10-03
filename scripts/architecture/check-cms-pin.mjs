import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One-step Consumer Module Standard pin check, added by owner decision
// 2026-10-02 (AR-0) in place of the hardcoded commit chain kept in
// consumer-module-standard-pin.mjs. It holds no commit or digest literals: the
// current step is proved by the retained bytes, the review and its delta. A pin
// migration adds a new review and delta, updates both profiles and the retained
// standard bytes, and points `cmsPinReviewPath` at the new review. Git keeps
// the history of earlier steps.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const cmsPinReviewPath = "architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json";
export const passiveProfilePath = "architecture/get-modular/consumer-profile.json";
export const containedProfilePath = "architecture/consumer-module-standard/contained-turn-profile.json";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export const retainedEvidencePath = path => {
  assert.ok(typeof path === "string" && path.length > 0 && !isAbsolute(path)
    && !path.split(/[\\/]/u).includes(".."), `unsafe retained CMS evidence path: ${String(path)}`);
  return path;
};

const identity = ({ repository, path, anchor }) => ({ repository, path, anchor });

/**
 * `standard` is the passive consumer profile pin, `contained` the contained-turn
 * authority record. Returns the verified pin for callers that compare records.
 */
export function verifyCmsPin({ standard, contained = {}, standardBytes, review, deltaBytes }) {
  const pinned = { ...identity(standard), commit: standard.commit, sha256: standard.sha256 };
  assert.deepEqual({ ...identity(contained), commit: contained.gitCommit, sha256: contained.sha256 }, pinned,
    "passive and contained-turn standard pins must agree");
  assert.equal(sha256(standardBytes), standard.sha256, "retained standard bytes must match the pinned sha256");
  const after = review.after ?? {};
  assert.deepEqual({ ...identity(review), commit: after.commit, sha256: after.sha256, evidencePath: after.evidencePath },
    { ...pinned, evidencePath: standard.evidencePath }, "CMS pin review must end at the pinned standard");
  assert.notEqual(review.delta?.path, standard.evidencePath, "CMS pin delta cannot be the retained standard itself");
  assert.equal(sha256(deltaBytes), review.delta?.sha256, "retained CMS pin delta must match its review digest");
  return Object.freeze({ commit: standard.commit, sha256: standard.sha256 });
}

export async function loadCmsPinInputs(root = repositoryRoot) {
  const json = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
  const { standard } = await json(passiveProfilePath);
  const contained = (await json(containedProfilePath)).authority.consumerModuleStandard;
  const review = await json(cmsPinReviewPath);
  return {
    standard, contained, review,
    standardBytes: await readFile(resolve(root, retainedEvidencePath(standard.evidencePath))),
    deltaBytes: await readFile(resolve(root, retainedEvidencePath(review.delta?.path))),
  };
}
