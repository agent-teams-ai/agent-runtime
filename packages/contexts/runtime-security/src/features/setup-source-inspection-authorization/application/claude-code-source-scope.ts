import { isAbsolute, join } from "node:path";

import type {
  ClaudeCodePortableSourceKind,
  TrustedClaudeCodeSetupInspectionScope,
} from "../contracts/claude-code-setup-inspection-authorization.js";

export interface ClaudeCodeSourceRequest {
  readonly absolutePath: string;
  readonly kind: ClaudeCodePortableSourceKind;
  readonly rootKind: "home" | "workspace";
}

const MAX_PATH_LENGTH = 16_384;
const SOURCE_SLOTS = 3;

const pathIsBoundedAbsolute = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_PATH_LENGTH &&
  !path.includes("\0") &&
  isAbsolute(path);

export const prepareClaudeCodeSourceRequests = (
  scope: TrustedClaudeCodeSetupInspectionScope,
): readonly ClaudeCodeSourceRequest[] | undefined => {
  const requests = scope.sourcePaths.map(source => ({
    absolutePath: source.absolutePath,
    kind: source.kind,
    rootKind: source.kind === "user" ? "home" as const : "workspace" as const,
  }));
  const expectedPaths: Readonly<Record<ClaudeCodePortableSourceKind, string>> = {
    "project-local": join(
      scope.workspaceRoot,
      ".claude",
      "settings.local.json",
    ),
    "shared-project": join(scope.workspaceRoot, ".claude", "settings.json"),
    user: join(scope.homeRoot, ".claude", "settings.json"),
  };
  const invalid =
    requests.length !== SOURCE_SLOTS ||
    new Set(requests.map(request => request.kind)).size !== SOURCE_SLOTS ||
    requests.some(request =>
      request.kind !== "user" &&
      request.kind !== "shared-project" &&
      request.kind !== "project-local"
    ) ||
    requests.some(request => !pathIsBoundedAbsolute(request.absolutePath)) ||
    requests.some(request => request.absolutePath !== expectedPaths[request.kind]);
  return invalid ? undefined : requests;
};
