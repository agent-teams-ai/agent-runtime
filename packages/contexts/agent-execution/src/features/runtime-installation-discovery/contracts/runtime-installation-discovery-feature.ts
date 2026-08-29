import type { ExecutableFileObserver } from "./executable-file-observation.js";

export interface RuntimeInstallationDiscoveryDependencies {
  readonly executableFileObserver: ExecutableFileObserver;
}
