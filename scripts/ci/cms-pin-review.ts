import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

interface DocumentPin { commit: string; sha256: string; byteLength: number; evidencePath: string }
export interface CmsPinReview {
  schemaVersion: number;
  before: DocumentPin; after: DocumentPin;
  predecessorReview: { path: string; sha256: string };
  delta: { path: string; sha256: string; byteLength: number; hunks: number; addedLines: number; removedLines: number };
  provenance: {
    supplier: string; retrieval: string; independentRetrieval: boolean;
    beforeCommit: string; afterCommit: string;
    runtime: { repository: string; baseCommit: string; baseTree: string };
  };
  documentNormativeChange: boolean; consumerBehaviorChanged: boolean;
  successorProductionConformance: string;
  applicability: { status: string; passiveCiHelpers: { descriptors: boolean; resources: boolean; runInputs: boolean; lifecycle: boolean } };
  adoption: { passiveAndOrdinary: string; containedTurn: string; dynamicAgentRuntime: string; sdkExternalAuthority: string };
}
export interface CmsReviewInputs {
  review: CmsPinReview; beforeBytes: Uint8Array; standardBytes: Uint8Array;
  predecessorReviewBytes: Uint8Array; deltaBytes: Uint8Array; exactDeltaBytes: Uint8Array;
  adoption: { passiveAndOrdinary: string; containedTurn: string; sdkExternalAuthority: string };
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const documentIdentity = ({ commit, sha256, byteLength }: DocumentPin) => ({ commit, sha256, byteLength });

// The IO boundary supplies Git's deterministic no-index diff, computed from the
// actual retained documents. This contract neither parses nor applies patches.
export function verifyCmsPinReview(inputs: CmsReviewInputs): void {
  const { review, beforeBytes, standardBytes, predecessorReviewBytes, deltaBytes, exactDeltaBytes } = inputs;
  assert.equal(review.schemaVersion, 1, 'CMS review schema drift');
  for (const pin of [review.before, review.after]) {
    assert.match(pin.commit, /^[a-f0-9]{40}$/u, 'CMS document requires an exact commit');
    assert.match(pin.sha256, /^[a-f0-9]{64}$/u, 'CMS document requires a sha256');
  }
  assert.notEqual(review.before.evidencePath, review.after.evidencePath, 'CMS predecessor must be separately retained');
  assert.equal(hash(beforeBytes), review.before.sha256, 'retained predecessor bytes drift');
  assert.equal(beforeBytes.byteLength, review.before.byteLength, 'CMS predecessor byte length drift');
  assert.equal(standardBytes.byteLength, review.after.byteLength, 'CMS successor byte length drift');
  assert.equal(hash(predecessorReviewBytes), review.predecessorReview.sha256, 'CMS predecessor review digest drift');
  const predecessor: { after: DocumentPin } = JSON.parse(Buffer.from(predecessorReviewBytes).toString('utf8'));
  assert.deepEqual(documentIdentity(predecessor.after), documentIdentity(review.before), 'CMS predecessor linkage drift');
  assert.notEqual(review.predecessorReview.path, review.delta.path, 'CMS predecessor review cannot be the delta');
  assert.equal(deltaBytes.byteLength, review.delta.byteLength, 'CMS delta byte length drift');
  assert.deepEqual(Buffer.from(deltaBytes), Buffer.from(exactDeltaBytes), 'CMS delta must equal the exact Git before-to-after diff');
  const lines = Buffer.from(exactDeltaBytes).toString('utf8').split('\n');
  assert.deepEqual({ hunks: review.delta.hunks, addedLines: review.delta.addedLines, removedLines: review.delta.removedLines }, {
    hunks: lines.filter(line => line.startsWith('@@ ')).length,
    addedLines: lines.filter(line => line.startsWith('+') && !line.startsWith('+++ ')).length,
    removedLines: lines.filter(line => line.startsWith('-') && !line.startsWith('--- ')).length,
  }, 'CMS exact delta summary drift');
  const source = review.provenance;
  assert.deepEqual({ supplier: source.supplier, retrieval: source.retrieval, independentRetrieval: source.independentRetrieval,
    beforeCommit: source.beforeCommit, afterCommit: source.afterCommit }, {
    supplier: 'Root', retrieval: 'supplied-source-packets', independentRetrieval: false,
    beforeCommit: review.before.commit, afterCommit: review.after.commit,
  }, 'CMS retrieval provenance contradicts the reviewed packets');
  assert.equal(source.runtime.repository, 'agent-teams-ai/agent-runtime', 'CMS Runtime repository drift');
  for (const revision of [source.runtime.baseCommit, source.runtime.baseTree]) {
    assert.match(revision, /^[a-f0-9]{40}$/u, 'CMS Runtime provenance requires exact base/tree');
  }
  assert.deepEqual(review.applicability, { status: 'APPLICABLE_MIGRATION_REQUIRED',
    passiveCiHelpers: { descriptors: false, resources: false, runInputs: false, lifecycle: false } }, 'CMS applicability/exclusions drift');
  assert.equal(review.documentNormativeChange, true, 'CMS normative delta must be explicit');
  assert.equal(review.consumerBehaviorChanged, false, 'CMS checkpoint cannot change consumer behavior');
  assert.equal(review.successorProductionConformance, 'not-established', 'CMS checkpoint cannot claim successor production conformance');
  assert.deepEqual(review.adoption, { passiveAndOrdinary: 'active', containedTurn: 'pending',
    dynamicAgentRuntime: 'not-certified', sdkExternalAuthority: 'pending-authority-qualification' }, 'CMS review must preserve scoped adoption states');
  assert.deepEqual(inputs.adoption, { passiveAndOrdinary: review.adoption.passiveAndOrdinary,
    containedTurn: review.adoption.containedTurn, sdkExternalAuthority: review.adoption.sdkExternalAuthority }, 'CMS live adoption state drift');
}
