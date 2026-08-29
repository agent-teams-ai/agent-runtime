import type { DiscoverClaudeCodeInstallations } from "./claude-code-installation-observation.js";
import type { ExecutableFileObserver } from "./executable-file-observation.js";
import type { DiscoverCodexInstallations } from "./runtime-installation-observation.js";

export interface RuntimeInstallationDiscoveryDependencies {
  readonly executableFileObserver: ExecutableFileObserver;
}

export interface RuntimeInstallationDiscoveryFeature {
  readonly discoverClaudeCodeInstallations: DiscoverClaudeCodeInstallations;
  readonly discoverCodexInstallations: DiscoverCodexInstallations;
}
