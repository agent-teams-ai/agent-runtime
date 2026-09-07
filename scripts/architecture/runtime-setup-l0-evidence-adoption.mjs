import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateProductCapture } from "./runtime-setup-l0-evidence-validation.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const composition = "packages/apps/embedded-runtime/src/composition";
export const adoptionPaths = Object.freeze({
  report: "docs/spikes/runtime-setup-assembly-adoption-evidence.json",
  profile: "architecture/get-modular/consumer-profile.json",
  checker: "scripts/architecture/check-get-modular-adoption.mjs",
  authority: "docs/decisions/0015-passive-setup-static-assembly-adoption.md",
  registry: "architecture/decisions/accepted-decisions.json",
  historical: "docs/spikes/runtime-setup-l0-dogfooding-evidence.json",
  default: `${composition}/default-agent-runtime-host.ts`,
  graph: `${composition}/runtime-setup-assembly.ts`,
  leaf: `${composition}/agent-runtime-host.ts`,
  reference: "packages/apps/embedded-runtime/tests/helpers/assembly-direct-reference.ts",
});

// These identify accepted bytes, not a new report or a benchmark promotion.
export const adoptionAuthority = Object.freeze({
  id: "ADR-0015",
  path: adoptionPaths.authority,
  sha256: "7d5c46260f30b22044091d63bd6b1ba4df57674648d5de788da6d87f3dbcdf12",
  immutableDigest: "sha256:f8bd0ab5f9d7a4937095b45fd533da34f83964b8da6b766dc2a93d459396e9df",
});
export const retainedHistoricalSha256 = "f0f259e8cb07400f581e516511d3ee9a93eca5593306590c0f1a7e8a53f6f99f";
export const adoptionConstruction = Object.freeze([
  { owner: "embedded-runtime", path: adoptionPaths.default, symbols: ["createDefaultAgentRuntimeHost"] },
  { owner: "embedded-runtime", path: adoptionPaths.graph, symbols: [] },
  { owner: "embedded-runtime", path: adoptionPaths.leaf, symbols: ["createAgentRuntimeHost"] },
  { owner: "embedded-runtime", path: adoptionPaths.reference, symbols: ["createDirectReferenceHost"] },
]);
export const adoptionEvidenceFiles = Object.freeze([
  adoptionPaths.profile, "architecture/get-modular/consumer-profile.schema.json",
  adoptionPaths.checker, adoptionPaths.authority, adoptionPaths.registry,
  "scripts/architecture/runtime-setup-l0-evidence.mjs",
  "scripts/architecture/runtime-setup-l0-evidence-adoption.mjs",
  "scripts/architecture/runtime-setup-l0-evidence-inputs.mjs",
  "scripts/architecture/runtime-setup-l0-evidence-validation.mjs",
  "scripts/architecture/runtime-setup-l0-evidence-spec.mjs",
  "scripts/architecture/runtime-setup-l0-evidence-adoption.test.mjs",
  "scripts/architecture/runtime-setup-l0-evidence-inputs.test.mjs",
  "scripts/architecture/runtime-setup-l0-evidence-validation.test.mjs",
  "architecture/foundation/source-dependencies.yaml",
  "architecture/feature-module-standard/candidate-profile.json",
]);

export function assertAdoptionAuthority({ authorityBytes, registry, historicalBytes, profile, gate }) {
  assert.equal(sha256(authorityBytes), adoptionAuthority.sha256, "accepted ADR-0015 bytes drifted");
  assert.deepEqual(registry.decisions.find(({ id }) => id === adoptionAuthority.id), {
    id: adoptionAuthority.id, path: adoptionAuthority.path,
    immutableDigest: adoptionAuthority.immutableDigest,
  }, "accepted ADR-0015 registry identity drifted");
  assert.equal(sha256(historicalBytes), retainedHistoricalSha256, "retained L0 evidence bytes drifted");
  assert.equal(profile.status, "active", "adoption not ready: consumer profile is not active");
  assert.equal(profile.authority.id, adoptionAuthority.id);
  assert.equal(profile.authority.path, adoptionAuthority.path);
  // The real checker must perform its evidence loader, not only validateProfile.
  assert.equal(gate.status, "verified-metadata", "adoption not ready: active artifact/pin gate required");
  assert.equal(gate.scope, "embedded-runtime passive setup");
}

export function buildAdoptionReport({ sourceRevision, historicalRevision, artifactDigests, capture }) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(historicalRevision, /^[a-f0-9]{40}$/u);
  validateProductCapture(capture);
  return {
    schemaVersion: 1,
    evidenceKind: "runtime-setup-static-assembly-construction",
    sourceRevision,
    authority: adoptionAuthority,
    historical: { path: adoptionPaths.historical, sha256: retainedHistoricalSha256, sourceRevision: historicalRevision },
    artifactDigests,
    construction: adoptionConstruction,
    capture,
    scope: "embedded-runtime passive setup",
    limitations: ["historical-L1-HOLD-unchanged", "benefit-not-established-by-construction-evidence",
      "contained-turn-not-adopted", "no-provider-qualification", "no-repository-wide-conformance"],
  };
}

export function validateAdoptionReport(report, current) {
  assert.deepEqual(report, buildAdoptionReport({ ...current, capture: report.capture }),
    "current adoption evidence identity, closure, or traces drifted");
}
