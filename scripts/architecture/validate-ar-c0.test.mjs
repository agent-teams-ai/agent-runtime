import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {artifact, sha256, validateContract, validateSchema, validateWorkspace, validateWorkspaceEvidence} from './validate-ar-c0.mjs';
const read = p => readFileSync(new URL(`../../${p}`,import.meta.url));
const original = JSON.parse(read(artifact));
const receipt = JSON.parse(read('architecture/c0/ar-owned-lifetime/identity.json'));
const schema = JSON.parse(read('architecture/c0/ar-owned-lifetime/contract.schema.json'));
const validate = c => {validateSchema(c,schema); return validateContract(c,receipt);};

test('exact retained source, reviewed final plan and canonical stop evidence validate', () => {
  assert.equal(validate(original),true);
  assert.equal(validateWorkspaceEvidence().contractRevision,'ar-c0-be96f01e-r2');
  assert.equal(validateWorkspace().contractRevision,'ar-c0-be96f01e-r2');
});
const cases = [
  ['unsupported schema revision', c => {c.schemaVersion=2;}, /schema revision/],
  ['source identity', c => {c.source.commit = '0'.repeat(40);}, /stale source/],
  ['superseded plan', c => {c.source.planSha256 = '05563ce2e4c5a723b34bf527e71109e33dac072be982e8c0535291b18f462ebc';}, /stale plan/],
  ['previous supplied plan accepted as final', c => {c.source.planSha256 = 'ef33621900ffb72ee87e55c607f7394ebd859b59fe9f72f219f5ca7fc1783bf6';}, /stale plan/],
  ['missing exact plan review', c => {c.source.planReview.requiredBytesRead=false;}, /final plan review/],
  ['early coding consumer', c => {c.allowedConsumers.push('AR A1');}, /deep-equal|consumers/],
  ['missing scope', c => {c.ownership.scopeCandidates.pop();}, /scope|items/],
  ['ceremonial construction consumer', c => {c.ownership.scopeCandidates[0].counted=true;}, /scope/],
  ['wrapper counted twice', c => {c.ownership.provenDistinctScopes=2;}, /1/],
  ['ownership admission', c => {c.ownership.admission='pass';}, /admission|enum/],
  ...['K1','A1','A2'].map(lane => [`false ${lane}`, c => {c.verdicts[lane].result='go';}, /admission/]),
  ['noncanonical pass status', c => {c.verdicts.ARSourceInventory.result='pass';}, /enum/],
  ['retained CMS passed as current', c => {c.verdicts.CMSComparison.result='go';}, /current upstream/],
  ['A2 without K1/A1', c => {c.ownership.conditionalConstraints.A2Prerequisites=[];}, /requires admitted/],
  ['AR-local duplicate', c => {c.ownership.conditionalConstraints.ARLocalDuplicateAllowed=true;}, /operator constraint/],
  ['async generic transitions', c => {c.ownership.conditionalConstraints.genericTransitions='async';}, /operator constraint/],
  ['two failure channels', c => {c.ownership.conditionalConstraints.genericFailureChannel='throw or result';}, /operator constraint/],
  ['generic raw cause custody', c => {c.ownership.conditionalConstraints.rawCauseOwner='GM';}, /operator constraint/],
  ['async ownership commit', c => {c.ownership.conditionalConstraints.handoffCommit='await callback';}, /operator constraint/],
  ['effect before flight publication', c => {c.ownership.conditionalConstraints.rawFlightPublication='invoke cleanup then assign Promise';}, /operator constraint/],
  ['observers before state settlement', c => {c.ownership.conditionalConstraints.observerOrdering='resolve then store state';}, /operator constraint/],
  ['generic graph coordinator', c => {c.ownership.conditionalConstraints.coordinator='dynamic generic DAG';}, /operator constraint/],
  ['unstable action diagnostics', c => {c.ownership.conditionalConstraints.diagnosticIdentity='array position';}, /operator constraint/],
  ['self-authorizing CI', c => {c.ci.trustedAnchor.authorityLocation='candidate workflow';}, /candidate cannot/],
  ['invented verified S3 anchor', c => {c.ci.trustedAnchor.verifiedAnchor='.github/workflows/ci.yml';}, /invented external/],
  ['inert recovery owner', c => {c.ownership.constructionAllSettledDebt.recoveryOwner='error.cleanupFailed';}, /recovery owner/],
  ['detached continuation as recovery API', c => {c.ownership.constructionAllSettledDebt.entrypoint='promise.then';}, /recovery API/],
  ['missing strong holder', c => {delete c.ownership.owners[1].strongRetentionOwner;}, /strongRetentionOwner/],
  ['empty retention', c => {c.ownership.owners[1].strongRetentionOwner='';}, /Retention/],
  ['missing raw owner completion', c => {delete c.ownership.owners[1].rawCompletion;}, /rawCompletion/],
  ['missing owner recovery', c => {delete c.ownership.owners[1].recovery;}, /recovery/],
  ['missing cleanup action', c => {c.ownership.owners.splice(4,1);}, /owner action|missing items/],
  ['duplicate effect', c => {c.ownership.owners.push(c.ownership.owners[1]);}, /owner action/],
  ['unknown prerequisite', c => {c.ownership.owners[3].prerequisites.push('invented');}, /unknown prerequisite/],
  ['missing prerequisite outcome', c => {delete c.ownership.owners[3].prerequisiteOutcome;}, /prerequisiteOutcome/],
  ['pending prerequisite authorizes cleanup', c => {c.ownership.prerequisiteRule.pendingOrUnknown='run cleanup';}, /blocked prerequisite/],
  ['cleanup cycle', c => {c.ownership.owners[1].prerequisites.push('codex-adapter');c.ownership.owners[1].prerequisiteOutcome='host-prerequisite-rule';}, /cycle/],
  ['borrowed pool closure', c => {c.ownership.owners[7].cleanup='pool.end';}, /NEVER/],
  ['timeout changed', c => {c.waitPolicy.currentInnerWaitMs=30000;}, /timeout/],
  ['missing outer disposer link', c => {c.waitPolicy.path.shift();}, /complete outer disposer/],
  ['inner facade wrapped', c => {c.waitPolicy.wrapInnerFacade=true;}, /wrap/],
  ['outer invented bound', c => {c.waitPolicy.currentOuterWaitMs=1000;}, /unbounded/],
  ['unapproved ordinary deadline', c => {c.waitPolicy.selectedOrdinaryWaitMs=30000;}, /activation/],
  ['two independent OrdinaryFeatures', c => {c.waitPolicy.ownerIdentity.sameInstance=false;}, /same OrdinaryFeature/],
  ['two owner tickets', c => {c.waitPolicy.ownerIdentity.effectOwnerCount=2;}, /same OrdinaryFeature/],
  ['raw facade masquerades as driver', c => {c.waitPolicy.rawSeam.availableNow=true;}, /raw completion/],
  ['missing raw seam compatibility', c => {delete c.waitPolicy.rawSeam.behaviorCompatibility;}, /behaviorCompatibility/],
  ['claimed compatible behavior', c => {c.waitPolicy.rawSeam.behaviorCompatibility='proven';}, /unproven/],
  ['lost AggregateError carrier', c => {c.waitPolicy.errorCarrier.outer='new TimeoutError';}, /AggregateError/],
  ['claimed error projection compatibility', c => {c.waitPolicy.errorCarrier.projectionCompatibility.result='go';}, /error projection/],
  ['primary repeated in future aggregate', c => {c.waitPolicy.errorCarrier.projectionCompatibility.futureDuplicatePrimary=true;}, /duplicate primary/],
  ['omitted nested deadline', c => {c.waitPolicy.deadlines.pop();}, /deadline census/],
  ['changed process grace', c => {c.waitPolicy.deadlines[3].milliseconds[0]=30000;}, /deadline census/],
  ['omitted broker HTTP deadlines', c => {c.waitPolicy.deadlines=c.waitPolicy.deadlines.filter(d=>d.id!=='pa-broker-http');}, /deadline census/],
  ['active before code', c => {c.delivery.newAdoptions='active';}, /active before code/],
  ['missing package', c => {c.inventory.packages.pop();}, /missing package/],
  ['private flag hides exports', c => {c.inventory.packages[1].exports=null;}, /stale package surface/],
  ['missing export branch', c => {c.inventory.packages[1].branches.pop();}, /ordered export branches/],
  ['condition order changed without target change', c => {const p=c.inventory.packages[1];p.exports['.']=Object.fromEntries(Object.entries(p.exports['.']).toReversed());}, /ordered export map/],
  ['branch resolution order drift', c => {const b=c.inventory.packages[1].branches[0];b.resolutionTree=Object.fromEntries(Object.entries(b.resolutionTree).toReversed());}, /ordered export branches/],
  ['invented packed coverage', c => {c.inventory.packages[1].branches[0].coverage='complete';}, /incomplete/],
  ['CMS wrong historical authority', c => {c.cms.before.commit='714d6194afd24e0bb4375f4d38e2422c892ad021';}, /active authority/],
  ['CMS false byte equality', c => {c.cms.fullDocumentBytesEqual=true;}, /byte no-op/],
  ['CMS false fresh measurement', c => {c.cms.upstreamFreshness='verified';}, /unproven live/],
  ['unknown schema field', c => {c.runtimeImplemented=true;}, /unknown/],
  ['missing schema section', c => {delete c.waitPolicy;}, /missing waitPolicy/],
];
for (const [name,mutate,expected] of cases) {test(`rejects ${name}`, () => {
  const c=structuredClone(original); mutate(c); assert.throws(() => validate(c),expected);
});}
test('rejects actual plan/source byte drift, not just changed contract strings', () => {
  for (const path of [original.source.planPath,original.evidence.lifecycle.path]) {
    assert.throws(() => validateContract(original,receipt,{readBytes:p => p===path ? Buffer.from('drift') : read(p)}),/stale/);
  }

});
test('independent source oracle proves exact shared owner identity and existing wait facade', () => {
  const source=id=>read(original.evidence[id].path).toString();
  assert.match(source('assembly'), /\}, dependencies\["ordinary-turn"\]\);/u);
  assert.match(source('assembly'), /ordinary\.decorateHost\(rawHost, dependencies\["ordinary-turn"\]\)/u);
  assert.match(source('host'), /\(\) => ordinaryOwner\.dispose\(\)/u);
  assert.match(source('ordinaryHost'), /await host\.dispose\(\)/u);
  assert.match(source('ordinaryHost'), /await feature\.dispose\(\)/u);
  assert.match(source('engine'), /dispose: \(\) => disposal \?\?=/u);
  assert.match(source('lifecycle'), /HOST_DISPOSAL_WAIT_DEADLINE_MS = 1_000/u);
  assert.match(source('broker'), /requestTimeout: 15_000, headersTimeout: 5000/u);
  assert.match(source('lifecycle'), /Promise\.race\(\[\s*this\.#finishDisposal\(\),\s*this\.#rejectAtDeadline\(\)/u);
  assert.match(source('attempt'), /const host = ownedHost;\s*ownedHost = undefined;\s*try \{ await host\.dispose\(\); \} catch/u);
  assert.doesNotMatch(source('creationError'), /recoveryOwner|resumeCleanup|retryCleanup/u);
});

const forgedEvidence = [
  ['security replaced by attempt', c => {c.evidence.security = structuredClone(c.evidence.attempt);}],
  ['missing public entry', c => {delete c.evidence.publicEntry;}],
  ['missing public API tests', c => {delete c.evidence.publicApiTests;}],
  ['missing all profiles and archives', c => {c.inventory.profiles=[]; c.inventory.archives=[];}],
  ['missing profiles', c => {c.inventory.profiles=[];}],
  ['missing archives', c => {c.inventory.archives=[];}],
  ['duplicate evidence paths', c => {c.evidence.publicApiTests=structuredClone(c.evidence.publicEntry);}],
  ['unique substituted security path', c => {c.evidence.security.path='README.md';}],
  ['unknown verdict', c => {c.verdicts.Invented={result:'go',reason:'forged'};}],
  ...['blocked','pending'].map(result => [`A3 go with SDK ${result}`, c => {c.verdicts.A3={result:'go',reason:'forged'}; c.verdicts.SDKActivation.result=result;}]),
];
for (const [name, mutate] of forgedEvidence) {test(`rejects refreshed receipt: ${name}`, () => {
  const c=structuredClone(original); mutate(c);
  for (const record of Object.values(c.evidence)) {record.sha256=sha256(read(record.path));}
  const refreshed={...receipt,sha256:sha256(JSON.stringify(c,null,2)+'\n')};
  assert.equal(refreshed.sha256,sha256(JSON.stringify(c,null,2)+'\n'));
  assert.throws(() => validateContract(c,refreshed), /evidence|profile|archive|verdict/);
  if (name.includes('verdict') || name.includes('A3')) {assert.throws(() => validateSchema(c,schema), /unknown|enum/);}
});}

// Refresh both the candidate digest and receipt: neither owns expected identity.
const identityTargets = [
  ['plan', c => c.source, 'planPath', 'planSha256'],
  ['quality standard', c => c.source, 'qualityStandardPath', 'qualityStandardSha256'],
  ['CMS delta', c => c.cms, 'deltaPath', 'deltaSha256'],
  ['CMS before', c => c.cms.before, 'evidencePath', 'sha256'],
  ['CMS after', c => c.cms.after, 'evidencePath', 'sha256'],
  ['lock', c => c.inventory.lock, 'path', 'sha256'],
  ['workspace', c => c.inventory.workspace, 'path', 'sha256'],
  ['workflow', c => c.ci, 'workflow', 'sha256'],
  ...original.inventory.profiles.map((_,i) => [`profile ${i}`, c => c.inventory.profiles[i], 'path', 'sha256']),
  ...original.inventory.archives.map((_,i) => [`archive ${i}`, c => c.inventory.archives[i], 'archivePath', 'archiveSha256']),
  ...original.inventory.packages.map((_,i) => [`package ${i}`, c => c.inventory.packages[i], 'manifest', 'sha256']),
  ...Object.keys(original.evidence).map(key => [`evidence ${key}`, c => c.evidence[key], 'path', 'sha256']),
];
for (const [name, select, pathKey, hashKey] of identityTargets) {
  for (const mode of ['redirect', 'digest-and-bytes']) {test(`rejects ${name} ${mode} with refreshed receipt`, () => {
    const c = structuredClone(original), record = select(c);
    const path = record[pathKey];
    if (mode === 'redirect') {record[pathKey] = 'README.md';}
    record[hashKey] = sha256(read('README.md'));
    const refreshed = {...receipt, sha256:sha256(JSON.stringify(c,null,2)+'\n')};
    assert.throws(() => validateContract(c,refreshed,{readBytes:p => mode === 'digest-and-bytes' && p === path ? read('README.md') : read(p)}), /identity|identities|digest|evidence|plan|profile|archive/);
  });}
}
for (const mode of ['omit','extra','substitute']) {test(`rejects ${mode} evidence with refreshed receipt`, () => {
  const c = structuredClone(original);
  if (mode === 'omit') {delete c.evidence.security;}
  if (mode === 'extra') {c.evidence.extra = structuredClone(c.evidence.security);}
  if (mode === 'substitute') {c.evidence.security = structuredClone(c.evidence.attempt);}
  assert.throws(() => validateContract(c,{...receipt,sha256:sha256(JSON.stringify(c,null,2)+'\n')}), /evidence/);
});}
test('rejects redirected active CMS profile', () => {
  const c=structuredClone(original); c.cms.activeProfile='README.md';
  assert.throws(() => validateContract(c,receipt), /fixed CMS identity/);
});
for (const collection of ['packages','profiles','archives']) {
  for (const mode of ['omit','extra','substitute']) {test(`rejects ${collection} ${mode} with refreshed receipt`, () => {
    const c=structuredClone(original), records=c.inventory[collection];
    if (mode === 'omit') {records.pop();}
    if (mode === 'extra') {records.push(structuredClone(records[0]));}
    if (mode === 'substitute') {records[1]=structuredClone(records[0]);}
    assert.throws(() => validateContract(c,{...receipt,sha256:sha256(JSON.stringify(c,null,2)+'\n')}), /package|profile|archive/);
  });}
}
