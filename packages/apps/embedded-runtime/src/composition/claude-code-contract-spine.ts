import type {
  AuthorizeClaudeCodeSetupInspection,
} from "@agent-teams/runtime-security";
import type {
  DiscoverClaudeCodeInstallations,
} from "@agent-teams/agent-execution";
import type {
  InspectClaudeCodeConfiguration,
} from "@agent-teams/runtime-configuration";

import type { ClaudeCodeSetupInspectionPlanner } from "../application/ports/outbound/claude-code-setup-inspection-planner.js";

export interface ClaudeCodeContractSpineDependencies {
  readonly authorizeClaudeCodeSetupInspection: AuthorizeClaudeCodeSetupInspection;
  readonly discoverClaudeCodeInstallations: DiscoverClaudeCodeInstallations;
  readonly inspectClaudeCodeConfiguration: InspectClaudeCodeConfiguration;
  readonly planClaudeCodeSetupInspection: ClaudeCodeSetupInspectionPlanner;
}

export const assertClaudeCodeContractSpine = (
  dependencies: ClaudeCodeContractSpineDependencies,
): ClaudeCodeContractSpineDependencies => Object.freeze({ ...dependencies });
