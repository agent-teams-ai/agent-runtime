import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {v2InputPolicy} from './runtime-setup-l0-evidence-v2-inputs.mjs';

export const base = 'c0dc683ecb14760c75a69283ad7ec312f6246a63';
export const delivery = '510882870c1a7c628187dd91d7dff05225068bdb';
export const planHash = 'e025978dcf3cfac12b7795fa3aafc96f06838620e124df4cc091ebee45352864';
export const artifact = 'architecture/c0/ar-owned-lifetime/contract.json';
export const ciWorkflow = '.github/workflows/ar-c0.yml';
export const ciWorkflowHash = '40b09599e6fab490d989ed7894b2a83be5c31ff1435db36d2554bd0071e07cad';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFileSync(resolve(root, path));
export const createGit = cwd => (...args) => {
  const output = execFileSync('git', args, {cwd, encoding: 'utf8'});
  return args.includes('-z') ? output : output.trim();
};
const git = createGit(root);
const json = path => JSON.parse(read(path));
const requireText = (value, label) => assert.ok(typeof value === 'string' && value.trim().length > 0, `missing ${label}`);

// Frozen review oracle: never derive required coverage from candidate receipts.
const requiredEvidence = {
  "attempt": "packages/apps/embedded-runtime/src/composition/default-agent-runtime-host.ts",
  "assembly": "packages/apps/embedded-runtime/src/composition/runtime-setup-assembly.ts",
  "host": "packages/apps/embedded-runtime/src/composition/agent-runtime-host.ts",
  "lifecycle": "packages/apps/embedded-runtime/src/composition/agent-runtime-host-disposal.ts",
  "creationError": "packages/apps/embedded-runtime/src/composition/agent-runtime-host-creation-error.ts",
  "ordinaryHost": "packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts",
  "ordinaryAssembly": "packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts",
  "acl": "packages/apps/embedded-runtime/src/features/ordinary-session-runtime/adapters/ordinary-owner-acl.ts",
  "journal": "packages/apps/embedded-runtime/src/features/ordinary-session-runtime/adapters/ordinary-observation-journal.ts",
  "engine": "packages/contexts/agent-execution/src/features/contained-agent-turn/application/ordinary-engine.ts",
  "process": "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-process/node-ordinary-process.ts",
  "workspace": "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-filesystem/node-ordinary-workspace.ts",
  "artifacts": "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-filesystem/node-ordinary-artifacts.ts",
  "codex": "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-codex/ordinary-codex-provider.ts",
  "protocol": "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-codex/ordinary-codex-protocol.ts",
  "operationStore": "packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.ts",
  "pa": "packages/contexts/provider-access/src/features/contained-turn-access/composition/ordinary-provider-access-owner.ts",
  "broker": "packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/ordinary-pa-broker.ts",
  "capture": "packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-capture.ts",
  "ipc": "packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-ipc.ts",
  "authFiles": "packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-files.ts",
  "paTransactions": "packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-transactions.ts",
  "security": "packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/adapters/outbound/postgres/ordinary-security-owner.ts",
  "securityTransactions": "packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/adapters/outbound/postgres/ordinary-security-transactions.ts",
  "assemblyTests": "packages/apps/embedded-runtime/tests/package/runtime-setup-assembly.test.ts",
  "hostTests": "packages/apps/embedded-runtime/tests/package/ordinary-host-disposal.test.ts",
  "disposalTests": "packages/apps/embedded-runtime/tests/package/agent-runtime-host-disposal.unit.test.ts",
  "retryTests": "packages/apps/embedded-runtime/tests/package/ordinary-host-ownership.fixture.ts",
  "publicEntry": "packages/apps/embedded-runtime/src/composition.ts",
  "publicApiTests": "packages/apps/embedded-runtime/tests/package/public-api.test.ts"
};
const requiredProfiles = [
  {
    "path": "architecture/get-modular/consumer-profile.json",
    "sha256": "87ab638571476971a32196220b3ca9b641d92e38c6814e538cda92e47b05debc",
    "status": "active"
  },
  {
    "path": "architecture/feature-module-standard/candidate-profile.json",
    "sha256": "8e644e832bedf1553a6632aaf809e5b7bbc144fbb27042b4e9dadd21c0d3bccb",
    "status": "active"
  },
  {
    "path": "architecture/feature-module-standard/ordinary-scope.json",
    "sha256": "d183ef1f809c945c2e7f0e47c695a16f825400176b5ae313f0cfb86cfed30fdf",
    "status": "active"
  },
  {
    "path": "architecture/consumer-module-standard/contained-turn-profile.json",
    "sha256": "a53a648f1ba80928e568c20fb7d4fb11ea11ef38f4cff7daeea908d6d818cf5f",
    "status": "pending"
  }
];
const requiredArchives = [
  {
    "name": "@get-modular/core",
    "version": "0.1.0",
    "archiveSha256": "50803ea69e2fb4078013a897f858908b4d73d26296336ab155a6118809dfb8ba",
    "archivePath": "architecture/get-modular/evidence/get-modular-core-0.1.0.tgz"
  },
  {
    "name": "@get-modular/assembly",
    "version": "0.1.0",
    "archiveSha256": "e89207171e44afd5e813aa5e7a0db8abc999b42338559d38b44b4db71da228ab",
    "archivePath": "architecture/get-modular/evidence/get-modular-assembly-0.1.0.tgz"
  }
];
const fixedIdentity = {
  "planPath": "architecture/c0/ar-owned-lifetime/evidence/sdk-and-owned-lifetime-implementation-plan.md",
  "qualityStandardPath": "architecture/c0/ar-owned-lifetime/evidence/engineering-quality-standard.md",
  "qualityStandardSha256": "8346f1a448f2c1afc0ee7b0aded338d1894f893c763836a17b79422515077d8b",
  "cms": {
    "activeProfile": "architecture/get-modular/consumer-profile.json",
    "before": {
      "repository": "agent-teams-ai/get-modular",
      "path": "docs/architecture/common-assembly.md",
      "anchor": "consumer-module-standard",
      "decision": "ADR-0026",
      "commit": "669a750d8db451e04f075cdeb36576c6606fba6e",
      "sha256": "e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553",
      "evidencePath": "architecture/get-modular/evidence/consumer-module-standard.md"
    },
    "after": {
      "commit": "ac49bb3374946330ec820591f8195a22d2c90900",
      "path": "docs/architecture/common-assembly.md",
      "evidencePath": "architecture/c0/ar-owned-lifetime/evidence/common-assembly-ac49bb33.md",
      "sha256": "d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f"
    },
    "deltaPath": "architecture/c0/ar-owned-lifetime/evidence/cms-delta.diff",
    "deltaSha256": "9bcc228419f21a0fb88e3d2e13a667730831f8401821833e31d6187e45ba2990"
  },
  "lock": {
    "path": "pnpm-lock.yaml",
    "sha256": "36c76b697a31fa2d7b6f37a5fd4316f78a571c45b54b3833623e66cc4ddd8513"
  },
  "workspace": {
    "path": "pnpm-workspace.yaml",
    "sha256": "6a34544c1956e2f9cafb6c8c761597e20e07a267f984845baab08d6742368819",
    "packageRoots": [
      {
        "name": "@agent-teams/embedded-runtime",
        "root": "packages/apps/embedded-runtime"
      },
      {
        "name": "@agent-teams/agent-execution",
        "root": "packages/contexts/agent-execution"
      },
      {
        "name": "@agent-teams/provider-access",
        "root": "packages/contexts/provider-access"
      },
      {
        "name": "@agent-teams/runtime-configuration",
        "root": "packages/contexts/runtime-configuration"
      },
      {
        "name": "@agent-teams/runtime-security",
        "root": "packages/contexts/runtime-security"
      },
      {
        "name": "@agent-teams/filesystem-custody",
        "root": "packages/platform/filesystem-custody"
      }
    ],
    "experimentalPackages": []
  },
  "workflow": {
    "workflow": ".github/workflows/ci.yml",
    "sha256": "79a3d062c473cdd4a3188cdc8da27e7de33d6b64e847e885047ba0dbcadfe9f4"
  }
};
// The immutable base, not candidate hashes or receipts, owns repository identities.
const baseCache = new Map();
const baseBytes = path => {
  if (!baseCache.has(path)) {baseCache.set(path, execFileSync('git',['show',`${base}:${path}`],{cwd:root}));}
  return baseCache.get(path);
};
const supportedVerdicts = {
  "K1": "blocked",
  "A1": "blocked",
  "A2": "blocked",
  "ARSourceInventory": "go",
  "SDKActivation": "blocked",
  "CMSComparison": "blocked",
  "C0Freeze": "go"
};
const allowedChanges = [
  "architecture/c0/ar-owned-lifetime/evidence/sdk-and-owned-lifetime-implementation-plan.md",
  "architecture/c0/ar-owned-lifetime/evidence/engineering-quality-standard.md",
  "package.json",
  "scripts/architecture/validate-ar-c0.mjs",
  "scripts/architecture/validate-ar-c0.test.mjs",
  "architecture/c0/ar-owned-lifetime/contract.json",
  "architecture/c0/ar-owned-lifetime/contract.schema.json",
  "architecture/c0/ar-owned-lifetime/identity.json",
  "architecture/c0/ar-owned-lifetime/evidence/cms-delta.diff",
  "architecture/c0/ar-owned-lifetime/evidence/common-assembly-ac49bb33.md"
];

const lines = value => value.split('\n').filter(Boolean);
const pathLines = value => value.split('\0').filter(Boolean);

const requireCommit = (runGit, revision, label) => {
  assert.match(revision, /^[0-9a-f]{40}$/u, `invalid C0 ${label} SHA`);
  let resolved;
  try {resolved = runGit('rev-parse', '--verify', `${revision}^{commit}`);}
  catch {assert.fail(`missing C0 ${label} commit: ${revision}`);}
  assert.equal(resolved, revision, `C0 ${label} did not resolve to its fixed commit`);
};

export function validateDeliveryRange({runGit = git, baseCommit = base, deliveryCommit = delivery, allowedPaths = allowedChanges} = {}) {
  requireCommit(runGit, baseCommit, 'base');
  requireCommit(runGit, deliveryCommit, 'delivery');
  try {runGit('merge-base', '--is-ancestor', baseCommit, deliveryCommit);}
  catch {assert.fail('C0 delivery is not a descendant of its base');}
  const commits = lines(runGit('rev-list', '--reverse', '--topo-order', `${baseCommit}..${deliveryCommit}`));
  assert.ok(commits.includes(deliveryCommit), 'C0 delivery range is empty or incomplete');
  const changed = commits.flatMap(commit => pathLines(runGit('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--no-renames', '-m', '-z', commit)));
  for (const path of changed) {assert.ok(allowedPaths.includes(path), `forbidden C0 edit: ${path}`);}
  return changed;
}

export function validateIndependentCi({readBytes = read, inputPolicy = v2InputPolicy} = {}) {
  const protectedByRuntimeEvidence = inputPolicy.files.includes(ciWorkflow)
    || inputPolicy.roots.some(path => ciWorkflow === path || ciWorkflow.startsWith(`${path}/`));
  assert.equal(protectedByRuntimeEvidence, false, 'C0 CI workflow is a protected runtime evidence input');
  assert.equal(sha256(readBytes(ciWorkflow)), ciWorkflowHash, 'C0 CI workflow bytes drift');
}

// This deliberately validates retained C0 evidence, never executes runtime code.
// Expected admissions are independently derived from the rebased c0dc683 review.
export function validateContract(c, receipt, {readBytes = read} = {}) {
  assert.equal(c.schemaVersion, 1, 'unsupported C0 schema revision');
  for (const key of ['planPath','qualityStandardPath','qualityStandardSha256']) {assert.equal(c.source[key], fixedIdentity[key], `fixed source identity: ${key}`);}
  for (const [key,value] of Object.entries(fixedIdentity.cms)) {assert.deepEqual(c.cms[key], value, `fixed CMS identity: ${key}; active authority`);}
  assert.deepEqual(c.inventory.lock, fixedIdentity.lock, 'fixed lock identity');
  assert.deepEqual(c.inventory.workspace, fixedIdentity.workspace, 'fixed workspace identity');
  for (const [key,value] of Object.entries(fixedIdentity.workflow)) {assert.equal(c.ci[key], value, `fixed workflow identity: ${key}`);}
  const manifests = git('ls-tree','-r','--name-only',base).split('\n').filter(p => p === 'package.json' || /^packages\/[^/]+\/[^/]+\/package\.json$/u.test(p));
  assert.deepEqual(c.inventory.packages.map(p => p.manifest), manifests, 'fixed package identities: missing package');
  for (const p of c.inventory.packages) {assert.equal(p.sha256, sha256(baseBytes(p.manifest)), 'fixed package digest');}

  assert.deepEqual(Object.keys(c.verdicts).toSorted(), Object.keys(supportedVerdicts).toSorted(), 'unknown or missing verdict');
  for (const [key, result] of Object.entries(supportedVerdicts)) {
    assert.equal(c.verdicts[key].result, result, `false ${key} admission; retained comparison is not current upstream proof`);
    assert.deepEqual(Object.keys(c.verdicts[key]).toSorted(), ['reason', 'result'], 'unknown verdict field');
    requireText(c.verdicts[key].reason, `${key}.reason`);
  }
  // C0Freeze/ARSourceInventory go authorizes facts only. SDK activation stays
  // blocked; A3 is not a supported verdict or an alias that can authorize it.
  assert.deepEqual(Object.keys(c.evidence).toSorted(), Object.keys(requiredEvidence).toSorted(), 'required evidence completeness');
  const paths = Object.values(c.evidence).map(record => record.path);
  assert.equal(new Set(paths).size, paths.length, 'duplicate evidence paths');
  for (const [key, path] of Object.entries(requiredEvidence)) {
    assert.equal(c.evidence[key].path, path, `required evidence path: ${key}`);
    assert.equal(c.evidence[key].sha256, sha256(baseBytes(path)), `fixed evidence digest: ${key}`);
  }
  assert.deepEqual(c.inventory.profiles, requiredProfiles, 'required profile records');
  assert.deepEqual(c.inventory.archives, requiredArchives, 'required archive records');

  assert.equal(c.source.detached, false, 'rebased source is a branch checkpoint');
  assert.equal(c.source.repository, 'agent-teams-ai/agent-runtime');
  assert.equal(c.source.commit, base, 'stale source identity');
  assert.equal(c.source.tree, '54a5f3755c4f93335e240a8ce8bdf1c55af5bb89');
  assert.equal(c.source.planSha256, planHash, 'stale plan identity');
  assert.equal(c.source.planReview.result, 'go');
  assert.equal(c.source.planReview.requiredBytesRead, true, 'final plan review missing');
  assert.equal(c.source.planReview.observedSha256, planHash, 'stale reviewed plan identity');
  assert.equal(sha256(readBytes(c.source.planPath)), c.source.planReview.observedSha256, 'stale observed plan bytes: re-review input');
  assert.equal(sha256(readBytes(c.source.qualityStandardPath)), c.source.qualityStandardSha256);
  assert.equal(c.contractRevision, 'ar-c0-c0dc683e-r3');
  assert.equal(c.status, 'frozen-c0-only', 'active before code');
  assert.equal(c.delivery.newAdoptions, 'pending', 'active before code');
  assert.equal(receipt.contractRevision, c.contractRevision);
  assert.equal(receipt.sourceCommit, base);
  assert.equal(receipt.planSha256, planHash);
  assert.equal(receipt.artifact, artifact);
  assert.equal(receipt.status, c.status);
  assert.deepEqual(receipt.allowedConsumers, c.allowedConsumers);
  assert.deepEqual(c.allowedConsumers, ['AR C0 validation and orchestrator review','EF S1 surface-matrix input (AR facts only)','AR A3 SDK planning (activation pending)'], 'blocked lanes are not allowed consumers');
  assert.equal(c.verdicts.C0Freeze.result, 'go');
  assert.equal(c.verdicts.CMSComparison.result, 'blocked', 'retained comparison is not current upstream proof');
  assert.equal(c.verdicts.ARSourceInventory.result, 'go');
  assert.equal(c.verdicts.SDKActivation.result, 'blocked');
  assert.deepEqual(c.ownership.conditionalConstraints.A2Prerequisites, ['K1','A1'], 'A2 requires admitted K1/A1');
  const constraints = {
    ARLocalDuplicateAllowed: false,
    genericTransitions: 'synchronous',
    genericFailureChannel: 'one discriminated result',
    rawCauseOwner: 'AR resource/effect owner',
    handoffCommit: 'one synchronous ownership commit',
    rawFlightPublication: 'publish joinable deferred raw flight before cleanup effect',
    observerOrdering: 'settle state before observers',
    coordinator: 'fixed Host-local coordinator',
    diagnosticIdentity: 'stable actionId',
  };
  for (const [key,value] of Object.entries(constraints)) {assert.equal(c.ownership.conditionalConstraints[key], value, `operator constraint ${key}`);}
  assert.equal(c.ci.trustedAnchor.result, 'blocked');
  assert.equal(c.ci.trustedAnchor.verifiedAnchor, null, 'invented external S3 anchor');
  assert.equal(c.ci.trustedAnchor.authorityLocation, 'outside candidate-controlled workflow', 'candidate cannot authorize S3');
  assert.equal(c.ownership.admission, 'blocked', 'false ownership admission');
  assert.equal(c.ownership.requiredDistinctScopes, 2);
  assert.equal(c.ownership.provenDistinctScopes, 1);
  assert.deepEqual(c.ownership.scopeCandidates.map(s => [s.id, s.counted]), [['default-construction', false], ['ordinary-session', true]], 'required distinct scope facts');
  for (const lane of ['K1', 'A1', 'A2']) {assert.equal(c.verdicts[lane].result, 'blocked', `false ${lane} admission`);}
  const debt = c.ownership.constructionAllSettledDebt;
  assert.equal(debt.recoveryOwner, null, 'invented construction recovery owner');
  assert.equal(debt.entrypoint, null, 'inert error is not recovery API');
  assert.equal(debt.verdict, 'blocked');
  const ids = ['construction-host', 'ordinary-flight', 'host-call-drain', 'codex-adapter', 'provider-access-owner', 'security-owner', 'journal', 'borrowed-pool', 'process-reservation', 'operation-grants', 'workspace-artifacts'];
  assert.deepEqual(c.ownership.owners.map(o => o.actionId), ids, 'missing/duplicate owner action');
  for (const o of c.ownership.owners) {
    for (const field of ['scope','acquire','strongRetentionOwner','resourceEffectOwner','handoff','cleanup','rawCompletion','errorPending','retry','recovery']) {requireText(o[field], `${o.actionId}.${field}`);}
    assert.ok(['default-construction', 'ordinary-session'].includes(o.scope));
    assert.ok(o.evidence.length > 0);
    for (const ref of o.evidence) {assert.ok(c.evidence[ref], `unknown evidence ${ref}`);}
    for (const dependency of o.prerequisites) {assert.ok(ids.includes(dependency), 'unknown prerequisite');}
    assert.equal(o.prerequisiteOutcome, o.prerequisites.length > 0 ? 'host-prerequisite-rule' : 'not-applicable', 'missing blocked prerequisite outcome');
  }
  assert.deepEqual(c.ownership.prerequisiteRule, {
    id: 'host-prerequisite-rule', status: 'conditional-future-policy',
    pendingOrUnknown: 'retain dependent pending; no cleanup effect; strong owner remains',
    terminalFailure: 'blocked_by_prerequisite; no cleanup effect; explicit retry only with owner proof',
    success: 'eligible only after every listed prerequisite succeeds; fixed Host-local policy, not GM graph traversal',
  }, 'blocked prerequisite cannot release resources');
  const visit = (id, stack = []) => {
    assert.ok(!stack.includes(id), 'cleanup prerequisite cycle');
    for (const p of c.ownership.owners.find(o => o.actionId === id).prerequisites) {visit(p, [...stack,id]);}
  };
  ids.forEach(id => visit(id));
  assert.equal(c.ownership.owners.find(o => o.actionId === 'borrowed-pool').cleanup, 'NEVER pool.end');
  const w = c.waitPolicy;
  assert.deepEqual(w.path, [
    'ordinaryHost.decorateHost.dispose / Symbol.asyncDispose',
    'Promise.allSettled(host.dispose(), feature.dispose())',
    'raw Host lifecycle.dispose',
    'HostDisposalOrchestrator.dispose -> race(#finishDisposal, #rejectAtDeadline)',
    'HostCallLedger.settle -> disposeOrdinaryOwner -> ordinary-engine.dispose',
    'ordinary ownership release and diagnostics -> outer cleanup only after both observations succeed',
  ], 'complete outer disposer to raw owner path');
  assert.equal(w.currentInnerWaitMs, 1000, 'changed nested timeout assumption');
  assert.equal(w.currentOuterWaitMs, null, 'outer presently unbounded');
  assert.equal(w.proposedOrdinaryWaitMs, 30000);
  assert.equal(w.selectedOrdinaryWaitMs, null, 'unproven timeout policy activation');
  assert.equal(w.wrapInnerFacade, false, 'cannot wrap 1s facade with 30s');
  assert.equal(w.status, 'blocked');
  assert.deepEqual([w.ownerIdentity.sameInstance,w.ownerIdentity.effectOwnerCount,w.ownerIdentity.observationCount,w.ownerIdentity.independentActions], [true,1,2,false], 'same OrdinaryFeature owner flight');
  assert.equal(w.rawSeam.availableNow, false, 'invented raw completion seam');
  assert.equal(w.rawSeam.owner, 'HostDisposalOrchestrator');
  for (const field of ['currentRaw','candidate','signatureCompatibility','behaviorCompatibility','construction']) {requireText(w.rawSeam[field], `rawSeam.${field}`);}
  assert.match(w.rawSeam.behaviorCompatibility, /^unproven:/u);
  assert.equal(w.errorCarrier.outer, 'AggregateError(errors, "ordinary_host_disposal_incomplete", {cause: errors[0]})');
  assert.equal(w.errorCarrier.inner, 'AgentRuntimeHostDisposalIncompleteError');
  assert.deepEqual(w.errorCarrier.innerFields, ['activeCallCount','status','containedTurns','omittedContainedTurnCount']);
  assert.equal(w.errorCarrier.newPublicErrorClass, false);
  const projection = w.errorCarrier.projectionCompatibility;
  assert.equal(projection.result, 'blocked', 'unproven error projection compatibility');
  assert.equal(projection.currentDuplicatesPrimary, true, 'existing aggregate duplicates its primary cause');
  assert.equal(projection.futureSecondaryOrder, 'stable actionId');
  assert.equal(projection.futureDuplicatePrimary, false, 'future aggregate must not duplicate primary');
  const expectedDeadlines = {'host-observer':[1000], 'outer-and-engine':[], 'engine-operation':[60000,10000,15000,45000,250], 'process-close':[1500,1000,1000], 'protocol-read':[], 'pa-broker-close':[5000], 'pa-broker-http':[15000,5000], 'pa-capture':[60000,15000,1500], 'pa-helper-close':[1000,500,300,20], 'pa-db':[2000,5000,10000], 'ae-db':[5000,3000,10000], 'rs-db':[10000,5000], 'filesystem-and-pool':[]};
  assert.deepEqual(Object.fromEntries(w.deadlines.map(d => [d.id,d.milliseconds])), expectedDeadlines, 'nested deadline census');
  assert.equal(w.deadlines.length, Object.keys(expectedDeadlines).length);
  for (const d of w.deadlines) {assert.ok(c.evidence[d.evidence]);}
  validateContractBytes(c, readBytes);
  return true;
}

function validateContractBytes(c, readBytes) {
  for (const record of Object.values(c.evidence)) {assert.equal(sha256(readBytes(record.path)), record.sha256, `stale source bytes: ${record.path}`);}
  for (const p of c.inventory.profiles) {
    assert.equal(sha256(readBytes(p.path)), p.sha256, 'profile changed before adoption');
    assert.equal(JSON.parse(readBytes(p.path)).status, p.status);
  }
  const cms = c.cms, active = JSON.parse(readBytes(cms.activeProfile));
  assert.deepEqual(cms.before, active.standard, 'historical pin mistaken for active authority');
  assert.equal(cms.before.commit, '669a750d8db451e04f075cdeb36576c6606fba6e');
  assert.equal(cms.after.commit, 'ac49bb3374946330ec820591f8195a22d2c90900');
  for (const version of [cms.before,cms.after]) {assert.equal(sha256(readBytes(version.evidencePath)), version.sha256, 'CMS complete bytes drift');}
  assert.equal(cms.after.sha256, 'd5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f');
  assert.equal(cms.fullDocumentBytesEqual, false, 'false CMS byte no-op');
  assert.match(cms.normativeContractDelta, /^no-op:/u);
  assert.equal(cms.upstreamFreshness, "observed: upstream main 610e595fe1f2e893d01ee44ceecd6349b5a3c8ce on 2026-09-16; exact common-assembly.md SHA-256 d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f equals retained ac49bb33 bytes. Active 669a750d pin migration remains pending; no adoption activation.", 'unproven live upstream claim');
  assert.equal(sha256(readBytes(cms.deltaPath)), cms.deltaSha256);
  for (const item of [c.inventory.lock,c.inventory.workspace,...c.inventory.archives.map(a => ({path:a.archivePath,sha256:a.archiveSha256})),c.ci]) {assert.equal(sha256(readBytes(item.path ?? item.workflow)), item.sha256);}
  assert.equal(c.inventory.packages.length, 7, 'missing package');
  for (const p of c.inventory.packages) {
    assert.equal(p.activation, 'pending', 'SDK active before qualified observer');
    const m = JSON.parse(readBytes(p.manifest));
    for (const key of ['name','version','private','exports','main','types','bin']) {assert.deepEqual(m[key] ?? null, p[key], `stale package surface ${p.name}.${key}`);}
    assert.equal(JSON.stringify(m.exports ?? null), JSON.stringify(p.exports), 'ordered export map differs from source');
    assert.deepEqual(m.files ?? [], p.files);
    assert.equal(JSON.stringify(p.branches.map(b => [b.subpath,b.resolutionTree])), JSON.stringify(Object.entries(p.exports ?? {})), 'missing or changed ordered export branches');
    for (const branch of p.branches) {assert.equal(branch.coverage, 'incomplete');}
  }
}

// Closed, bounded JSON Schema subset used for this static evidence format only.
export function validateSchema(value, schema, label = 'contract') {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    assert.ok(types.includes(type), `${label}: expected ${types}, got ${type}`);
  }
  if (schema.enum) {assert.ok(schema.enum.includes(value), `${label}: invalid enum`);}
  if (schema.required) {for (const key of schema.required) {assert.ok(Object.hasOwn(value,key), `${label}: missing ${key}`);}}
  if (schema.properties) {for (const [key, child] of Object.entries(schema.properties)) {if (Object.hasOwn(value,key)) {validateSchema(value[key], child, `${label}.${key}`);}}}
  if (schema.additionalProperties === false) {for (const key of Object.keys(value)) {assert.ok(Object.hasOwn(schema.properties,key), `${label}: unknown ${key}`);}}
  if (schema.items) {value.forEach((item,index) => validateSchema(item,schema.items,`${label}[${index}]`));}
  if (schema.minItems !== undefined) {assert.ok(value.length >= schema.minItems, `${label}: missing items`);}
}

export function validateWorkspaceEvidence() {
  const bytes = read(artifact), c = JSON.parse(bytes), receipt = json('architecture/c0/ar-owned-lifetime/identity.json');
  validateSchema(c,json('architecture/c0/ar-owned-lifetime/contract.schema.json'));
  assert.equal(sha256(bytes), receipt.sha256, 'canonical contract bytes drift');
  assert.equal(bytes.at(-1), 10, 'missing final LF');
  validateContract(c, receipt);
  assert.equal(git('rev-parse', `${base}^{tree}`), c.source.tree, 'retained source tree drift');
  // Current files must still be the exact reviewed source, not just match editable digests.
  for (const e of Object.values(c.evidence)) {assert.equal(sha256(read(e.path)),sha256(execFileSync('git',['show',`${base}:${e.path}`],{cwd:root})), 'source differs from exact base');}
  const manifests = git('ls-tree','-r','--name-only',base).split('\n').filter(p => p === 'package.json' || /^packages\/[^/]+\/[^/]+\/package\.json$/u.test(p));
  assert.deepEqual(c.inventory.packages.map(p => p.manifest), manifests);
  for (const p of c.inventory.packages) {assert.equal(p.sha256,sha256(execFileSync('git',['show',`${base}:${p.manifest}`],{cwd:root})), 'base manifest identity drift');}
  // The immutable delivery range proves the reviewed C0 scope. Later checkout
  // changes are governed by their own checks and cannot rewrite this history.
  validateDeliveryRange();
  const original = JSON.parse(execFileSync('git',['show',`${base}:package.json`],{cwd:root}));
  const delivered = JSON.parse(execFileSync('git',['show',`${delivery}:package.json`],{cwd:root}));
  for (const name of ['check','check:fast']) {
    assert.ok(original.scripts[name].startsWith('pnpm lint && '), 'retained gate no longer starts with lint');
    assert.equal(delivered.scripts[name], original.scripts[name].replace('pnpm lint && ', 'pnpm lint && pnpm test:ar-c0 && '), 'C0 delivery checker wiring drift');
    delivered.scripts[name] = original.scripts[name];
  }
  assert.equal(delivered.scripts['test:ar-c0'],'node scripts/architecture/validate-ar-c0.mjs && node --test scripts/architecture/validate-ar-c0.test.mjs');
  delete delivered.scripts['test:ar-c0'];
  assert.deepEqual(delivered,original,'C0 delivery package changes exceed script wiring');
  validateIndependentCi();
  return {sourceBase:base, sourceTree:c.source.tree, deliveryHead:delivery, candidateHead:git('rev-parse','HEAD'), candidateRef:git('rev-parse','--abbrev-ref','HEAD'), contractRevision:c.contractRevision,sha256:receipt.sha256,verdicts:c.verdicts};
}

// A passing C0 gate authenticates bounded facts and stop evidence, not activation.
export function validateWorkspace() {
  const evidence = validateWorkspaceEvidence();
  const c = json(artifact);
  assert.equal(sha256(read(c.source.planPath)), planHash, 'stale plan bytes: exact e025978d input required before C0 freeze');
  assert.equal(c.status, 'frozen-c0-only', 'C0 draft is not a frozen coding contract');
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(validateWorkspace(),null,2));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
