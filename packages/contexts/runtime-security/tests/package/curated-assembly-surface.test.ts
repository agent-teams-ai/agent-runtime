import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CompilerState,
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
} from "@microsoft/api-extractor";

import * as publicApi from "../../dist/index.js";
import * as compositionApi from "../../dist/composition.js";

const compositionRuntimeExports = [
  "canonicalEgressValue",
  "captureCurrentEgressResolve",
  "containedTurnEgressProviderBindingDigest",
  "createContainedTurnDispatchAuthorityFeature",
  "createContainedTurnEgressGateway",
  "createCurrentEgressOwner",
  "createDispatchAcceptanceFeature",
  "createInMemoryDispatchConsumptionRepository",
  "createNodeEd25519EgressSigner",
  "createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate",
  "createNodeHmacEgressDecisionSeal",
  "createNodePathCanonicalizer",
  "createNodeSha256DispatchDigest",
  "createNodeSha256EgressDigest",
  "createOrdinarySecurityOwner",
  "createPostgresDispatchAcceptanceStore",
  "createPostgresDispatchConsumptionRepository",
  "createProviderProcessEgressAuthorizationFeature",
  "createSetupInspectionAuthorizationFeature",
  "currentEgressDigest",
  "snapshotDispatchAuthorityHead",
] as const;

const supportedCompositionTypes = [
  "DispatchConsumptionRepository",
  "DispatchPgPool",
  "EgressDispatchPortObservation",
  "PostgresDispatchAuthoritySnapshot",
  "PostgresDispatchConsumptionRepository",
  "RequestFinalEgressAuthorizationOutcomeV2",
  "StablePathCustodyOpener",
] as const;

const privateCompositionTypes = [
  "ConsumeFact",
  "DispatchPgTransaction",
  "HeadChange",
  "OperationKey",
  "SettlementFact",
] as const;

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

const extractComposition = (root: string, label: string) => {
  const diagnostics: { readonly id: string; readonly level: string; readonly text: string }[] = [];
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: join(root, "dist", "composition.d.ts"),
      compiler: { tsconfigFilePath: join(root, "audit-tsconfig.json") },
      apiReport: { enabled: false },
      docModel: {
        enabled: true,
        apiJsonFilePath: join(root, `${label}.api.json`),
        includeForgottenExports: false,
      },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
      testMode: true,
      messages: {
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.Error } },
        extractorMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Warning },
          "ae-forgotten-export": { logLevel: ExtractorLogLevel.Error },
          "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
          "ae-undocumented": { logLevel: ExtractorLogLevel.None },
        },
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.Warning } },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: join(root, "package.json"),
    projectFolderLookupToken: root,
  });
  const result = Extractor.invoke(config, {
    compilerState: CompilerState.create(config),
    localBuild: true,
    showVerboseMessages: false,
    messageCallback(message) {
      diagnostics.push({
        id: message.messageId,
        level: message.logLevel,
        text: message.text,
      });
      message.handled = true;
    },
  });
  return { diagnostics, result };
};

const assertCuratedCompositionDeclaration = (declaration: string): void => {
  for (const name of supportedCompositionTypes) {
    assert.match(
      declaration,
      new RegExp(`\\b${name}\\b`, "u"),
      `SUPPORTED_COMPOSITION_TYPE_MISSING: ${name}`,
    );
  }
  for (const name of privateCompositionTypes) {
    assert.doesNotMatch(
      declaration,
      new RegExp(`\\b${name}\\b`, "u"),
      `PRIVATE_COMPOSITION_TYPE: ${name}`,
    );
  }
};

test("package root exposes only supported V1 consumer contracts", async () => {
  assert.deepEqual(Object.keys(publicApi), ["CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE"]);
  const declarations = await readFile(new URL("../../dist/index.d.ts", import.meta.url), "utf8");
  assert.match(declarations, /ContainedTurnDispatchAuthorityV1/);
  for (const internalName of [
    "DispatchAuthorityHead",
    "DispatchConsumptionRepository",
    "DispatchControlClock",
    "DispatchDigest",
    "PersistedConsumption",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(`\\b${internalName}\\b`));
  }
});

test("composition factories stay off the public package root", () => {
  assert.equal("createContainedTurnEgressGateway" in publicApi, false);
  assert.equal("containedTurnEgressProviderBindingDigest" in publicApi, false);
});

test("composition keeps its runtime surface while closing only supported type contracts", async () => {
  assert.deepEqual(Object.keys(compositionApi).toSorted(), [...compositionRuntimeExports]);
  const declaration = await readFile(
    new URL("../../dist/composition.d.ts", import.meta.url),
    "utf8",
  );
  assertCuratedCompositionDeclaration(declaration);
});

test("the composition privacy and closure oracle rejects missing or leaked contracts", async () => {
  const declaration = await readFile(
    new URL("../../dist/composition.d.ts", import.meta.url),
    "utf8",
  );
  assert.throws(
    () => assertCuratedCompositionDeclaration(
      declaration.replaceAll("PostgresDispatchAuthoritySnapshot", "RemovedSupportedType"),
    ),
    /SUPPORTED_COMPOSITION_TYPE_MISSING: PostgresDispatchAuthoritySnapshot/u,
  );
  assert.throws(
    () => assertCuratedCompositionDeclaration(`${declaration}\nexport type OperationKey = never;\n`),
    /PRIVATE_COMPOSITION_TYPE: OperationKey/u,
  );
});

test("strict declaration extraction rejects a private type restored in a reachable signature", t => {
  const sandbox = mkdtempSync(join(tmpdir(), "runtime-security-private-type-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  cpSync(join(packageRoot, "dist"), join(sandbox, "dist"), { recursive: true });
  cpSync(join(packageRoot, "package.json"), join(sandbox, "package.json"));

  const dependencies = join(sandbox, "node_modules", "@agent-teams");
  mkdirSync(dependencies, { recursive: true });
  symlinkSync(
    join(repositoryRoot, "packages", "platform", "filesystem-custody"),
    join(dependencies, "filesystem-custody"),
    "dir",
  );
  writeFileSync(join(sandbox, "audit-tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2024",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: false,
      lib: ["ES2024", "DOM"],
      types: ["node"],
      typeRoots: [join(repositoryRoot, "node_modules", "@types")],
    },
    include: ["dist/**/*.d.ts"],
  }));

  const baseline = extractComposition(sandbox, "baseline");
  assert.equal(
    baseline.result.succeeded,
    true,
    `STRICT_BASELINE_FAILED: ${JSON.stringify(baseline.diagnostics)}`,
  );
  assert.equal(baseline.result.errorCount, 0);

  const repositoryDeclaration = join(
    sandbox,
    "dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/dispatch-consumption-repository.d.ts",
  );
  const declaration = readFileSync(repositoryDeclaration, "utf8");
  const mutant = declaration
    .replace(
      'import type { DispatchPgDeadlines, DispatchPgPool } from "./transaction.js";',
      'import type { OperationKey } from "./records.js";\nimport type { DispatchPgDeadlines, DispatchPgPool } from "./transaction.js";',
    )
    .replace(
      "readAuthority(key: DispatchPublicationKey)",
      "readAuthority(key: OperationKey)",
    );
  assert.notEqual(mutant, declaration, "PRIVATE_SIGNATURE_MUTATION_NOT_APPLIED");
  assert.match(mutant, /readAuthority\(key: OperationKey\)/u);
  writeFileSync(repositoryDeclaration, mutant);

  assertCuratedCompositionDeclaration(
    readFileSync(join(sandbox, "dist", "composition.d.ts"), "utf8"),
  );
  const rejected = extractComposition(sandbox, "private-operation-key");
  assert.equal(rejected.result.succeeded, false, "PRIVATE_SIGNATURE_MUTATION_ACCEPTED");
  assert.equal(rejected.result.errorCount, 1);
  const errors = rejected.diagnostics.filter(diagnostic => diagnostic.level === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.id, "ae-forgotten-export");
  assert.match(
    errors[0]?.text ?? "",
    /symbol "OperationKey" needs to be exported by the entry point composition\.d\.ts/u,
  );
});
