import type {
  SetupAuthorizationDiagnostic,
  TrustedInstallationCandidate,
} from "@agent-teams/runtime-security";

import type { TrustedCodexSetupScope } from "../../trusted-runtime-access-scope.js";

export type CodexSetupInspectionPlan =
  | { readonly status: "unsupported" }
  | {
      readonly diagnostics: readonly SetupAuthorizationDiagnostic[];
      readonly installationCandidates: readonly TrustedInstallationCandidate[];
      readonly status: "planned";
    };

export interface CodexSetupInspectionPlanner {
  plan(scope: TrustedCodexSetupScope): CodexSetupInspectionPlan;
}
