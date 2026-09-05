import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./provider-candidate-build-tree.mjs";
import { sourceSnapshot, sourceFileDigest } from "./provider-candidate-source.mjs";
import { executedBuildIdentity, installedClosureDigest, verifyCleanBuild } from "./provider-candidate-clean-build.mjs";
import {
  record, choice, exactDigest, safeTuple, safePackageIdentity,
  safeObservations, validateCompletion, evidenceDigest,
} from "./provider-candidate-evidence-schema.mjs";

const executionAuthorities = new WeakMap();
const PROVIDERS = ["codex-app-server-current-kernel", "claude-agent-sdk-current-kernel"];
const CANARIES = ["codex-contained-turn-live-canary/v1", "claude-contained-turn-live-canary/v1"];

export const resolveCanaryExecutionProvenance = async input => {
  const provider = choice(input.provider, PROVIDERS);
  const canaryId = choice(input.canaryId, CANARIES);
  if (PROVIDERS.indexOf(provider) !== CANARIES.indexOf(canaryId)) {
    throw new TypeError("canary execution provenance does not match provider and canary");
  }
  const sourceSha = input.claimedSourceSha;
  const canarySourceUrl = new URL(input.canarySourceUrl).href;
  const buildRoot = fileURLToPath(input.buildRootUrl);
  const source = await sourceSnapshot(import.meta.url, sourceSha);
  if (buildRoot.replace(/\/$/u, "") !== join(source.root, "packages/contexts/agent-execution/dist")) {
    throw new Error("candidate must execute the exact workspace build");
  }
  const canaryDigest = sourceFileDigest(source, canarySourceUrl);
  const authorityDigest = sourceFileDigest(source, import.meta.url);
  const build = await verifyCleanBuild(source);
  await sourceSnapshot(import.meta.url, sourceSha);
  const receiptDigest = evidenceDigest({authorityDigest, build, canaryDigest, canaryId, provider, sourceSha});
  const execution = Object.freeze({
    build: Object.freeze({...build, receiptDigest}),
    canary: Object.freeze({id: canaryId, sourceDigest: canaryDigest}),
    provider, sourceSha, tokenDigest: receiptDigest,
  });
  executionAuthorities.set(execution, Object.freeze({root: source.root, canarySourceUrl, authorityDigest}));
  return execution;
};

export const revalidateCanaryExecutionProvenance = async execution => {
  const authority = executionAuthorities.get(execution);
  if (authority === undefined) {throw new TypeError("verified canary execution provenance is required");}
  try {
    const source = await sourceSnapshot(import.meta.url, execution.sourceSha);
    if (sourceFileDigest(source, import.meta.url) !== authority.authorityDigest ||
        sourceFileDigest(source, authority.canarySourceUrl) !== execution.canary.sourceDigest ||
        (await executedBuildIdentity(authority.root)).treeDigest !== execution.build.treeDigest ||
        await installedClosureDigest(authority.root) !== execution.build.dependenciesDigest ||
        sha256(await readFile(process.execPath)) !== execution.build.nodeDigest) {
      throw new Error("changed");
    }
  } catch {throw new Error("canary source, dependency closure, or executed build changed during execution");}
  return execution;
};

export const createProviderCandidateEvidenceEnvelope = async value => {
  // Snapshot the complete bounded input before any async work; never run a
  // caller getter/proxy or retain mutable input across revalidation.
  const input = record(value, [
    "binaryRevision", "binarySha256", "canaryId", "compositeContainment", "executionProvenance",
    "observations", "packageIdentity", "physicalContainment", "platformTuple", "provider", "status",
  ]);
  const tuple = safeTuple(input.platformTuple);
  const observations = safeObservations(input.observations);
  const packages = safePackageIdentity(input.packageIdentity);
  choice(input.provider, PROVIDERS);
  choice(input.canaryId, CANARIES);
  choice(input.status, ["provider-completed", "failed"]);
  choice(input.physicalContainment, ["contained", "indeterminate"]);
  choice(input.compositeContainment, ["indeterminate"]);
  const binaryDigest = exactDigest(input.binarySha256);
  if (typeof input.binaryRevision !== "string" || input.binaryRevision.length > 192 ||
      !/^(?:sha256:[a-f0-9]{64}|@(?:openai\/codex|anthropic-ai\/claude-agent-sdk)[:@][0-9]+\.[0-9]+\.[0-9]+(?:\+(?:linux-x64|darwin-arm64))?)$/u.test(input.binaryRevision)) {
    throw new TypeError("canary binary revision must be exact");
  }
  if (tuple.platform === "darwin" && (input.physicalContainment !== "indeterminate" ||
      observations.terminalKind === "final" || observations.terminalStatus === "succeeded" ||
      observations.containmentProofDigest !== undefined || observations.terminalProofDigest !== undefined)) {
    throw new TypeError("Darwin containment and kernel terminal truth remain indeterminate");
  }
  validateCompletion(input, observations, tuple);
  const execution = await revalidateCanaryExecutionProvenance(input.executionProvenance);
  if (input.provider !== execution.provider || input.canaryId !== execution.canary.id) {
    throw new TypeError("canary execution provenance does not match provider and canary");
  }
  return Object.freeze({
    schemaVersion: 2,
    binaryIdentity: Object.freeze({digest: binaryDigest, revisionDigest: exactDigest(sha256(input.binaryRevision))}),
    buildIdentity: Object.freeze({
      bytes: execution.build.bytes, files: execution.build.files,
      treeDigest: exactDigest(execution.build.treeDigest),
      commandDigest: exactDigest(execution.build.commandDigest),
      dependenciesDigest: exactDigest(execution.build.dependenciesDigest),
      nodeDigest: exactDigest(execution.build.nodeDigest),
      profile: execution.build.profile, receiptDigest: exactDigest(execution.build.receiptDigest),
    }),
    canaryIdentity: Object.freeze({
      id: execution.canary.id, sourceDigest: exactDigest(execution.canary.sourceDigest),
      tokenDigest: exactDigest(execution.tokenDigest),
    }),
    compositeContainment: "indeterminate", networkRouteEnforcement: "unqualified",
    observations, packageIdentity: packages, physicalContainment: input.physicalContainment,
    platformTuple: tuple, provider: execution.provider,
    qualification: "implementation-evidence-only", sourceSha: execution.sourceSha, status: input.status,
  });
};
