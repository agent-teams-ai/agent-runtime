import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { verifyPermissionContractClaims } from
  "../../fixtures/protocol/codex-app-server-0.150.1/verify-regeneration.mjs";

interface PermissionContractFixture {
  readonly configLayerEvidence: {
    readonly jsonSchema: { readonly source: string; readonly sourceSha256: string };
    readonly typeScript: { readonly source: string; readonly sourceSha256: string };
  };
  readonly generatedTypeFragments: readonly {
    readonly fragment: string; readonly source: string; readonly sourceSha256: string;
  }[];
}

test("regeneration claim verification fails closed on retained permission/config evidence drift", async () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-regeneration-claims-")));
  try {
    const schemaRoot = join(caseRoot, "schema");
    const typesRoot = join(caseRoot, "types");
    const fixture = JSON.parse(readFileSync(new URL(
      "../../fixtures/linux-codex-app-server-0.150.1-permission-contract.json", import.meta.url), "utf8")) as
      PermissionContractFixture;
    const evidence = structuredClone(fixture);
    const digestBytes = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
    for (const source of new Set(evidence.generatedTypeFragments.map(claim => claim.source))) {
      const contents = evidence.generatedTypeFragments.filter(claim => claim.source === source)
        .map(claim => claim.fragment).join("\n");
      const path = join(typesRoot, source);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      for (const claim of evidence.generatedTypeFragments.filter(candidate => candidate.source === source)) {
        (claim as {sourceSha256: string}).sourceSha256 = digestBytes(contents);
      }
      if (source === evidence.configLayerEvidence.typeScript.source) {
        (evidence.configLayerEvidence.typeScript as {sourceSha256: string}).sourceSha256 = digestBytes(contents);
      }
    }
    const schemaPath = join(schemaRoot, evidence.configLayerEvidence.jsonSchema.source);
    mkdirSync(dirname(schemaPath), { recursive: true });
    const schema = { definitions: { ConfigLayer: {
      properties: { config: {}, disabledReason: { type: ["string", "null"] }, name: {}, version: {} },
      required: ["config", "name", "version"],
      type: "object",
    } } };
    const writeSchema = (value: typeof schema, target: PermissionContractFixture): void => {
      const bytes = JSON.stringify(value);
      writeFileSync(schemaPath, bytes);
      (target.configLayerEvidence.jsonSchema as {sourceSha256: string}).sourceSha256 = digestBytes(bytes);
    };
    writeSchema(schema, evidence);

    assert.deepEqual(await verifyPermissionContractClaims(evidence, schemaRoot, typesRoot),
      { jsonSchemaClaims: 1, typeScriptClaims: evidence.generatedTypeFragments.length });
    assert.deepEqual(evidence.generatedTypeFragments.map(claim => claim.source).filter(source => [
      "v2/ActivePermissionProfile.ts", "v2/ThreadStartParams.ts", "v2/TurnStartParams.ts",
      "v2/ConfigLayer.ts", "v2/ConfigLayerMetadata.ts", "v2/ConfigReadResponse.ts",
    ].includes(source)), [
      "v2/ActivePermissionProfile.ts", "v2/ConfigLayer.ts", "v2/ConfigLayerMetadata.ts",
      "v2/ThreadStartParams.ts", "v2/TurnStartParams.ts", "v2/ConfigReadResponse.ts",
    ]);

    const first = evidence.generatedTypeFragments[0]!;
    const firstPath = join(typesRoot, first.source);
    const firstBytes = readFileSync(firstPath);
    rmSync(firstPath);
    await assert.rejects(verifyPermissionContractClaims(evidence, schemaRoot, typesRoot), /ENOENT/u);
    mkdirSync(firstPath);
    await assert.rejects(verifyPermissionContractClaims(evidence, schemaRoot, typesRoot), /regular file/u);
    rmSync(firstPath, { recursive: true });
    writeFileSync(firstPath, firstBytes);
    rmSync(firstPath);
    symlinkSync(join(typesRoot, "v2/Config.ts"), firstPath);
    await assert.rejects(verifyPermissionContractClaims(evidence, schemaRoot, typesRoot), /regular file/u);
    rmSync(firstPath);
    writeFileSync(firstPath, firstBytes);

    const pathSubstitution = structuredClone(evidence);
    (pathSubstitution.generatedTypeFragments[0] as {source: string}).source = "v2/Config.ts";
    await assert.rejects(verifyPermissionContractClaims(pathSubstitution, schemaRoot, typesRoot), /source paths drifted/u);
    const hashDrift = structuredClone(evidence);
    (hashDrift.generatedTypeFragments[0] as {sourceSha256: string}).sourceSha256 = "0".repeat(64);
    await assert.rejects(verifyPermissionContractClaims(hashDrift, schemaRoot, typesRoot), /SHA-256 drifted/u);
    const fragmentDrift = structuredClone(evidence);
    (fragmentDrift.generatedTypeFragments[0] as {fragment: string}).fragment += "\nmissing mutation";
    await assert.rejects(verifyPermissionContractClaims(fragmentDrift, schemaRoot, typesRoot), /fragment drifted/u);

    const requiredDrift = structuredClone(evidence);
    writeSchema({ definitions: { ConfigLayer: { ...schema.definitions.ConfigLayer,
      required: [...schema.definitions.ConfigLayer.required, "disabledReason"],
    } } }, requiredDrift);
    await assert.rejects(verifyPermissionContractClaims(requiredDrift, schemaRoot, typesRoot), /required keys drifted/u);
    const typeDrift = structuredClone(evidence);
    writeSchema({ definitions: { ConfigLayer: { ...schema.definitions.ConfigLayer,
      properties: { ...schema.definitions.ConfigLayer.properties, disabledReason: { type: ["string"] } },
    } } }, typeDrift);
    await assert.rejects(verifyPermissionContractClaims(typeDrift, schemaRoot, typesRoot), /types drifted/u);
  } finally {
    rmSync(caseRoot, { force: true, recursive: true });
  }
});
