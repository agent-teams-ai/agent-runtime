import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyCmsPinReview } from './cms-pin-review.ts';
import type { CmsPinReview, CmsReviewInputs } from './cms-pin-review.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(): Promise<CmsReviewInputs> {
  const review: CmsPinReview = JSON.parse(await readFile(new URL('../../architecture/get-modular/evidence/smart-ci-cms-pin-review.json', import.meta.url), 'utf8'));
  const beforeBytes = Buffer.from('old\n'), standardBytes = Buffer.from('new\n');
  // Independent, literal Git patch for these two one-line documents.
  const deltaBytes = Buffer.from('diff --git a/before.md b/after.md\nindex 3367afd..3e75765 100644\n--- a/before.md\n+++ b/after.md\n@@ -1 +1 @@\n-old\n+new\n');
  Object.assign(review.before, { sha256: hash(beforeBytes), byteLength: 4, evidencePath: 'before.md' });
  Object.assign(review.after, { sha256: hash(standardBytes), byteLength: 4, evidencePath: 'after.md' });
  const predecessorReviewBytes = Buffer.from(JSON.stringify({ after: review.before }));
  review.predecessorReview.sha256 = hash(predecessorReviewBytes);
  Object.assign(review.delta, { sha256: hash(deltaBytes), byteLength: deltaBytes.length, hunks: 1, addedLines: 1, removedLines: 1 });
  return { review, beforeBytes, standardBytes, predecessorReviewBytes, deltaBytes, exactDeltaBytes: deltaBytes,
    adoption: { passiveAndOrdinary: 'active', containedTurn: 'pending', sdkExternalAuthority: 'pending-authority-qualification' } };
}

export function registerCmsPinReviewTests(): void {
  test('pure CMS review validates an independently stated document transition', async () => {
    verifyCmsPinReview(await fixture());
  });
  test('pure CMS review rejects authenticated-looking false evidence and scope claims', async () => {
    const faults: Array<(x: CmsReviewInputs) => void> = [
      x => { x.deltaBytes = Buffer.from('fabricated\n'); Object.assign(x.review.delta, { sha256: hash(x.deltaBytes), byteLength: x.deltaBytes.length }); },
      x => { x.review.before.commit = 'f'.repeat(40); },
      x => { x.review.delta.removedLines = 0; },
      x => { x.review.provenance.supplier = 'independent-worker'; },
      x => { x.review.applicability.passiveCiHelpers.resources = true; },
      x => { x.review.consumerBehaviorChanged = true; },
      x => { x.adoption.containedTurn = 'active'; },
    ];
    for (const fault of faults) { const inputs = await fixture(); fault(inputs); assert.throws(() => verifyCmsPinReview(inputs)); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { registerCmsPinReviewTests(); }
