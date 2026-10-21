import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertPortableCommand, portableFiles } from "./portable-authoring-policy.mts";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const json = async path => JSON.parse(await read(path));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// Reverse only the admitted D library and B compatibility amendments before
// applying the unchanged historical source-policy byte oracles below.
function reverseProviderImplementationAdmission(bytes) {
  const marker = "\n- id: contracts.provider-implementations\n";
  const parts = bytes.split(marker);
  assert.equal(parts.length, 2);
  assert.equal(sha256(marker + parts[1]), "0726474641cd0bf7b8f7f39537035c5c57f23b254f82cac923f275db7b2f00b3");
  bytes = parts[0];
  for (const suffix of ["", "/src", "/tests", "/scripts"]) {
    const line = `- packages/platform/provider-implementations${suffix}\n`;
    assert.equal(bytes.split(line).length - 1, 1);
    bytes = bytes.replace(line, "");
  }
  const replacements = [
    ["    packages:\n    - '@agent-teams/agent-execution'\n    builtins: []\n    runtimeReferences: []\n- id: experiments.interactive-claude-driver\n",
      "    packages: []\n    builtins: []\n    runtimeReferences: []\n- id: experiments.interactive-claude-driver\n"],
    ["    boundaries: []\n    packages:\n    - '@agent-teams/provider-implementations'\n    builtins: []\n",
      "    boundaries:\n    - experiments.interactive-draft-contracts\n    packages:\n    - '@anthropic-ai/claude-agent-sdk'\n    builtins:\n    - node:crypto\n"],
  ];
  for (const [current, previous] of replacements) {
    assert.equal(bytes.split(current).length - 1, 1);
    bytes = bytes.replace(current, previous);
  }
  assert.equal(sha256(bytes), "90f99378a48ba60cb9a5e88eaa99c93c6070b45397c26a976d21d1a3f0b6cba2",
    "retain the exact reviewed C14 source-policy predecessor");
  return bytes;
}
const objectId = (type, bytes) => createHash("sha1")
  .update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest("hex");
const yaml = async path => {
  const document = parseDocument(await read(path), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return document.toJS();
};

test("portable v3 preserves strict Authoring v3 authority and both semantic validators", async () => {
  assert.deepEqual(await yaml("architecture/foundation/docs-protocol.yaml"), {
    schemaVersion: 3,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    foundationProfile: { path: "architecture/foundation/document-authoring.yaml", schemaVersion: 3,
      metadataSidecarPolicy: "foundation-profile-v3-strict-merge" },
    agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
    semanticValidatorIds: ["runtime.documentation-governance", "runtime.qualification-evidence-integrity"],
  });
  const authoring = await yaml("architecture/foundation/document-authoring.yaml");
  assert.equal(authoring.schemaVersion, 3);
  assert.deepEqual(authoring.authoring.artifactTypes.map(({ type }) => type),
    ["index", "architecture", "adr", "evidence", "qualification-plan"]);
});

test("projected direct tooling pins and disabled release-age waiting preserve the package manager", async () => {
  const manifest = await json("package.json"), workspace = await yaml("pnpm-workspace.yaml");
  assert.equal(manifest.packageManager, "pnpm@11.18.0");
  assert.deepEqual(manifest.engines, { node: ">=24.21.0 <25 || >=26.10.0 <27", pnpm: "11.18.0" });
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], "1.7.2");
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol"], "0.6.2");
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol-agent-teams"], "0.3.2");
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.hasOwn(manifest[section] ?? {}, "@agent-teams/docs-protocol-agent-teams"), false);
  }
  const policy = await yaml("architecture/foundation/dependency-declarations.yaml");
  assert.ok(policy.policies.exactRegistryDevelopmentOnlyPackages.includes("@agent-teams/docs-protocol-agent-teams"));
  for (const name of ["docs-protocol-mcp", "document-authoring", "repository-mutation"]) {
    assert.equal(Object.hasOwn(manifest.devDependencies, `@agent-teams/${name}`), false);
  }
  assert.equal(workspace.minimumReleaseAge, 0);
  assert.equal(Object.hasOwn(workspace, "minimumReleaseAgeStrict"), false);
  assert.deepEqual(workspace.minimumReleaseAgeExclude, [
    "@agent-teams/repository-mutation@0.2.2",
    "@agent-teams/document-authoring@0.3.2",
    "@agent-teams/docs-protocol@0.6.2",
    "@agent-teams/docs-protocol-agent-teams@0.3.2",
    "@agent-teams/engineering-foundation@1.7.2",
    "@get-modular/core@0.6.0",
    "@get-modular/assembly@0.6.0",
    "@get-modular/resources@0.2.0",
    "@get-modular/conformance@0.4.0",
    "@anthropic-ai/claude-agent-sdk@0.3.305",
    "@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.305",
    "@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.305",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.305",
    "@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.305",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.305",
    "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.305",
    "@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.305",
    "@anthropic-ai/claude-agent-sdk-win32-x64@0.3.305",
  ]);
  assert.match(await read("scripts/architecture/feature-module-config.mjs"), /const FOUNDATION_VERSION = "1\.7\.2";/u);
});

test("managed Skill remains byte-exact with the selected installed Cohort and semantic gate", async () => {
  const integration = await json("architecture/foundation/docs-consumer-integration.json");
  const skillDigest = `sha256:${createHash("sha256").update(await read(integration.skillPath)).digest("hex")}`;
  assert.equal(skillDigest, integration.cohort.assets.skillDigest);
  const manifest = await json("package.json");
  assert.equal(manifest.scripts["docs:protocol:check"], "pnpm docs:check && pnpm docs:governance");
  assert.equal(manifest.scripts["check:ci:docs"], "pnpm docs:protocol:check && pnpm docs:qualification");
  assert.match(manifest.scripts["check:fast"], /(?:^| && )pnpm docs:protocol:check && pnpm docs:qualification(?: && |$)/u);
});

test("Source Dependencies uses schema v3 with root package and every workspace package", async () => {
  const policy = await yaml("architecture/foundation/source-dependencies.yaml");
  assert.equal(policy.schemaVersion, 3);
  assert.equal(policy.rootPackage, true);
  assert.equal(Object.hasOwn(policy, "includeRootPackage"), false);
  assert.deepEqual(policy.packageRoots, [
    "experiments/interactive-provider-contract",
    "packages/apps/embedded-runtime",
    "packages/contexts/agent-execution",
    "packages/contexts/provider-access",
    "packages/contexts/runtime-configuration",
    "packages/contexts/runtime-security",
    "packages/platform/filesystem-custody",
    "packages/platform/provider-implementations",
  ]);
  assert.deepEqual(policy.governedRoots, [
    "experiments/interactive-provider-contract",
    "packages/platform/filesystem-custody/native",
    "experiments/runtime-profile-behavior",
    "experiments/rust-system-boundaries",
    "experiments/sandbox-backend-hosting",
    "packages/apps/embedded-runtime/src",
    "packages/apps/embedded-runtime/tests",
    "packages/contexts/agent-execution/scripts",
    "packages/contexts/agent-execution/src",
    "packages/contexts/agent-execution/tests",
    "packages/contexts/provider-access/src",
    "packages/contexts/provider-access/tests",
    "packages/contexts/runtime-configuration/src",
    "packages/contexts/runtime-configuration/tests",
    "packages/contexts/runtime-security/src",
    "packages/contexts/runtime-security/tests",
    "packages/platform/filesystem-custody/scripts",
    "packages/platform/filesystem-custody/src",
    "packages/platform/filesystem-custody/tests",
    "scripts/architecture",
    "scripts/sdk-growth-source",
    "scripts/ci",
    "scripts/docs",
    "scripts/foundation",
    "scripts/native-helper",
    "packages/apps/embedded-runtime/scripts",
    "packages/contexts/provider-access/scripts",
    "packages/contexts/runtime-security/scripts",
    "packages/platform/provider-implementations/src",
    "packages/platform/provider-implementations/tests",
    "packages/platform/provider-implementations/scripts",
  ]);
  const source = await read("scripts/architecture/source-dependency-adapter-boundaries.test.mjs");
  assert.doesNotMatch(source, /engineering-foundation\/dist\/capabilities/u);
  assert.match(source, /foundationManifest\.bin\["agent-teams-foundation"\]/u);
  assert.match(source, /"architecture\.source-dependencies", "--consumer", root, "--json"/u);
});

test("provider policy reversal rejects changed ownership and compatibility permissions", async () => {
  const current = await read("architecture/foundation/source-dependencies.yaml");
  const marker = "\n- id: contracts.provider-implementations\n";
  const offset = current.indexOf(marker);
  assert.ok(offset > 0);
  const changedProvider = current.slice(0, offset) + current.slice(offset).replace("node:crypto", "node:child_process");
  assert.notEqual(changedProvider, current);
  const removedRoot = current.replace("- packages/platform/provider-implementations/src\n", "");
  const changedFacade = current.replace("'@agent-teams/provider-implementations'", "'@agent-teams/unadmitted-provider'");
  for (const mutant of [changedProvider, removedRoot, changedFacade]) {
    assert.throws(() => reverseProviderImplementationAdmission(mutant));
  }
});

test("stable31 managed bytes stay exact and the current Foundation source policy retains reviewed scope", async () => {
  const expected = {
    "architecture/foundation/docs-consumer-integration.json": "d6f71aa0f662c7cca716799258430732493229e7deb1d71c8d6d61bcc40f8dd8",
    "architecture/foundation/docs-protocol-managed-state.json": "e359a5dc89e5cc49d4bee0830e686b8f314fd39b564c9dd88d71144e07bed0c6",
    "architecture/foundation/docs-protocol-qualification.json": "1f7e50ec5b0e6ecc991668b83790b2367062240043c4b885c58377855968969b",
    "architecture/foundation/document-authoring.yaml": "d6f5ba4b178e742e122f6711c9d989d52a77768eb68527b0ecdf3c9a9699c6d2",
  };
  for (const [path, digest] of Object.entries(expected)) {
    assert.equal(createHash("sha256").update(await read(path)).digest("hex"), digest, path);
  }
  // Stable28's source-policy receipt remains historical at the exact upgrade base.
  // Current consumer-owned test roots are checked freshly by installed Foundation;
  // the integrated expected-input pin does not relabel any retained Cohort or receipt.
  const historicalSourcePolicy = "073d904b6ed55ac5ae8d0738d2b50762cc65ef653ed647aa28e98b5d574370b0";
  const currentSourcePolicy = createHash("sha256").update(await read("architecture/foundation/source-dependencies.yaml")).digest("hex");
  assert.notEqual(currentSourcePolicy, historicalSourcePolicy);
  // CMS successor adds two roots/one public entry; nightly adds two private roots; product fanout adds five private roots; Darwin adds two private feature-local helpers.
  // Reconstruct the prior CI policy, retaining its fixed whole-document oracle.
  // Get Modular train 1 (AR-1c) admits resources and conformance; reverse only these lines.
  const getModularAdditions = ["    - '@get-modular/resources'\n", "    - '@get-modular/conformance'\n"];
  // ADR-0091 admits only these exact C policy insertions. Reconstruct a reviewed predecessor before every historic reversal.
  // Longest groups retire complete new boundaries first; no prior line or historical digest is replaced.
  const interactivePolicyAdditions = [
    [
      "- id: core.embedded-runtime.interactive-host\n  dependencyMode: runtime\n  roots:\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/domain\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/application\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/contracts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/index.ts\n  entrypoints:\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/domain/session-host.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/index.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/contracts/interactive-session-host.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/application/ports/outbound/interactive-host-ports.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/application/use-cases/create-session-host.ts\n  allow:\n    boundaries: []\n    packages: []\n    builtins: []\n    runtimeReferences: []\n- id: adapter.embedded-runtime.interactive-host\n  dependencyMode: runtime\n  roots:\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/adapters\n  entrypoints:\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/adapters/outbound/agent-execution-session.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/adapters/outbound/provider-generation-fence.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/adapters/outbound/directory-host-ownership.ts\n  allow:\n    boundaries:\n    - core.embedded-runtime.interactive-host\n    packages:\n    - '@agent-teams/agent-execution'\n    - \"@agent-teams/filesystem-custody\"\n    builtins:\n    - node:fs\n    - node:fs/promises\n    runtimeReferences: []\n- id: composition.embedded-runtime.interactive-host-feature\n  dependencyMode: runtime\n  roots:\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/composition\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/internal.ts\n  entrypoints:\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/internal.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/composition/host.module.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/composition/interactive-session-runtime.contracts.ts\n  - packages/apps/embedded-runtime/src/features/interactive-session-runtime/composition/interactive-session-runtime.inputs.ts\n  allow:\n    boundaries:\n    - core.embedded-runtime.interactive-host\n    - adapter.embedded-runtime.interactive-host\n    packages:\n    - \"@agent-teams/agent-execution\"\n    - \"@get-modular/assembly\"\n    - \"@get-modular/core\"\n    - \"@get-modular/resources\"\n    builtins: []\n    runtimeReferences: []\n",
      1
    ],
    [
      "- id: core.agent-execution.interactive-session\n  dependencyMode: runtime\n  roots:\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/application\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/contracts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/domain\n  entrypoints:\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/application/ports/outbound/interactive-provider-driver.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/application/ports/outbound/interactive-session-ports.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/application/use-cases/interactive-session-owner.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/application/use-cases/normalize-provider-event.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/application/use-cases/session-mutation.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/contracts/interactive-provider-driver.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/contracts/interactive-session.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/domain/session.ts\n  allow:\n    boundaries: []\n    packages: []\n    builtins: []\n    runtimeReferences: []\n- id: adapter.agent-execution.interactive-postgres\n  dependencyMode: runtime\n  roots:\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/adapters\n  entrypoints:\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/adapters/outbound/postgres-session-store.ts\n  allow:\n    boundaries: [core.agent-execution.interactive-session]\n    packages: [pg]\n    builtins: []\n    runtimeReferences: []\n- id: composition.agent-execution.interactive-session\n  dependencyMode: runtime\n  roots:\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/composition\n  entrypoints:\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/composition/interactive-session-factory.ts\n  allow:\n    boundaries: [core.agent-execution.interactive-session]\n    packages: []\n    builtins: []\n    runtimeReferences: []\n",
      1
    ],
    [
      "  - packages/contexts/agent-execution/src/features/interactive-agent-session/index.ts\n  - packages/contexts/agent-execution/src/features/interactive-agent-session/internal.ts\n  - packages/contexts/agent-execution/src/interactive-contracts.ts\n",
      1
    ],
    [
      "  - packages/apps/embedded-runtime/src/composition/interactive-session-host.ts\n  - packages/apps/embedded-runtime/src/composition/interactive-session-host.root.ts\n",
      2
    ],
    [
      "    - core.embedded-runtime.interactive-host\n    - adapter.embedded-runtime.interactive-host\n    - composition.embedded-runtime.interactive-host-feature\n",
      1
    ],
    [
      "    - core.agent-execution.interactive-session\n    - adapter.agent-execution.interactive-postgres\n    - composition.agent-execution.interactive-session\n",
      2
    ],
    [
      "  - packages/contexts/agent-execution/src/interactive-contracts.ts\n",
      1
    ],
    [
      "    - composition.embedded-runtime.interactive-host-feature\n",
      1
    ],
    [
      "    - core.embedded-runtime.interactive-host\n",
      1
    ],
    [
      "  - ./interactive-contracts\n",
      1
    ]
  ];
  let currentSourcePolicyBytes = reverseProviderImplementationAdmission(await read("architecture/foundation/source-dependencies.yaml"));
  for (const [text, count] of interactivePolicyAdditions) {
    assert.equal(currentSourcePolicyBytes.split(text).length - 1, count, "exact admitted interactive SourcePolicy insertion");
    currentSourcePolicyBytes = currentSourcePolicyBytes.replaceAll(text, "");
  }
  // These are exact efd3348f and merged B/6feffbec policy bytes; later policy drift still fails closed.
  assert.ok(new Set(["1b75095144867b2a9fd2bc8b7e9aa770efc5214ff7c806ddf8c014cdb0427bf4", "bb6d1d6ea1c6d97281dced2019b2d401d982c5f4a855d40372d07a687616bdb0"]).has(sha256(currentSourcePolicyBytes)),
    "interactive reversal retains an exact reviewed SourcePolicy predecessor");
  const experimentalSourcePolicyBytes = currentSourcePolicyBytes;
  // Authenticate and reverse only B's finite TEST boundary/topology amendment.
  // Historical receipts and every prior policy digest retain their exact bytes.
  const experimentalMarker = "\n- id: experiments.interactive-draft-contracts\n";
  const experimentalParts = experimentalSourcePolicyBytes.split(experimentalMarker);
  assert.equal(experimentalParts.length, 2);
  assert.equal(sha256(experimentalMarker + experimentalParts[1]), "ef6f64f752963f06f754c98060e90a6a38b8c8b89256eac694a57b3755232d74");
  const packageRootAddition = "- experiments/interactive-provider-contract\n";
  assert.equal(experimentalParts[0].split(packageRootAddition).length - 1, 2);
  const classifiedExperiments = "- experiments/runtime-profile-behavior\n- experiments/rust-system-boundaries\n- experiments/sandbox-backend-hosting\n";
  assert.equal(experimentalParts[0].split(classifiedExperiments).length - 1, 1);
  currentSourcePolicyBytes = experimentalParts[0].replaceAll(packageRootAddition, "")
    .replace(classifiedExperiments, "- experiments\n");
  assert.equal(sha256(currentSourcePolicyBytes), "1b75095144867b2a9fd2bc8b7e9aa770efc5214ff7c806ddf8c014cdb0427bf4",
    "TEST experiment reversal retains exact efd3348f main source-policy bytes");
  assert.equal(currentSourcePolicyBytes.split(getModularAdditions[0]).length - 1, 2);
  // Conformance is admitted twice: for Embedded Runtime tests (AR-1c) and for Filesystem Custody tests (issue #189 handle guards).
  assert.equal(currentSourcePolicyBytes.split(getModularAdditions[1]).length - 1, 2);
  // Get Modular train 1 (AR-2) admits resources in the Provider Access ordinary composition; reverse only this line.
  const accessAdmission = ["    packages: ['@get-modular/resources']\n", "    packages: []\n"];
  assert.equal(currentSourcePolicyBytes.split(accessAdmission[0]).length - 1, 1);
  const preAccessPolicyBytes = currentSourcePolicyBytes.replace(accessAdmission[0], accessAdmission[1]);
  const comparatorPolicyBytes = getModularAdditions.reduce((bytes, line) => bytes.split(line).join(""), preAccessPolicyBytes);
  // Reverse only the exact fixed tooling dependency; retain every historical digest.
  const comparatorAdmission = '    - "@agent-teams/ci-input-proof"\n';
  assert.equal(comparatorPolicyBytes.split(comparatorAdmission).length - 1, 1);
  const namespacePolicyBytes = comparatorPolicyBytes.replace(comparatorAdmission, "");
  // Namespace qualification adds exactly two private roots to the existing CI owner.
  // Reverse only this finite delta and authenticate the accepted main predecessor.
  const namespaceAdditions = ["  - scripts/ci/namespace-qualification-contract.ts\n",
    "  - scripts/ci/namespace-qualification.ts\n"];
  for (const line of namespaceAdditions) { assert.equal(namespacePolicyBytes.split(line).length - 1, 1); }
  const currentPolicyBytes = namespaceAdditions.reduce((bytes, line) => bytes.replace(line, ""), namespacePolicyBytes);
  assert.equal(sha256(currentPolicyBytes), "f8a8bec9dedc316dd61f045222ad963ecb311481a67adbb0e4d50fcb54b9c613",
    "Namespace2 reversal retains exact reviewed main source-policy bytes");
  const erObserverAddition = "  - scripts/ci/er-process-observer.ts\n";
  assert.equal(currentPolicyBytes.split(erObserverAddition).length - 1, 1);
  const policyBytes = currentPolicyBytes.replace(erObserverAddition, "");
  assert.equal(sha256(policyBytes), "24e9ac285c89436f43f9fcfb0879640ffab008923adf66bae1363a24d5dcf635", "Retain exact c37 source-policy predecessor");
  // Darwin adds only two private helpers; authenticate the exact Root6179 predecessor.
  const darwinAdditions = ["  - scripts/ci/product-workflow-contract.ts\n", "  - scripts/ci/package-native-observation.ts\n"];
  for (const line of darwinAdditions) { assert.equal(policyBytes.split(line).length - 1, 1); }
  const beforeDarwin = darwinAdditions.reduce((bytes, line) => bytes.replaceAll(line, ""), policyBytes);
  const observationAddition = "  - scripts/ci/product-test-observation.ts\n";
  assert.equal(policyBytes.split(observationAddition).length - 1, 1);
  assert.equal(sha256(beforeDarwin.replaceAll(observationAddition, "")), "8e26f320efa01eb4ec314358136385bf08b349341fb4a6dc1946b7b5dc7f0014",
    "Removing only Darwin and the composed P2 helper retains exact Root6179 bytes");
  // Bounded PR sampling adds three private roots to the existing tooling owner.
  // Retain and authenticate the accepted Foundation candidate before applying
  // its older finite migrations. Historical receipts keep their original pins.
  const prAdditions = ["  - scripts/ci/pr-regression-inputs.ts\n", "  - scripts/ci/pr-regression-inputs.test.ts\n",
    "  - scripts/ci/pr-regression-command.ts\n"];
  for (const line of prAdditions) { assert.equal(policyBytes.split(line).length - 1, 1); }
  const product9164 = prAdditions.reduce((bytes, line) => bytes.replaceAll(line, ""),
    darwinAdditions.reduce((bytes, line) => bytes.replaceAll(line, ""), currentPolicyBytes));
  assert.equal(sha256(product9164), "05aa6103baea872064bec0757a30931bbbd63f9a4752ed67fe0ae857d3ef5b82",
    "Darwin2 and PR3 reversal reconstructs the verified Product9164 policy");
  const beforePr = product9164.replace(erObserverAddition, "");
  assert.equal(sha256(beforePr), "152d9b7acbface34a9903ddee4ae48c644780f14cd68f50355f8f95212afea92",
    "Darwin and PR reversals retain the exact new Product P2 policy predecessor");
  const beforeObservation = beforePr.replaceAll(observationAddition, "");
  assert.equal(sha256(beforeObservation), "5a3e444a4bf6c3ea704b4125e2089e3c198930bbe9c9ba817898c88533dab755",
    "PR source-policy delta retains exact Product checkpoint bytes");
  const additions = ["  - scripts/ci/cms-pin-review.ts\n", "  - scripts/ci/cms-pin-review.test.ts\n",
    "  - scripts/ci/nightly-contract.ts\n", "  - scripts/ci/nightly-contract.test.ts\n",
    "  - scripts/ci/package-execution.ts\n", "  - scripts/ci/package-execution.test.ts\n",
    "  - scripts/ci/product-fanout-contract.ts\n", "  - scripts/ci/product-fanout-contract.test.ts\n"];
  assert.equal(policyBytes.split(additions[0]).length - 1, 2);
  assert.equal(policyBytes.split(additions[1]).length - 1, 1);
  assert.equal(policyBytes.split(additions[2]).length - 1, 1);
  assert.equal(policyBytes.split(additions[3]).length - 1, 1);
  for (const addition of additions.slice(4)) { assert.equal(policyBytes.split(addition).length - 1, 1); }
  const beforeProduct = additions.slice(4).reduce((bytes, line) => bytes.replaceAll(line, ""), beforeObservation);
  assert.equal(sha256(beforeProduct), "b3e5dc6266b650e1f0aa8a7fba3609c4a4fb23f2a763268e7592959dc89d2a18",
    "Product source-policy delta must retain exact reviewed Foundation predecessor");
  // Foundation fanout adds exactly three private roots and one public test helper.
  // Authenticate the predecessor by reversing only this reviewed finite delta.
  const foundationAdditions = ["  - scripts/ci/foundation-fixture-sharding.ts\n",
    "  - scripts/ci/foundation-fixture-sharding.test.ts\n", "  - scripts/ci/foundation-fanout-contract.ts\n"];
  for (const [i, line] of foundationAdditions.entries()) {
    assert.equal(beforeProduct.split(line).length - 1, i === 0 ? 2 : 1);
  }
  const beforeFoundation = foundationAdditions.reduce((bytes, line) => bytes.replaceAll(line, ""), beforeProduct);
  assert.equal(sha256(beforeFoundation), "149598a44841aae0e86d80896a7eccf80f825fa8e9c799b43e9c4b2b4562437c",
    "Foundation source-policy delta must retain exact reviewed predecessor");
  const priorCiPolicy = additions.slice(0, 4).reduce((bytes, line) => bytes.replaceAll(line, ""), beforeFoundation);
  assert.equal(sha256(priorCiPolicy), "692d442aa3c6cc9755a9a7d25f9546722f72e18436ec9f8ca333b6c90b89596b");
  // Authenticate only the reversible CI addition to current Main, not historical Node receipts.
  const baseline = await json("scripts/ci/full-contract.json");
  const pieces = policyBytes.split("\n\n- id: tooling.ci-full-gate\n");
  assert.equal(pieces.length, 2);
  const original = `${pieces[0]}\n`
    .replaceAll("    boundaries:\n    - tooling.ci-full-gate\n    packages:", "    boundaries: []\n    packages:")
    .replaceAll("    - tooling.ci-full-gate\n", "");
  assert.equal(sha256(original), baseline.sourcePolicySha256, "CI source-policy delta must preserve current-main scope");
  const policy = await yaml("architecture/foundation/source-dependencies.yaml");
  const boundary = policy.boundaries.find(value => value.id === "tooling.ci-full-gate");
  assert.deepEqual(boundary.roots, ["scripts/ci/script-routing.ts", "scripts/ci/policy.ts", "scripts/ci/gate.ts", "scripts/ci/inventory.ts", "scripts/ci/measure.ts", "scripts/ci/conformance.ts", "scripts/ci/compare.ts", "scripts/ci/contracts.test.ts", "scripts/ci/cms-pin-review.ts", "scripts/ci/cms-pin-review.test.ts", "scripts/ci/nightly-contract.ts", "scripts/ci/nightly-contract.test.ts", "scripts/ci/foundation-fixture-sharding.ts", "scripts/ci/foundation-fixture-sharding.test.ts", "scripts/ci/foundation-fanout-contract.ts", "scripts/ci/package-execution.ts", "scripts/ci/package-execution.test.ts", "scripts/ci/product-fanout-contract.ts", "scripts/ci/product-fanout-contract.test.ts", "scripts/ci/product-test-observation.ts", "scripts/ci/er-process-observer.ts", "scripts/ci/pr-regression-inputs.ts", "scripts/ci/pr-regression-inputs.test.ts", "scripts/ci/pr-regression-command.ts", "scripts/ci/product-workflow-contract.ts", "scripts/ci/package-native-observation.ts", "scripts/ci/namespace-qualification-contract.ts", "scripts/ci/namespace-qualification.ts"]);
  assert.equal(boundary.dependencyMode, "development");
  assert.deepEqual(boundary.entrypoints, ["scripts/ci/script-routing.ts", "scripts/ci/cms-pin-review.ts", "scripts/ci/foundation-fixture-sharding.ts"]);
  assert.deepEqual(boundary.allow.boundaries, []);
  const scenarios = await json("architecture/foundation/docs-protocol-qualification.json");
  assert.equal(scenarios.schemaVersion, 2);
  assert.equal(scenarios.scenarios.length, 5);
  const suite = await read("scripts/docs/docs-protocol-adoption.test.mjs");
  assert.doesNotMatch(suite, /Reflect\.get|runDocsProtocolQualificationV2/u);
  const support = await read("scripts/docs/portable-authoring-test-support.mts");
  assert.doesNotMatch(support, /Reflect\.get|runDocsProtocolQualificationV2/u);
  assert.match(support, /docsQualification\.runDocsProtocolQualification\(/u);
  const manifest = await json("package.json");
  assertPortableCommand(manifest.scripts["docs:qualification:portable"]);
  assert.equal(manifest.scripts["docs:qualification"], "pnpm docs:qualification:typecheck && pnpm docs:qualification:serial && pnpm docs:qualification:portable");
  assert.equal(manifest.scripts["docs:qualification:typecheck"], "tsc --project tsconfig.docs-qualification.json --noEmit --pretty false");
  assert.equal(manifest.scripts["docs:qualification:serial"], "node --test --test-concurrency=1 scripts/docs/docs-protocol-adoption.test.mjs scripts/docs/consumer-migration.test.mjs scripts/docs/managed-target-contract.test.mjs scripts/docs/managed-installed-target.test.mjs scripts/docs/portable-authoring-policy.test.mts");
  assert.equal(manifest.scripts["docs:qualification:legacy"], "node scripts/docs/run-legacy-managed-target-test.mts");
  for (const file of portableFiles) {
    const entry = await read(file);
    assert.match(entry, /test\("portable authoring preserves runtime-/u);
    assert.match(entry, /runPortableAuthoringScenario\("runtime-/u);
  }
});

test("scoped source policy retains both historic edges and its committed amendment", async () => {
  const policyPath = "architecture/foundation/source-dependencies.yaml";
  const receipt = await json("architecture/foundation/source-policy-node-compatibility-evolution.json");
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    predecessor: {
      revision: "ab8efe2874c0600ea3930b4fe72bfc68d173543d",
      blob: "ae4dd7771d60aaa7ba24bf1e56f553f9826d7a77",
      sha256: "073d904b6ed55ac5ae8d0738d2b50762cc65ef653ed647aa28e98b5d574370b0",
    },
    successor: {
      revision: "98b75f694a0c72ad26d2cab19ff56713676b56a6",
      blob: "0f633e5fc2d2bad14a08ea5467bc0a07d6bad682",
      sha256: "a8ab641089abd81b0bb4387ef47ecf63a193aba2051d6ed87a3b5e2c8fca1c4c",
    },
    committedAmendment: {
      revision: "8b104417d51fe95d77c7dfff623fb484ce3e759b",
      blob: "9beef0450e9f3e86e2819e874faf06e0f94efe5e",
      sha256: "85f4235863df10f71610f21a1ea3854253f19078b0af8b502875c27ddacf6610",
    },
  });
  // Retain the small Git commit/tree path proof because the Docs Protocol checkout is depth 1.
  // Git object hashes authenticate each retained object's bytes and bind each policy blob to its commit.
  const fixture = await json("scripts/docs/fixtures/source-policy-historic-git-objects.json");
  assert.equal(fixture.schemaVersion, 1);
  const historicObject = (type, id) => {
    const object = fixture.objects[id];
    assert.equal(object?.type, type, id);
    const bytes = Buffer.from(object.bytes, "base64");
    assert.equal(objectId(type, bytes), id, id);
    return bytes;
  };
  const commitHeader = id => historicObject("commit", id).toString("utf8").split("\n\n", 1)[0];
  const parent = id => {
    const parents = [...commitHeader(id).matchAll(/^parent ([0-9a-f]{40})$/gmu)];
    assert.equal(parents.length, 1, id);
    return parents[0][1];
  };
  const intermediate1 = parent(receipt.committedAmendment.revision);
  const intermediate2 = parent(intermediate1);
  assert.equal(parent(intermediate2), receipt.successor.revision);
  assert.equal(parent(receipt.successor.revision), receipt.predecessor.revision);
  const treeEntry = (treeId, name, mode) => {
    const tree = historicObject("tree", treeId);
    const matches = [];
    for (let offset = 0; offset < tree.length;) {
      const space = tree.indexOf(0x20, offset);
      const nul = tree.indexOf(0, space + 1);
      assert.ok(space > offset && nul > space && nul + 21 <= tree.length, treeId);
      const entryMode = tree.toString("ascii", offset, space);
      const entryName = tree.toString("utf8", space + 1, nul);
      if (entryName === name) {
        matches.push({ mode: entryMode, id: tree.subarray(nul + 1, nul + 21).toString("hex") });
      }
      offset = nul + 21;
    }
    assert.equal(matches.length, 1, `${treeId}:${name}`);
    assert.equal(matches[0].mode, mode, `${treeId}:${name}`);
    return matches[0].id;
  };
  const verifyEdge = (name, edge, bytes) => {
    const tree = /^tree ([0-9a-f]{40})$/mu.exec(commitHeader(edge.revision));
    assert.ok(tree, name);
    const architecture = treeEntry(tree[1], "architecture", "40000");
    const foundation = treeEntry(architecture, "foundation", "40000");
    assert.equal(treeEntry(foundation, "source-dependencies.yaml", "100644"), edge.blob, name);
    assert.equal(objectId("blob", bytes), edge.blob, name);
    assert.equal(sha256(bytes), edge.sha256, name);
    return bytes;
  };
  // Authenticate the retained amendment rather than deriving history from live
  // Main, which adds independent Foundation source-input coverage.
  const amendmentBytes = historicObject("blob", receipt.committedAmendment.blob);
  const amendment = amendmentBytes.toString("utf8");
  const marker = "- id: tooling.node-compatibility-ci";
  const markerIndex = amendment.indexOf(marker);
  assert.ok(markerIndex > 0);
  const amendmentLine = "    - node:assert/strict\n    - node:child_process\n";
  assert.equal(amendment.slice(markerIndex).split(amendmentLine).length, 2);
  const successor = amendment.slice(0, markerIndex) + amendment.slice(markerIndex)
    .replace(amendmentLine, "    - node:assert/strict\n");
  const scopedRoots = "  - scripts/ci/run-ordinary-postgres.mjs\n  - scripts/ci/run-ordinary-postgres.test.mjs\n";
  assert.equal(successor.slice(0, markerIndex).split(scopedRoots).length, 2);
  const predecessor = successor.slice(0, markerIndex).replace(scopedRoots, "  - scripts/ci\n");
  const committedBytes = {
    predecessor: verifyEdge("predecessor", receipt.predecessor, Buffer.from(predecessor)),
    successor: verifyEdge("successor", receipt.successor, Buffer.from(successor)),
    committedAmendment: verifyEdge("committed amendment", receipt.committedAmendment, amendmentBytes),
  };
  assert.throws(() => verifyEdge("changed successor digest", {
    ...receipt.successor, sha256: receipt.predecessor.sha256,
  }, committedBytes.successor));
  assert.throws(() => verifyEdge("changed amendment blob", {
    ...receipt.committedAmendment, blob: receipt.successor.blob,
  }, committedBytes.committedAmendment));
  assert.throws(() => verifyEdge("changed historical bytes", receipt.predecessor,
    Buffer.from(predecessor.replace("  - scripts/ci\n", "  - scripts/ci/altered\n"))));
  assert.notEqual(sha256(committedBytes.predecessor), receipt.successor.sha256);
  assert.notEqual(sha256(committedBytes.successor), receipt.committedAmendment.sha256);
  const policy = await yaml(policyPath);
  const byId = new Map(policy.boundaries.map(boundary => [boundary.id, boundary]));
  assert.deepEqual(byId.get("tooling.ordinary-postgres-ci")?.roots, [
    "scripts/ci/run-ordinary-postgres.mjs",
    "scripts/ci/run-ordinary-postgres.test.mjs",
  ]);
  assert.deepEqual(byId.get("tooling.node-compatibility-ci")?.roots, [
    "scripts/ci/audit-node-engine-compatibility.mjs",
    "scripts/ci/node-engine-compatibility.test.mjs",
    "scripts/ci/node-runtime-compatibility.test.mjs",
  ]);
});
