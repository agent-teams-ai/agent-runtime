import type {
  ClaudeCodePortableSourceKind,
  TrustedClaudeCodeSetupInspectionScope,
} from "../contracts/claude-code-setup-inspection-authorization.js";
import type { PathAlgebra } from "./ports/outbound/path-algebra.js";

export interface ClaudeCodeSourceRequest {
  readonly absolutePath: string;
  readonly kind: ClaudeCodePortableSourceKind;
  readonly rootKind: "home" | "workspace";
}

const MAX_PATH_LENGTH = 16_384;
const SOURCE_SLOTS = 3;

const pathIsBoundedAbsolute = (pathAlgebra: PathAlgebra, path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_PATH_LENGTH &&
  !path.includes("\0") &&
  pathAlgebra.isAbsolute(path);

export const prepareClaudeCodeSourceRequests = (
  pathAlgebra: PathAlgebra,
  scope: TrustedClaudeCodeSetupInspectionScope,
): readonly ClaudeCodeSourceRequest[] | undefined => {
  const requests = scope.sourcePaths.map(source => ({
    absolutePath: source.absolutePath,
    kind: source.kind,
    rootKind: source.kind === "user" ? "home" as const : "workspace" as const,
  }));
  const expectedPaths: Readonly<Record<ClaudeCodePortableSourceKind, string>> = {
    "project-local": pathAlgebra.join(
      scope.workspaceRoot,
      ".claude",
      "settings.local.json",
    ),
    "shared-project": pathAlgebra.join(scope.workspaceRoot, ".claude", "settings.json"),
    user: pathAlgebra.join(scope.homeRoot, ".claude", "settings.json"),
  };
  const invalid =
    requests.length !== SOURCE_SLOTS ||
    new Set(requests.map(request => request.kind)).size !== SOURCE_SLOTS ||
    requests.some(request =>
      request.kind !== "user" &&
      request.kind !== "shared-project" &&
      request.kind !== "project-local"
    ) ||
    requests.some(request => !pathIsBoundedAbsolute(pathAlgebra, request.absolutePath)) ||
    requests.some(request => request.absolutePath !== expectedPaths[request.kind]);
  return invalid ? undefined : requests;
};
