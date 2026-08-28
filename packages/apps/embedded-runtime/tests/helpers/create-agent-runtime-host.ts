import {
  createAgentRuntimeHost as createClosedAgentRuntimeHost,
  type BuildClaudeCodeSetupViewDependencies,
  type BuildCodexSetupViewDependencies,
} from "../../dist/composition.js";

export const createAgentRuntimeHost = (
  dependencies: BuildCodexSetupViewDependencies & BuildClaudeCodeSetupViewDependencies,
) => createClosedAgentRuntimeHost({
  claudeCodeSetup: {
    authorizeClaudeCodeSetupInspection: dependencies.authorizeClaudeCodeSetupInspection,
    discoverClaudeCodeInstallations: dependencies.discoverClaudeCodeInstallations,
    inspectClaudeCodeConfiguration: dependencies.inspectClaudeCodeConfiguration,
    planClaudeCodeSetupInspection: dependencies.planClaudeCodeSetupInspection,
  },
  codexSetup: {
    authorizeSetupInspection: dependencies.authorizeSetupInspection,
    discoverCodexInstallations: dependencies.discoverCodexInstallations,
    inspectCodexConfiguration: dependencies.inspectCodexConfiguration,
    planCodexSetupInspection: dependencies.planCodexSetupInspection,
  },
});
