import { createNodeExecutableFileObserver as createNodeObserver } from "./adapters/outbound/node-executable-file-observer.js";
import { createRuntimeInstallationDiscoveryFeature as createFeature } from "./composition/feature-module-factory.js";
import type { DiscoverClaudeCodeInstallations } from "./contracts/claude-code-installation-observation.js";
import type { ExecutableFileObserver } from "./contracts/executable-file-observation.js";
import type { RuntimeInstallationDiscoveryDependencies } from "./contracts/runtime-installation-discovery-feature.js";
import type { DiscoverCodexInstallations } from "./contracts/runtime-installation-observation.js";

export const createNodeExecutableFileObserver = (
  dependencies: {
    readonly effectiveIdentity?: {
      readonly gid: number;
      readonly groups: readonly number[];
      readonly uid: number;
    };
    readonly effectiveIdentitySupplier?: () =>
      | {
          readonly gid: number;
          readonly groups: readonly number[];
          readonly uid: number;
        }
      | undefined;
  } = {},
): ExecutableFileObserver => {
  const effectiveIdentity =
    dependencies.effectiveIdentity === undefined
      ? undefined
      : {
          gid: dependencies.effectiveIdentity.gid,
          groups: [...dependencies.effectiveIdentity.groups],
          uid: dependencies.effectiveIdentity.uid,
        };
  if (effectiveIdentity === undefined) {
    return dependencies.effectiveIdentitySupplier === undefined
      ? createNodeObserver()
      : createNodeObserver({
          effectiveIdentitySupplier: dependencies.effectiveIdentitySupplier,
        });
  }
  return dependencies.effectiveIdentitySupplier === undefined
    ? createNodeObserver({ effectiveIdentity })
    : createNodeObserver({
        effectiveIdentity,
        effectiveIdentitySupplier: dependencies.effectiveIdentitySupplier,
      });
};

export const createRuntimeInstallationDiscoveryFeature = (
  dependencies: RuntimeInstallationDiscoveryDependencies,
): {
  readonly discoverClaudeCodeInstallations: DiscoverClaudeCodeInstallations;
  readonly discoverCodexInstallations: DiscoverCodexInstallations;
} =>
  createFeature({
    executableFileObserver: dependencies.executableFileObserver,
  });

export type {
  ExecutableFileObservation,
  ExecutableFileObservationRequest,
  ExecutableFileObserver,
} from "./contracts/executable-file-observation.js";
export type { RuntimeInstallationDiscoveryDependencies } from "./contracts/runtime-installation-discovery-feature.js";
