import assert from 'node:assert/strict';
import {standardReviewPath, standardDeltaPath, validateStandardMigration} from './consumer-module-standard-pin.mjs';

// Rebased enrollment 712a retains the five exact artifact bytes from 417126.
const acceptedSdkEnrollment = Object.freeze({
  revision: '712a3e38ac9a561e33eb1563608ca4416190ab17',
  profiles: [
    'architecture/get-modular/consumer-profile.json',
    'architecture/consumer-module-standard/contained-turn-profile.json',
  ],
  extension: {
    profile: 'architecture/sdk-growth/profile.yaml',
    activation: 'architecture/sdk-growth/activation.json',
    status: 'pending-authority-qualification',
    compositionChange: false,
  },
  qualification: 'architecture/sdk-growth/qualification.json',
  artifactSha256: {
    'architecture/sdk-growth/profile.yaml': 'c78e89ca5457a68a13d558fe67269d6e42a5f6da827e5efcc70c3c4149e6504d',
    'architecture/sdk-growth/activation.json': '11bd472596f85e3aa0ff8299af2c7f61f5d8db8d2a377aac81228c964fae910a',
    'architecture/sdk-growth/qualification.json': 'f86d376f01881ce902090edda04feb6a05111e4a5e85b30dcfce3c3830f140fa',
  },
});
const acceptedCmsAuthority = Object.freeze({
  activeProfile: 'architecture/get-modular/consumer-profile.json',
  pendingProfile: 'architecture/consumer-module-standard/contained-turn-profile.json',
  currentStandard: {
    repository: 'agent-teams-ai/get-modular',
    path: 'docs/architecture/common-assembly.md',
    anchor: 'consumer-module-standard',
    decision: 'ADR-0026',
    commit: 'ac49bb3374946330ec820591f8195a22d2c90900',
    sha256: 'd5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f',
    evidencePath: 'architecture/get-modular/evidence/consumer-module-standard.md',
  },
  currentPendingAuthority: {
    repository: 'agent-teams-ai/get-modular',
    path: 'docs/architecture/common-assembly.md',
    anchor: 'consumer-module-standard',
    gitCommit: 'ac49bb3374946330ec820591f8195a22d2c90900',
    sha256: 'd5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f',
  },
});

export const acceptedA3Revision = acceptedSdkEnrollment.revision;
const canonicalJsonBytes = value => Buffer.from(`${JSON.stringify(value,null,2)}\n`);
const nonDelegatedActiveProfile = profile => {
  const projected = structuredClone(profile);
  delete projected.standard;
  for (const boundary of projected.boundaries) {delete boundary.relationships;}
  return projected;
};
const nonCmsPendingProfile = profile => {
  const projected = structuredClone(profile);
  delete projected.authority.consumerModuleStandard;
  return projected;
};

// C0 owns the frozen base and the exact historical SDK-enrollment transition.
// Current adoption slots evolve only through reviewed migrations. The ordinary
// scope adds exactly one reviewed creation-error composition dependency; every
// other field and unrelated profile remains byte-for-byte frozen here.
export function validateProfileMigrations(c, context) {
  const {baseRevision, readCurrentBytes, readRevisionBytes, sha256} = context;
  const changed = [];
  for (const record of c.inventory.profiles) {
    const retainedBytes = readRevisionBytes(baseRevision, record.path);
    assert.equal(sha256(retainedBytes), record.sha256, `retained C0 profile digest: ${record.path}`);
    const retained = JSON.parse(retainedBytes);
    assert.equal(retained.status, record.status, `retained C0 profile status: ${record.path}`);

    const acceptedBytes = readRevisionBytes(acceptedSdkEnrollment.revision, record.path);
    if (acceptedSdkEnrollment.profiles.includes(record.path)) {
      const expected = {...retained, sdkGrowth: acceptedSdkEnrollment.extension};
      assert.ok(
        Buffer.from(acceptedBytes).equals(canonicalJsonBytes(expected)),
        `accepted r117 SDK profile drift: ${record.path}`,
      );
      changed.push(record.path);
    } else {
      assert.ok(
        Buffer.from(acceptedBytes).equals(Buffer.from(retainedBytes)),
        `unreviewed r117 profile migration: ${record.path}`,
      );
      if (record.path === 'architecture/feature-module-standard/ordinary-scope.json') {
        const expected = structuredClone(retained);
        const priorEdge = expected.compositionDependencies.findIndex(edge =>
          edge.from === 'packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts'
          && edge.to === 'packages/apps/embedded-runtime/src/composition/agent-runtime-host.ts'
          && edge.kind === 'type');
        assert.ok(priorEdge >= 0, 'retained ordinary Host dependency missing');
        expected.compositionDependencies.splice(priorEdge + 1, 0, {
          from: 'packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts',
          to: 'packages/apps/embedded-runtime/src/composition/agent-runtime-host-creation-error.ts',
          kind: 'runtime',
        });
        assert.ok(Buffer.from(readCurrentBytes(record.path)).equals(canonicalJsonBytes(expected)),
          'current ordinary profile differs from the reviewed creation-cleanup dependency');
      } else {
        assert.ok(
          Buffer.from(readCurrentBytes(record.path)).equals(Buffer.from(retainedBytes)),
          `unrelated frozen profile changed: ${record.path}`,
        );
      }
    }
  }
  assert.deepEqual(changed, acceptedSdkEnrollment.profiles, 'accepted r117 SDK profile migration set drift');

  const artifactPaths = [
    acceptedSdkEnrollment.extension.profile,
    acceptedSdkEnrollment.extension.activation,
    acceptedSdkEnrollment.qualification,
  ];
  const acceptedArtifacts = new Map(artifactPaths.map(path => [path, readRevisionBytes(acceptedSdkEnrollment.revision, path)]));
  for (const [path, bytes] of acceptedArtifacts) {
    assert.equal(sha256(bytes), acceptedSdkEnrollment.artifactSha256[path], `accepted r117 SDK artifact drift: ${path}`);
  }
  const activation = JSON.parse(acceptedArtifacts.get(acceptedSdkEnrollment.extension.activation));
  const qualification = JSON.parse(acceptedArtifacts.get(acceptedSdkEnrollment.qualification));
  assert.equal(activation.schemaVersion, 1, 'accepted r117 activation schema drift');
  assert.equal(activation.contractRevision, c.contractRevision, 'accepted r117 C0 contract binding drift');
  assert.equal(activation.profile, acceptedSdkEnrollment.extension.profile, 'accepted r117 profile binding drift');
  assert.equal(activation.status, acceptedSdkEnrollment.extension.status, 'accepted r117 activation status drift');
  assert.equal(activation.authority.candidateWorkflowIsAuthority, false, 'candidate r117 workflow cannot qualify itself');
  assert.deepEqual(activation.packageQualification, {
    status: 'passed-membership-and-imports',
    evidencePath: acceptedSdkEnrollment.qualification,
    cleanRegistryInstall: true,
  }, 'accepted r117 package qualification binding drift');
  assert.equal(activation.sdkAdmission.releaseEligible, false, 'r117 profile migration cannot grant SDK admission');
  assert.equal(qualification.qualification, 'package-membership-and-public-imports', 'accepted r117 qualification kind drift');
  assert.equal(qualification.packagesDeterministic, true, 'accepted r117 package qualification is not deterministic');
  assert.equal(qualification.releaseEligible, false, 'r117 package qualification cannot grant SDK admission');
  return changed;
}

// C0 authenticates only the CMS authority slots in the two evolving profiles.
// Whole-profile census, relationship, and SDK assertions stay with their
// independent current-state gates and do not become a C0 wildcard allowlist.
export function validateCmsProfileTransition(c, context) {
  const {readCurrentBytes, readRevisionBytes} = context;
  const {activeProfile, pendingProfile} = acceptedCmsAuthority;
  assert.deepEqual([activeProfile, pendingProfile], acceptedSdkEnrollment.profiles, 'CMS authority profile set drift');
  assert.equal(c.cms.activeProfile, activeProfile, 'CMS active profile drift');

  const activeAtEnrollment = JSON.parse(readRevisionBytes(acceptedSdkEnrollment.revision, activeProfile));
  assert.deepEqual(activeAtEnrollment.standard, c.cms.before, 'CMS active predecessor is not frozen C0 authority');
  const review = JSON.parse(readCurrentBytes(standardReviewPath));
  validateStandardMigration(review, readCurrentBytes(standardDeltaPath));
  assert.equal(review.before.commit, c.cms.after.commit, 'current CMS migration predecessor commit drift');
  assert.equal(review.before.sha256, c.cms.after.sha256, 'current CMS migration predecessor digest drift');
  const currentActive = JSON.parse(readCurrentBytes(activeProfile));
  assert.deepEqual(currentActive.standard, {
    ...acceptedCmsAuthority.currentStandard,
    commit: review.after.commit,
    sha256: review.after.sha256,
  }, 'current active CMS authority drift');
  assert.deepEqual(
    nonDelegatedActiveProfile(currentActive),
    nonDelegatedActiveProfile(activeAtEnrollment),
    'current active profile changed outside delegated CMS and source relationships',
  );

  const pendingAtEnrollment = JSON.parse(readRevisionBytes(acceptedSdkEnrollment.revision, pendingProfile));
  const expectedPendingPredecessor = {
    ...acceptedCmsAuthority.currentPendingAuthority,
    gitCommit: c.cms.before.commit,
    sha256: c.cms.before.sha256,
  };
  assert.deepEqual(
    pendingAtEnrollment.authority.consumerModuleStandard,
    expectedPendingPredecessor,
    'CMS pending predecessor is not frozen C0 authority',
  );
  const currentPending = JSON.parse(readCurrentBytes(pendingProfile));
  assert.deepEqual(
    currentPending.authority.consumerModuleStandard,
    {...acceptedCmsAuthority.currentPendingAuthority, gitCommit: review.after.commit, sha256: review.after.sha256},
    'current pending CMS authority drift',
  );
  assert.deepEqual(
    nonCmsPendingProfile(currentPending),
    nonCmsPendingProfile(pendingAtEnrollment),
    'current pending profile changed outside delegated CMS authority',
  );
  return [activeProfile, pendingProfile];
}
