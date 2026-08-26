import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createCodexConfigurationInspectionFeature,
  createNodeConfigurationSourceReader,
  createSmolTomlParser,
} from "@agent-teams/runtime-configuration/composition";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "@agent-teams/runtime-security/composition";

import {
  createBuildCodexSetupView,
  type BuildCodexSetupViewDependencies,
} from "../application/build-codex-setup-view.js";
import type {
  InspectCodexRuntimeSetup,
  RuntimeAccessHandle,
} from "../contracts/runtime-access.js";
import {
  copyTrustedRuntimeAccessScope,
  type TrustedRuntimeAccessScope,
} from "./trusted-runtime-access-scope.js";

export interface AgentRuntimeHost extends AsyncDisposable {
  bindAccess(scope: TrustedRuntimeAccessScope): RuntimeAccessHandle;
  dispose(): Promise<void>;
}

export const createAgentRuntimeHost = (
  dependencies: BuildCodexSetupViewDependencies,
): AgentRuntimeHost => {
  const buildCodexSetupView = createBuildCodexSetupView(dependencies);
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) {
      throw new Error("Agent Runtime Host is disposed");
    }
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
  };

  return Object.freeze({
    bindAccess(scope: TrustedRuntimeAccessScope) {
      assertActive();
      const boundScope = copyTrustedRuntimeAccessScope(scope);
      return Object.freeze({
        codexSetup: Object.freeze({
          inspect: async (
            input: InspectCodexRuntimeSetup,
            options?: { readonly signal?: AbortSignal },
          ) => {
            assertActive();
            return buildCodexSetupView(boundScope, input, options);
          },
        }),
      });
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  });
};

export const createDefaultAgentRuntimeHost = (): AgentRuntimeHost => {
  const security = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: createNodePathCanonicalizer(),
  });
  const execution = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const configuration = createCodexConfigurationInspectionFeature({
    parser: createSmolTomlParser(),
    sourceReader: createNodeConfigurationSourceReader(),
  });

  return createAgentRuntimeHost({
    authorizeSetupInspection: security.authorizeSetupInspection,
    discoverCodexInstallations: execution.discoverCodexInstallations,
    inspectCodexConfiguration: configuration.inspectCodexConfiguration,
  });
};
