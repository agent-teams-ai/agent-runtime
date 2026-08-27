import { createAuthorizeSetupInspection } from "../application/authorize-setup-inspection.js";
import type { PathCanonicalizer } from "../application/ports/outbound/path-canonicalizer.js";

export interface SetupInspectionAuthorizationDependencies {
  readonly pathCanonicalizer: PathCanonicalizer;
}

export const createSetupInspectionAuthorizationFeature = (
  dependencies: SetupInspectionAuthorizationDependencies,
) =>
  Object.freeze({
    authorizeSetupInspection: createAuthorizeSetupInspection(
      dependencies.pathCanonicalizer,
    ),
  });
