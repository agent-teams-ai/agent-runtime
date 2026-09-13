import { createAuthorizeClaudeCodeSetupInspectionV1 } from
  "../adapters/inbound/claude-code-setup-inspection-authorization-v1.js";
import { createAuthorizeSetupInspectionV1 } from
  "../adapters/inbound/setup-inspection-authorization-v1.js";
import { createNodePathAlgebra } from "../adapters/outbound/node-path-algebra.js";
import { createNodeSourceIdentityDigest } from "../adapters/outbound/node-source-identity-digest.js";
import { createAuthorizeClaudeCodeSetupInspection } from "../application/authorize-claude-code-setup-inspection.js";
import { createAuthorizeSetupInspection } from "../application/authorize-setup-inspection.js";
import type { PathCanonicalizer } from "../application/ports/outbound/path-canonicalizer.js";

export interface SetupInspectionAuthorizationDependencies {
  readonly pathCanonicalizer: PathCanonicalizer;
}

export const createSetupInspectionAuthorizationFeature = (
  dependencies: SetupInspectionAuthorizationDependencies,
) => {
  // Pure path algebra and the candidate-identity digest are internal
  // composition details, not part of this feature's public dependency
  // surface: they are deterministic Node wrappers with nothing to fake.
  const pathAlgebra = createNodePathAlgebra();
  return Object.freeze({
    authorizeClaudeCodeSetupInspection: createAuthorizeClaudeCodeSetupInspectionV1(
      createAuthorizeClaudeCodeSetupInspection(
        dependencies.pathCanonicalizer,
        pathAlgebra,
        createNodeSourceIdentityDigest(),
      ),
    ),
    authorizeSetupInspection: createAuthorizeSetupInspectionV1(
      createAuthorizeSetupInspection(
        dependencies.pathCanonicalizer,
        pathAlgebra,
      ),
    ),
  });
};
