import { createDiscoverClaudeCodeInstallations } from "../application/discover-claude-code-installations.js";
import { createDiscoverCodexInstallations } from "../application/discover-codex-installations.js";
import { createNodeReferenceDigest } from "../adapters/outbound/node-reference-digest.js";
import type { ExecutableFileObserver } from "../application/ports/outbound/executable-file-observation.js";
import {
  mapDiscoverClaudeCodeInstallations,
  mapDiscoverCodexInstallations,
} from "../adapters/inbound/public-runtime-installation-discovery.js";
import type {
  RuntimeInstallationDiscoveryDependencies,
} from "../contracts/runtime-installation-discovery-feature.js";
import type { DiscoverClaudeCodeInstallations } from "../contracts/claude-code-installation-observation.js";
import type { DiscoverCodexInstallations } from "../contracts/runtime-installation-observation.js";

interface RuntimeInstallationDiscoveryFeature {
  readonly discoverClaudeCodeInstallations: DiscoverClaudeCodeInstallations;
  readonly discoverCodexInstallations: DiscoverCodexInstallations;
}

const mapObservation = (
  observation: Awaited<ReturnType<RuntimeInstallationDiscoveryDependencies["executableFileObserver"]["observe"]>>,
) => {
  switch (observation.kind) {
    case "found":
      return { identity: observation.identity, kind: observation.kind } as const;
    case "denied":
    case "invalid":
    case "missing":
    case "unstable":
    case "unreadable":
      return { kind: observation.kind } as const;
  }
};

const mapExecutableFileObserver = (
  observer: RuntimeInstallationDiscoveryDependencies["executableFileObserver"],
): ExecutableFileObserver => ({
  async observe(request) {
    const custodyBoundary =
      request.custodyBoundary === undefined
        ? request.custodyBoundary
        : {
            absolutePath: request.custodyBoundary.absolutePath,
            canonicalPath: request.custodyBoundary.canonicalPath,
          };
    const observation = request.signal === undefined
      ? await observer.observe({
          absolutePath: request.absolutePath,
          authorizedFileIdentity: request.authorizedFileIdentity,
          custodyBoundary: custodyBoundary!,
          expectedCanonicalPath: request.expectedCanonicalPath,
        })
      : await observer.observe({
          absolutePath: request.absolutePath,
          authorizedFileIdentity: request.authorizedFileIdentity,
          custodyBoundary: custodyBoundary!,
          expectedCanonicalPath: request.expectedCanonicalPath,
          signal: request.signal,
        });
    return mapObservation(observation);
  },
});

export const createRuntimeInstallationDiscoveryFeature = (
  dependencies: RuntimeInstallationDiscoveryDependencies,
): RuntimeInstallationDiscoveryFeature => {
  const observer = mapExecutableFileObserver(dependencies.executableFileObserver);
  const referenceDigest = createNodeReferenceDigest();
  return Object.freeze({
    discoverClaudeCodeInstallations: mapDiscoverClaudeCodeInstallations(
      createDiscoverClaudeCodeInstallations(observer, referenceDigest),
    ),
    discoverCodexInstallations: mapDiscoverCodexInstallations(
      createDiscoverCodexInstallations(observer, referenceDigest),
    ),
  });
};
