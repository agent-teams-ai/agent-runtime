import { createNodeExecutableFileObserver as createNodeObserver } from "./adapters/outbound/node-executable-file-observer.js";
import { createRuntimeInstallationDiscoveryFeature as createFeature } from "./composition/feature-module-factory.js";
import type { ExecutableFileObserver } from "./contracts/executable-file-observation.js";
import type {
  RuntimeInstallationDiscoveryDependencies,
  RuntimeInstallationDiscoveryFeature,
} from "./contracts/runtime-installation-discovery-feature.js";

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
): ExecutableFileObserver => createNodeObserver(dependencies);

export const createRuntimeInstallationDiscoveryFeature = (
  dependencies: RuntimeInstallationDiscoveryDependencies,
): RuntimeInstallationDiscoveryFeature => createFeature(dependencies);

export type {
  ClaudeCodeInstallationCandidate,
  ClaudeCodeInstallationCandidateSource,
  ClaudeCodeInstallationDiagnostic,
  ClaudeCodeInstallationObservation,
  DiscoverClaudeCodeInstallations,
  DiscoverClaudeCodeInstallationsInput,
  DiscoverClaudeCodeInstallationsResult,
} from "./contracts/claude-code-installation-observation.js";
export type {
  ExecutableFileObservation,
  ExecutableFileObservationRequest,
  ExecutableFileObserver,
} from "./contracts/executable-file-observation.js";
export type {
  RuntimeInstallationDiscoveryDependencies,
  RuntimeInstallationDiscoveryFeature,
} from "./contracts/runtime-installation-discovery-feature.js";
export type {
  DiscoverCodexInstallations,
  DiscoverCodexInstallationsInput,
  DiscoverCodexInstallationsResult,
  InstallationCandidate,
  InstallationCandidateSource,
  RuntimeInstallationDiagnostic,
  RuntimeInstallationObservation,
} from "./contracts/runtime-installation-observation.js";
