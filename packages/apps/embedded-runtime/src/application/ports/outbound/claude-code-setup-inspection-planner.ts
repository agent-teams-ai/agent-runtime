import type {
  ClaudeCodeConfigurationSourceKind,
  ClaudeCodeConfigurationDialect,
} from "@agent-teams/runtime-configuration";

import type { TrustedClaudeCodeSetupScope } from "../../trusted-claude-code-setup-scope.js";

export interface ClaudeCodeSetupInspectionPlan {
  readonly candidatePaths: readonly {
    readonly absolutePath: string;
    readonly source: "explicit" | "known-location" | "path-entry";
  }[];
  readonly dialect: ClaudeCodeConfigurationDialect;
  readonly sourcePaths: readonly {
    readonly absolutePath: string;
    readonly kind: ClaudeCodeConfigurationSourceKind;
  }[];
  readonly status: "planned";
}

export interface ClaudeCodeSetupInspectionPlanner {
  plan(scope: TrustedClaudeCodeSetupScope): ClaudeCodeSetupInspectionPlan | {
    readonly status: "unsupported";
  };
}
