import type {
  SetupAuthorizationDiagnostic,
  TrustedInstallationCandidate,
} from "@agent-teams/runtime-security";

import type {
  CodexSetupInspectionPlan,
  CodexSetupInspectionPlanner,
} from "../application/ports/outbound/codex-setup-inspection-planner.js";
import type { TrustedCodexSetupScope } from "../application/trusted-runtime-access-scope.js";

const isDarwinAbsolutePath = (value: string): boolean => value.startsWith("/");

const codexExecutablePath = (directory: string): string =>
  `${directory}${directory.endsWith("/") ? "" : "/"}codex`;

const planDirectoryCandidates = (
  values: readonly string[],
  source: "known-location" | "path-entry",
  diagnostics: SetupAuthorizationDiagnostic[],
  candidates: TrustedInstallationCandidate[],
): void => {
  for (const value of values) {
    if (value.length === 0) {
      diagnostics.push({
        code: "empty_path_entry",
        subject: source,
      });
    } else if (!isDarwinAbsolutePath(value)) {
      diagnostics.push({
        code: "relative_path_entry",
        subject: source,
      });
    } else {
      candidates.push({
        absolutePath: codexExecutablePath(value),
        required: false,
        source,
      });
    }
  }
};

export const createCodexSetupInspectionPlanner = (
  hostPlatform: NodeJS.Platform,
): CodexSetupInspectionPlanner =>
  Object.freeze({
    plan(scope: TrustedCodexSetupScope): CodexSetupInspectionPlan {
      if (hostPlatform !== "darwin") {
        return { status: "unsupported" };
      }
      const diagnostics: SetupAuthorizationDiagnostic[] = [];
      const installationCandidates: TrustedInstallationCandidate[] = [];
      planDirectoryCandidates(
        scope.pathEntries,
        "path-entry",
        diagnostics,
        installationCandidates,
      );
      planDirectoryCandidates(
        scope.knownExecutableDirectories,
        "known-location",
        diagnostics,
        installationCandidates,
      );
      for (const absolutePath of scope.explicitCodexExecutablePaths) {
        if (!isDarwinAbsolutePath(absolutePath)) {
          diagnostics.push({
            code: absolutePath.length === 0
              ? "empty_path_entry"
              : "relative_path_entry",
            subject: "explicit",
          });
        } else {
          installationCandidates.push({
            absolutePath,
            required: true,
            source: "explicit",
          });
        }
      }
      return {
        diagnostics,
        installationCandidates,
        status: "planned",
      };
    },
  });
