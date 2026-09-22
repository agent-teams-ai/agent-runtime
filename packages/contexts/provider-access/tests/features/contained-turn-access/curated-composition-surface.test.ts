import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as composition from "../../../dist/composition.js";

const runtimeExports = [
  "OrdinaryCodexAuthCleanupIndeterminate",
  "OrdinaryCodexAuthRefused",
  "OrdinaryPaUnavailable",
  "createContainedTurnCredentialMaterializationAuthorizationV1",
  "createContainedTurnCredentialRenderingOwner",
  "createContainedTurnProviderAccessFeature",
  "createCredentialMaterializationRequestDigest",
  "createDispatchConsumptionRequestDigests",
  "createInMemoryContainedTurnDispatchConsumptionV1",
  "createInMemoryDispatchConsumptionRepository",
  "createMaterializationBindingRepository",
  "createOperationDispatchConsumption",
  "createOrdinaryCodexAuthCapture",
  "createPostgresCredentialRenderingOwner",
  "createPostgresCurrentProviderAccess",
  "createPostgresDispatchConsumption",
  "createPostgresMaterializationRepository",
  "createPostgresOperationDispatchConsumption",
  "createPostgresOrdinaryProviderAccessOwner",
  "createPostgresRouteSelectionOwner",
  "createSha256DispatchConsumptionDigest",
  "createStaticContainedTurnProviderAccessFeature",
  "dispatchOperationSchemaDigest",
  "materializationPostgresSchemaDigest",
  "routeSelectionDigest",
  "routeSelectionSchemaDigest",
  "snapshotRouteSelectionCurrent",
  "snapshotRouteSelectionFacts",
] as const;

const forbiddenCompositionTypes = [
  "AuthorizationOwnerSelector",
  "BindingSlot",
  "CredentialGenerationMaterialLifetime",
  "DispatchConsumeCommand",
  "MaterializationPostgresTransactions",
  "OperationCredentialMaterial",
  "PaOperationPublication",
  "PendingWrites",
  "PrivateCredentialField",
] as const;

const assertPrivateTypesStayClosed = (declaration: string): void => {
  for (const name of forbiddenCompositionTypes) {
    assert.doesNotMatch(declaration, new RegExp(`\\b${name}\\b`, "u"), `PRIVATE_COMPOSITION_TYPE: ${name}`);
  }
};

const assertPrivateTypesStayTransitivelyClosed = (): void => {
  const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const localRequire = createRequire(import.meta.url);
  const foundationRequire = createRequire(localRequire.resolve("@agent-teams/engineering-foundation/package.json"));
  const { Extractor, ExtractorConfig } = foundationRequire("@microsoft/api-extractor");
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: packageRoot,
      mainEntryPointFilePath: join(packageRoot, "dist/composition.d.ts"),
      compiler: { tsconfigFilePath: join(packageRoot, "tsconfig.json") },
      apiReport: { enabled: false },
      docModel: { enabled: false, includeForgottenExports: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: "error" } },
        extractorMessageReporting: {
          default: { logLevel: "warning" },
          "ae-forgotten-export": { logLevel: "error" },
          "ae-missing-release-tag": { logLevel: "none" },
          "ae-undocumented": { logLevel: "none" },
        },
        tsdocMessageReporting: { default: { logLevel: "warning" } },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: join(packageRoot, "package.json"),
  });
  const errors: string[] = [];
  const result = Extractor.invoke(config, {
    localBuild: true,
    messageCallback(message: { logLevel: string; text: string; handled: boolean }) {
      if (message.logLevel === "error") {errors.push(message.text);}
      message.handled = true;
    },
  });
  assert.equal(result.errorCount, 0, `TRANSITIVE_COMPOSITION_PRIVACY: ${errors.join("\n")}`);
  assert.equal(result.succeeded, true, `TRANSITIVE_COMPOSITION_PRIVACY: ${errors.join("\n")}`);
};

test("composition has an exact runtime surface and a curated type-only contract closure", async () => {
  assert.deepEqual(Object.keys(composition).toSorted(), [...runtimeExports]);
  const declaration = await readFile(new URL("../../../dist/composition.d.ts", import.meta.url), "utf8");
  assertPrivateTypesStayClosed(declaration);
  assertPrivateTypesStayTransitivelyClosed();
  for (const name of [
    "CredentialGenerationField",
    "PostgresCredentialRenderingOwner",
    "PostgresDispatchConsumptionOwner",
    "PostgresMaterializationRepositoryOwner",
    "TrustedCredentialMaterialSeed",
  ]) {
    assert.match(declaration, new RegExp(`\\b${name}\\b`, "u"), `missing supported composition contract ${name}`);
  }
});

test("package root remains portable and the privacy oracle rejects a leaked implementation type", async () => {
  const rootDeclaration = await readFile(new URL("../../../dist/index.d.ts", import.meta.url), "utf8");
  for (const name of [
    "CredentialGenerationField",
    "DispatchBindingHead",
    "MaterializationAuthorizationRepository",
    "PostgresCredentialRenderingOwner",
    "TrustedCredentialMaterialSeed",
  ]) {
    assert.doesNotMatch(rootDeclaration, new RegExp(`\\b${name}\\b`, "u"));
  }
  assert.throws(
    () => assertPrivateTypesStayClosed(`${rootDeclaration}\nexport type PrivateCredentialField = never;\n`),
    /PRIVATE_COMPOSITION_TYPE: PrivateCredentialField/u,
  );
});
