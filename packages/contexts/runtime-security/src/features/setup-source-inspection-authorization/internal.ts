export { createNodePathCanonicalizer } from "./adapters/outbound/node-path-canonicalizer.js";
export type { NodePathCanonicalizerDependencies, StablePathCustodyOpener } from
  "./adapters/outbound/node-path-canonicalizer.js";
export type {
  CanonicalPathObservation,
  PathCanonicalizationOptions,
  PathCanonicalizer,
} from "./application/ports/outbound/path-canonicalizer.js";
export type {
  AuthorizeClaudeCodeSetupInspection,
  AuthorizeClaudeCodeSetupInspectionResult,
  AuthorizedClaudeCodeCanonicalRoot,
  AuthorizedClaudeCodeExecutableCandidate,
  AuthorizedClaudeCodePortableSource,
  ClaudeCodePortableSourceEvidence,
  ClaudeCodePortableSourceKind,
  ClaudeCodeSetupAuthorizationDiagnostic,
  TrustedClaudeCodeSetupInspectionScope,
} from "./contracts/claude-code-setup-inspection-authorization.js";
export type {
  AuthorizeSetupInspection,
  AuthorizeSetupInspectionInput,
  AuthorizeSetupInspectionResult,
  AuthorizedConfigurationSource,
  AuthorizedInstallationCandidate,
  AuthorizedPathCustodyRoot,
  SetupAuthorizationDiagnostic,
  SetupPathRootKind,
  TrustedConfigurationSource,
  TrustedInstallationCandidate,
  TrustedSetupPathRoot,
} from "./contracts/setup-inspection-authorization.js";
export {
  createSetupInspectionAuthorizationFeature,
  type SetupInspectionAuthorizationDependencies,
} from "./composition/feature-module-factory.js";
