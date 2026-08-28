import type {
  ClaudeCodeSetupInspectionPlan,
  ClaudeCodeSetupInspectionPlanner,
} from "../application/ports/outbound/claude-code-setup-inspection-planner.js";
import type { TrustedClaudeCodeSetupScope } from "../application/trusted-claude-code-setup-scope.js";

const appendPath = (root: string, suffix: string): string =>
  `${root.endsWith("/") ? root.slice(0, -1) : root}/${suffix}`;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const createClaudeCodeSetupInspectionPlanner = (
  hostPlatform: NodeJS.Platform,
): ClaudeCodeSetupInspectionPlanner => Object.freeze({
  plan(scope: TrustedClaudeCodeSetupScope): ClaudeCodeSetupInspectionPlan {
    if (hostPlatform !== "darwin") {
      return { status: "unsupported" };
    }
    const explicit = scope.explicitExecutablePaths
      .map(absolutePath => ({
        absolutePath,
        priorityRank: 1 as const,
        source: "explicit" as const,
      }))
      .toSorted((left, right) => compareText(left.absolutePath, right.absolutePath));
    const pathEntries = scope.pathEntries
      .map(directory => ({
        absolutePath: appendPath(directory, "claude"),
        priorityRank: 2 as const,
        source: "path-entry" as const,
      }))
      .toSorted((left, right) => compareText(left.absolutePath, right.absolutePath));
    return Object.freeze({
      candidatePaths: Object.freeze([
        ...explicit,
        ...pathEntries,
        {
          absolutePath: appendPath(scope.homeRoot, ".local/bin/claude"),
          priorityRank: 3 as const,
          source: "known-location" as const,
        },
        {
          absolutePath: "/opt/homebrew/bin/claude",
          priorityRank: 4 as const,
          source: "known-location" as const,
        },
        {
          absolutePath: "/usr/local/bin/claude",
          priorityRank: 5 as const,
          source: "known-location" as const,
        },
      ].map(candidate => Object.freeze(candidate))),
      dialect: scope.dialect,
      sourcePaths: Object.freeze([
        {
          absolutePath: appendPath(scope.homeRoot, ".claude/settings.json"),
          kind: "user" as const,
        },
        {
          absolutePath: appendPath(scope.workspaceRoot, ".claude/settings.json"),
          kind: "shared-project" as const,
        },
        {
          absolutePath: appendPath(scope.workspaceRoot, ".claude/settings.local.json"),
          kind: "project-local" as const,
        },
      ].map(source => Object.freeze(source))),
      status: "planned" as const,
    });
  },
});
