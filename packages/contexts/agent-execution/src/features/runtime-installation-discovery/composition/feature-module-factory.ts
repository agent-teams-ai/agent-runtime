import { createDiscoverClaudeCodeInstallations } from "../application/discover-claude-code-installations.js";
import { createDiscoverCodexInstallations } from "../application/discover-codex-installations.js";
import type { ExecutableFileObserver } from "../application/ports/outbound/executable-file-observation.js";
import {
  mapDiscoverClaudeCodeInstallations,
  mapDiscoverCodexInstallations,
} from "../adapters/inbound/public-runtime-installation-discovery.js";
import type {
  RuntimeInstallationDiscoveryDependencies,
  RuntimeInstallationDiscoveryFeature,
} from "../contracts/runtime-installation-discovery-feature.js";

const mapExecutableFileObserver = (
  observer: RuntimeInstallationDiscoveryDependencies["executableFileObserver"],
): ExecutableFileObserver => ({
  observe: request => observer.observe({
    absolutePath: request.absolutePath,
    authorizedFileIdentity: request.authorizedFileIdentity,
    custodyBoundary:
      request.custodyBoundary === undefined
        ? request.custodyBoundary
        : {
            absolutePath: request.custodyBoundary.absolutePath,
            canonicalPath: request.custodyBoundary.canonicalPath,
          },
    expectedCanonicalPath: request.expectedCanonicalPath,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }),
});

export const createRuntimeInstallationDiscoveryFeature = (
  dependencies: RuntimeInstallationDiscoveryDependencies,
): RuntimeInstallationDiscoveryFeature => {
  const observer = mapExecutableFileObserver(dependencies.executableFileObserver);
  return Object.freeze({
    discoverClaudeCodeInstallations: mapDiscoverClaudeCodeInstallations(
      createDiscoverClaudeCodeInstallations(observer),
    ),
    discoverCodexInstallations: mapDiscoverCodexInstallations(
      createDiscoverCodexInstallations(observer),
    ),
  });
};
