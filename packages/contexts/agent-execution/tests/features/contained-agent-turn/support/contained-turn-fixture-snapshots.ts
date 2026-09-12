import { digestContainedTurnCanonicalValue } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";

export const adapterSnapshot = Object.freeze({
  adapterRevision: "adapter:one",
  binaryRevision: "binary:one",
  capabilityManifestRevision: "manifest:one",
  provider: "codex" as const,
});
export const providerAccessSnapshot = Object.freeze({
  accessRef: "access:one",
  credentialBindingDigest: digestContainedTurnCanonicalValue({ binding: "one" }),
  credentialBindingRef: "credential-binding:one",
  credentialGeneration: 1,
  ownerAuthorityDigest: "authority-digest:one",
  projectId: "project:one",
  provider: "codex" as const,
  providerAccountRef: "account:one",
  providerRouteRef: "route:one",
  revision: 1,
  tenantId: "tenant:one",
});
export const manifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation" as const,
  effectClass: "contained_unmediated_effect" as const,
  manifestRevision: adapterSnapshot.capabilityManifestRevision,
  manifestVersion: 1 as const,
  provider: "codex" as const,
  providerAttemptCardinality: "at_most_one" as const,
  requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: "resource-scope:one",
  supportedModes: Object.freeze(["analysis"] as const),
  unknownCapabilityPolicy: "fail_closed" as const,
});
