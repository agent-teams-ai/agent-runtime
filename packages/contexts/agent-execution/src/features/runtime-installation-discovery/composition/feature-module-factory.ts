import { createNodeStableIdentityHasher } from "../adapters/outbound/node-stable-identity-hasher.js";
import { createDiscoverClaudeCodeInstallations } from "../application/discover-claude-code-installations.js";
import { createDiscoverCodexInstallations } from "../application/discover-codex-installations.js";
import type {
  ClaudeCodeInstallationCandidate as ApplicationClaudeCodeInstallationCandidate,
  DiscoverClaudeCodeInstallationsResult as ApplicationDiscoverClaudeCodeInstallationsResult,
  CodexInstallationCandidate as ApplicationCodexInstallationCandidate,
  DiscoverCodexInstallationsResult as ApplicationDiscoverCodexInstallationsResult,
} from "../application/models/installation-observation.js";
import type { ExecutableFileObserver } from "../application/ports/outbound/executable-file-observation.js";
import type {
  ClaudeCodeInstallationCandidate,
  DiscoverClaudeCodeInstallations,
  DiscoverClaudeCodeInstallationsResult,
} from "../contracts/claude-code-installation-observation.js";
import type {
  DiscoverCodexInstallations,
  DiscoverCodexInstallationsResult,
  InstallationCandidate,
} from "../contracts/runtime-installation-observation.js";

export interface RuntimeInstallationDiscoveryDependencies {
  readonly executableFileObserver: ExecutableFileObserver;
}

const toApplicationCodexCandidate = (
  candidate: InstallationCandidate,
): ApplicationCodexInstallationCandidate => candidate;

const toApplicationClaudeCodeCandidate = (
  candidate: ClaudeCodeInstallationCandidate,
): ApplicationClaudeCodeInstallationCandidate => candidate;

const toCodexContractResult = (
  result: ApplicationDiscoverCodexInstallationsResult,
): DiscoverCodexInstallationsResult => result;

const toClaudeCodeContractResult = (
  result: ApplicationDiscoverClaudeCodeInstallationsResult,
): DiscoverClaudeCodeInstallationsResult => result;

export const createRuntimeInstallationDiscoveryFeature = (
  dependencies: RuntimeInstallationDiscoveryDependencies,
) => {
  const identityHasher = createNodeStableIdentityHasher();
  const discoverClaudeCodeInstallations = createDiscoverClaudeCodeInstallations(
    dependencies.executableFileObserver,
    identityHasher,
  );
  const discoverCodexInstallations = createDiscoverCodexInstallations(
    dependencies.executableFileObserver,
    identityHasher,
  );

  const claudeCodeContract: DiscoverClaudeCodeInstallations = {
    async execute(input, options) {
      return toClaudeCodeContractResult(
        await discoverClaudeCodeInstallations.execute(
          {
            candidates: input.candidates.map(toApplicationClaudeCodeCandidate),
            observationEpoch: input.observationEpoch,
          },
          options,
        ),
      );
    },
  };
  const codexContract: DiscoverCodexInstallations = {
    async execute(input, options) {
      return toCodexContractResult(
        await discoverCodexInstallations.execute(
          {
            candidates: input.candidates.map(toApplicationCodexCandidate),
            observationEpoch: input.observationEpoch,
          },
          options,
        ),
      );
    },
  };

  return Object.freeze({
    discoverClaudeCodeInstallations: claudeCodeContract,
    discoverCodexInstallations: codexContract,
  });
};
