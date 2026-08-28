import { createDiscoverClaudeCodeInstallations } from "../application/discover-claude-code-installations.js";
import { createDiscoverCodexInstallations } from "../application/discover-codex-installations.js";
import type { ExecutableFileObserver } from "../application/ports/outbound/executable-file-observation.js";

export interface RuntimeInstallationDiscoveryDependencies {
  readonly executableFileObserver: ExecutableFileObserver;
}

export const createRuntimeInstallationDiscoveryFeature = (
  dependencies: RuntimeInstallationDiscoveryDependencies,
) =>
  Object.freeze({
    discoverClaudeCodeInstallations: createDiscoverClaudeCodeInstallations(
      dependencies.executableFileObserver,
    ),
    discoverCodexInstallations: createDiscoverCodexInstallations(
      dependencies.executableFileObserver,
    ),
  });
