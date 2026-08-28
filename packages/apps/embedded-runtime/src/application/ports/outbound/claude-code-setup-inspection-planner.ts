import type {
  ClaudeCodeConfigurationSourceKind,
  ClaudeCodeConfigurationDialect,
} from "@agent-teams/runtime-configuration";

import type { TrustedClaudeCodeSetupScope } from "../../trusted-claude-code-setup-scope.js";

export type ClaudeCodeSetupInspectionPlan =
  | { readonly status: "unsupported" }
  | {
      readonly candidatePaths: readonly {
        readonly absolutePath: string;
        readonly priorityRank: 1 | 2 | 3 | 4 | 5;
        readonly source: "explicit" | "known-location" | "path-entry";
      }[];
      readonly dialect: ClaudeCodeConfigurationDialect;
      readonly sourcePaths: readonly {
        readonly absolutePath: string;
        readonly kind: ClaudeCodeConfigurationSourceKind;
      }[];
      readonly status: "planned";
    };

export interface ClaudeCodeSetupInspectionPlanner {
  plan(scope: TrustedClaudeCodeSetupScope): ClaudeCodeSetupInspectionPlan;
}
