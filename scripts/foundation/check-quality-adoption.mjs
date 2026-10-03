import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse } from "yaml";

export function assertQualityAdoption({ manifest, foundation, profile, nodeTestContract }) {
  assert.equal(manifest.scripts["test:consumer-modules"],
    "node --test scripts/architecture/check-consumer-module-standard.test.mjs && agent-teams-node-test --contract architecture/foundation/mandatory-node-tests.json -- scripts/architecture/check-cms-pin.test.mjs");
  assert.ok(manifest.scripts["quality:adoption"].split(/\s*&&\s*/u)
    .includes("node --test scripts/foundation/source-inputs.test.mjs"));
  assert.deepEqual(nodeTestContract, {
    schemaVersion: 1,
    required: [
      "rejects split profile pins",
      "rejects retained standard bytes that differ from the pin",
      "rejects a delta detached from its review digest"
    ].map(name => ({ file: "scripts/architecture/check-cms-pin.test.mjs", names: [name], kind: "test" })),
    exceptions: []
  });
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], "1.7.2");
  assert.equal(manifest.devDependencies["oxlint-tsgolint"], "catalog:");
  assert.equal(foundation.schemaVersion, 2);
  assert.deepEqual(foundation.capabilities["quality.source-coverage"], {
    configPath: "architecture/foundation/quality-source-coverage.yaml"
  });
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.bridgeAdmissionsPath,
    "architecture/foundation/quality-source-coverage-bridge-admissions.json");
  assert.equal(profile.featureProfilePath, "architecture/feature-module-standard/candidate-profile.json");
  assert.equal(profile.sourcePolicyPath, "architecture/foundation/source-dependencies.yaml");
  assert.equal(profile.suppressionPolicyPath, "architecture/foundation/suppression-governance.yaml");
  assert.equal(profile.lintConfigPath, ".oxlintrc.type-aware.json");
  assert.deepEqual(profile.scripts, {
    fast: "check:fast", full: "check", scope: "quality:coverage:scope", typed: "lint:typed"
  });
  assert.equal(manifest.scripts[profile.scripts.scope], "agent-teams-foundation quality check --consumer . --scope-only");
  assert.equal(manifest.scripts[profile.scripts.typed], "agent-teams-foundation quality check --consumer .");
  for (const [entry, target] of [["check:fast", "quality:coverage:scope"], ["check", "lint:typed"]]) {
    assert.ok(manifest.scripts[entry].split(/\s*&&\s*/u).includes(`pnpm ${target}`));
  }
}

export async function readQualityAdoption(root = new URL("../../", import.meta.url)) {
  const read = async path => readFile(new URL(path, root), "utf8");
  return {
    manifest: JSON.parse(await read("package.json")),
    foundation: parse(await read("foundation.config.yaml")),
    profile: parse(await read("architecture/foundation/quality-source-coverage.yaml")),
    nodeTestContract: JSON.parse(await read("architecture/foundation/mandatory-node-tests.json"))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertQualityAdoption(await readQualityAdoption());
}
