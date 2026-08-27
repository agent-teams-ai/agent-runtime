import type {
  SetupAuthorizationDiagnostic,
  TrustedInstallationCandidate,
} from "@agent-teams/runtime-security";

import type { TrustedRuntimeAccessScope } from "../../trusted-runtime-access-scope.js";

export type CodexSetupInspectionPlan =
  | { readonly status: "unsupported" }
  | {
      readonly diagnostics: readonly SetupAuthorizationDiagnostic[];
      readonly installationCandidates: readonly TrustedInstallationCandidate[];
      readonly status: "planned";
    };

export interface CodexSetupInspectionPlanner {
  plan(scope: TrustedRuntimeAccessScope): CodexSetupInspectionPlan;
}
