import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {artifact, ciWorkflow, createGit, sha256, validateCmsProfileTransition, validateContract, validateDeliveryRange, validateIndependentCi, validateProfileMigrations, validateSchema, validateWorkspace, validateWorkspaceEvidence} from './validate-ar-c0.mjs';
const read = p => readFileSync(new URL(`../../${p}`,import.meta.url));
const original = JSON.parse(read(artifact));
const receipt = JSON.parse(read('architecture/c0/ar-owned-lifetime/identity.json'));
const schema = JSON.parse(read('architecture/c0/ar-owned-lifetime/contract.schema.json'));
const validate = c => {validateSchema(c,schema); return validateContract(c,receipt);};
const expectedBase = 'c0dc683ecb14760c75a69283ad7ec312f6246a63';
const expectedDelivery = '510882870c1a7c628187dd91d7dff05225068bdb';
const expectedA3Migration = '712a3e38ac9a561e33eb1563608ca4416190ab17';
const revisionRead = (overrides = new Map()) => (revision, path) => {
  const replacement = overrides.get(`${revision}:${path}`);
  if (replacement !== undefined) {return replacement;}
  const result = spawnSync('git', ['show', `${revision}:${path}`], {cwd:new URL('../../', import.meta.url), encoding:null});
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const currentRead = (overrides = new Map()) => path => overrides.get(path) ?? read(path);

const withRepository = callback => {
  const cwd = mkdtempSync(join(tmpdir(), 'validate-ar-c0-'));
  const runGit = createGit(cwd);
  try {
    runGit('init', '--quiet', '--initial-branch=main');
    runGit('config', 'user.name', 'iliya');
    runGit('config', 'user.email', 'iliyazelenkog@gmail.com');
    const commit = message => {runGit('add', '-A'); runGit('commit', '--quiet', '-m', message); return runGit('rev-parse', 'HEAD');};
    return callback({cwd, runGit, commit});
  } finally {rmSync(cwd, {recursive:true, force:true});}
};

test('exact retained source, reviewed final plan and canonical stop evidence validate', () => {
  assert.equal(validate(original),true);
  const evidence = validateWorkspaceEvidence();
  assert.equal(evidence.sourceBase,expectedBase);
  assert.equal(evidence.deliveryHead,expectedDelivery);
  assert.equal(evidence.contractRevision,'ar-c0-c0dc683e-r3');
  assert.equal(validateWorkspace().contractRevision,'ar-c0-c0dc683e-r3');
});
test('later unrelated README change is outside the fixed delivery range', () => {
  withRepository(({cwd,runGit,commit}) => {
    writeFileSync(join(cwd,'allowed.txt'),'base\n');
    const baseCommit = commit('base');
    writeFileSync(join(cwd,'allowed.txt'),'delivery\n');
    const deliveryCommit = commit('delivery');
    writeFileSync(join(cwd,'README.md'),'later\n');
    commit('later unrelated change');
    assert.deepEqual(validateDeliveryRange({runGit,baseCommit,deliveryCommit,allowedPaths:['allowed.txt']}), ['allowed.txt']);
  });
});
test('rejects a transient forbidden edit restored inside the delivery range', () => {
  withRepository(({cwd,runGit,commit}) => {
    writeFileSync(join(cwd,'allowed.txt'),'base\n');
    const baseCommit = commit('base');
    writeFileSync(join(cwd,'README.md'),'temporary forbidden edit\n');
    commit('forbidden edit');
    rmSync(join(cwd,'README.md'));
    const deliveryCommit = commit('restore tree');
    assert.throws(() => validateDeliveryRange({runGit,baseCommit,deliveryCommit,allowedPaths:['allowed.txt']}), /forbidden C0 edit: README\.md/u);
  });
});
test('rejects a forbidden source renamed to an allowed destination', () => {
  withRepository(({cwd,runGit,commit}) => {
    writeFileSync(join(cwd,'forbidden.txt'),'content\n');
    const baseCommit = commit('base');
    renameSync(join(cwd,'forbidden.txt'),join(cwd,'allowed.txt'));
    const deliveryCommit = commit('rename');
    assert.throws(() => validateDeliveryRange({runGit,baseCommit,deliveryCommit,allowedPaths:['allowed.txt']}), /forbidden C0 edit: forbidden\.txt/u);
  });
});
test('rejects a leading-whitespace path rather than normalizing it to an allowed path', () => {
  withRepository(({cwd,runGit,commit}) => {
    writeFileSync(join(cwd,'seed.txt'),'base\n');
    const baseCommit = commit('base');
    writeFileSync(join(cwd,' forbidden.txt'),'forbidden\n');
    const deliveryCommit = commit('leading-whitespace path');
    assert.throws(() => validateDeliveryRange({runGit,baseCommit,deliveryCommit,allowedPaths:['forbidden.txt']}), /forbidden C0 edit:  forbidden\.txt/u);
  });
});
test('rejects a forbidden path introduced only by the merge commit', () => {
  withRepository(({cwd,runGit,commit}) => {
    writeFileSync(join(cwd,'seed.txt'),'base\n');
    const baseCommit = commit('base');
    runGit('checkout', '--quiet', '-b', 'side');
    writeFileSync(join(cwd,'allowed-side.txt'),'side\n');
    commit('allowed side change');
    runGit('checkout', '--quiet', 'main');
    writeFileSync(join(cwd,'allowed-main.txt'),'main\n');
    commit('allowed main change');
    runGit('merge', '--quiet', '--no-ff', '--no-commit', 'side');
    writeFileSync(join(cwd,'forbidden-merge.txt'),'merge only\n');
    const deliveryCommit = commit('merge with forbidden path');
    assert.throws(
      () => validateDeliveryRange({runGit,baseCommit,deliveryCommit,allowedPaths:['allowed-main.txt','allowed-side.txt']}),
      /forbidden C0 edit: forbidden-merge\.txt/u,
    );
  });
});
test('fails closed for invalid, missing, and non-descendant range commits', () => {
  withRepository(({cwd,runGit,commit}) => {
    writeFileSync(join(cwd,'base.txt'),'base\n');
    const baseCommit = commit('base');
    writeFileSync(join(cwd,'descendant.txt'),'descendant\n');
    const descendant = commit('descendant');
    runGit('checkout', '--quiet', '-b', 'sibling', baseCommit);
    writeFileSync(join(cwd,'sibling.txt'),'sibling\n');
    const sibling = commit('sibling');
    const options = {runGit,allowedPaths:['base.txt','descendant.txt','sibling.txt']};
    assert.throws(() => validateDeliveryRange({...options,baseCommit:'not-a-sha',deliveryCommit:descendant}), /invalid C0 base SHA/u);
    assert.throws(() => validateDeliveryRange({...options,baseCommit,deliveryCommit:'f'.repeat(40)}), /missing C0 delivery commit/u);
    assert.throws(() => validateDeliveryRange({...options,baseCommit:descendant,deliveryCommit:sibling}), /not a descendant/u);
  });
});
test('independent C0 CI wiring stays outside protected runtime evidence identity', () => {
  assert.doesNotThrow(() => validateIndependentCi());
  assert.throws(
    () => validateIndependentCi({inputPolicy:{roots:[],files:[ciWorkflow]}}),
    /protected runtime evidence input/u,
  );
});
test('rejects drift in the independent C0 CI workflow', () => {
  assert.throws(
    () => validateIndependentCi({readBytes:path => path === ciWorkflow ? Buffer.from('name: bypassed\n') : read(path)}),
    /workflow bytes drift/u,
  );
});
test('authenticates frozen C0 and r117 SDK bytes while accepting governed current profile evolution', () => {
  const retained = revisionRead();
  for (const profile of original.inventory.profiles) {
    assert.equal(sha256(retained(expectedBase, profile.path)), profile.sha256);
  }
  const activePath = 'architecture/get-modular/consumer-profile.json';
  assert.notEqual(sha256(read(activePath)), sha256(retained(expectedA3Migration,activePath)), 'fixture must exercise post-r117 profile evolution');
  assert.deepEqual(validateProfileMigrations(original), [
    activePath,
    'architecture/consumer-module-standard/contained-turn-profile.json',
  ]);
  assert.deepEqual(validateCmsProfileTransition(original), [
    activePath,
    'architecture/consumer-module-standard/contained-turn-profile.json',
  ]);
});
test('rejects r117 SDK enrollment that rewrites a frozen profile field', () => {
  const path = 'architecture/get-modular/consumer-profile.json';
  const candidate = JSON.parse(revisionRead()(expectedA3Migration,path));
  candidate.status = 'pending';
  const bytes = Buffer.from(`${JSON.stringify(candidate,null,2)}\n`);
  const revisions = new Map([[`${expectedA3Migration}:${path}`, bytes]]);
  assert.throws(
    () => validateProfileMigrations(original, {readCurrentBytes:currentRead(new Map([[path,bytes]])), readRevisionBytes:revisionRead(revisions)}),
    /accepted r117 SDK profile drift/u,
  );
});
test('rejects drift in the accepted r117 SDK profile extension', () => {
  const path = 'architecture/consumer-module-standard/contained-turn-profile.json';
  const candidate = JSON.parse(revisionRead()(expectedA3Migration,path));
  candidate.sdkGrowth.candidateMayAuthorize = true;
  const bytes = Buffer.from(`${JSON.stringify(candidate,null,2)}\n`);
  const revisions = new Map([[`${expectedA3Migration}:${path}`, bytes]]);
  assert.throws(
    () => validateProfileMigrations(original, {readCurrentBytes:currentRead(new Map([[path,bytes]])), readRevisionBytes:revisionRead(revisions)}),
    /accepted r117 SDK profile drift/u,
  );
});
test('rejects adding the r117 SDK extension to any other frozen profile', () => {
  const path = 'architecture/feature-module-standard/candidate-profile.json';
  const candidate = JSON.parse(revisionRead()(expectedA3Migration,path));
  candidate.sdkGrowth = JSON.parse(revisionRead()(expectedA3Migration,'architecture/get-modular/consumer-profile.json')).sdkGrowth;
  const bytes = Buffer.from(`${JSON.stringify(candidate,null,2)}\n`);
  const revisions = new Map([[`${expectedA3Migration}:${path}`, bytes]]);
  assert.throws(
    () => validateProfileMigrations(original, {readCurrentBytes:currentRead(new Map([[path,bytes]])), readRevisionBytes:revisionRead(revisions)}),
    /unreviewed r117 profile migration/u,
  );
});
test('rejects dropping either reviewed r117 SDK profile migration', () => {
  const path = 'architecture/consumer-module-standard/contained-turn-profile.json';
  const retained = revisionRead()(expectedBase,path);
  const revisions = new Map([[`${expectedA3Migration}:${path}`, retained]]);
  assert.throws(
    () => validateProfileMigrations(original, {readCurrentBytes:currentRead(new Map([[path,retained]])), readRevisionBytes:revisionRead(revisions)}),
    /accepted r117 SDK profile drift/u,
  );
});
test('rejects drift in r117 SDK qualification artifacts at the accepted revision', () => {
  for (const path of ['architecture/sdk-growth/profile.yaml','architecture/sdk-growth/activation.json','architecture/sdk-growth/qualification.json']) {
    const revisions = new Map([[`${expectedA3Migration}:${path}`, Buffer.from('drift\n')]]);
    assert.throws(
      () => validateProfileMigrations(original, {readRevisionBytes:revisionRead(revisions)}),
      /accepted r117 SDK artifact drift/u,
    );
  }
});
test('rejects an extra current change to an unrelated frozen profile', () => {
  const path = 'architecture/feature-module-standard/candidate-profile.json';
  const candidate = JSON.parse(read(path));
  candidate.unreviewed = true;
  const bytes = Buffer.from(`${JSON.stringify(candidate,null,2)}\n`);
  assert.throws(
    () => validateProfileMigrations(original, {readCurrentBytes:currentRead(new Map([[path,bytes]]))}),
    /unrelated frozen profile changed/u,
  );
});
test('rejects wrong current CMS authority while leaving non-CMS profile evolution to its owning gates', () => {
  const path = 'architecture/get-modular/consumer-profile.json';
  const candidate = JSON.parse(read(path));
  candidate.standard.commit = '0'.repeat(40);
  const bytes = Buffer.from(`${JSON.stringify(candidate,null,2)}\n`);
  assert.throws(
    () => validateCmsProfileTransition(original, {readCurrentBytes:currentRead(new Map([[path,bytes]]))}),
    /current active CMS authority drift/u,
  );
});
test('rejects an unreviewed current authority change outside the delegated CMS slot', () => {
  const path = 'architecture/get-modular/consumer-profile.json';
  const candidate = JSON.parse(read(path));
  candidate.authority.owner = 'Unreviewed owner';
  const bytes = Buffer.from(`${JSON.stringify(candidate,null,2)}\n`);
  assert.throws(
    () => validateCmsProfileTransition(original, {readCurrentBytes:currentRead(new Map([[path,bytes]]))}),
    /outside delegated CMS and source relationships/u,
  );
});
test('rejects drift in historical CMS bytes authenticated from the retained revision', () => {
  const path = original.cms.before.evidencePath;
  const revisions = new Map([[`${expectedBase}:${path}`, Buffer.from('drift\n')]]);
  assert.throws(
    () => validateContract(original,receipt,{readRevisionBytes:revisionRead(revisions)}),
    /historical CMS complete bytes drift/u,
  );
});
const cases = [
  ['unsupported schema revision', c => {c.schemaVersion=2;}, /schema revision/],
  ['pre-rebase source', c => {c.source.commit = 'be96f01ea54ec7d2ec0156774e3dfb75fac46803';}, /stale source/],
  ['pre-rebase tree', c => {c.source.tree = '821135f9e4c4585db639e5139468829396e966de';}, /54a5f375/],
  ['pre-rebase profile digest', c => {c.inventory.profiles[0].sha256 = '2373779b480bd455978189e2ed3cee726346827d626bbc4545401e3f393c01e6';}, /profile/],
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
  assert.throws(
    () => validateContract(original,receipt,{readBytes:p => p===original.source.planPath ? Buffer.from('drift') : read(p)}),
    /stale/,
  );
  const path = original.evidence.lifecycle.path;
  const revisions = new Map([[`${expectedBase}:${path}`, Buffer.from('drift')]]);
  assert.throws(
    () => validateContract(original,receipt,{readRevisionBytes:revisionRead(revisions)}),
    /stale frozen source bytes/,
  );

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

test('retained CMS delta is the exact complete-document comparison', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'validate-ar-c0-cms-'));
  const beforeName = 'consumer-module-standard.md';
  const afterName = 'common-assembly-ac49bb33.md';
  try {
    writeFileSync(join(cwd,beforeName), revisionRead()(expectedBase,original.cms.before.evidencePath));
    writeFileSync(join(cwd,afterName), read(original.cms.after.evidencePath));
    const compared = spawnSync('git', [
      'diff', '--no-index', '--abbrev=7', '--unified=2',
      '--src-prefix=retained/architecture/get-modular/evidence/',
      '--dst-prefix=upstream/architecture/c0/ar-owned-lifetime/evidence/',
      beforeName, afterName,
    ], {cwd});
    assert.equal(compared.status, 1, 'expected the reviewed reciprocal-reference delta');
    assert.equal(compared.stdout.toString().replace(/^ +$/gmu, ''), read(original.cms.deltaPath).toString(), 'retained CMS diff differs from the pinned document comparison');
  } finally {rmSync(cwd, {recursive:true, force:true});}
});
