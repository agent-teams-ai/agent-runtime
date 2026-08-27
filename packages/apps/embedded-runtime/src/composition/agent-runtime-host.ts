import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

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

const settleActiveCalls = async (activeCalls: ReadonlySet<Promise<unknown>>): Promise<void> => {
  await Promise.allSettled(activeCalls);
};

const waitForDisposalDeadline = async (): Promise<void> => {
  await delay(1_000, null, { ref: false });
};

export const createAgentRuntimeHost = (
  dependencies: BuildCodexSetupViewDependencies,
): AgentRuntimeHost => {
  const buildCodexSetupView = createBuildCodexSetupView(dependencies, randomBytes(32));
  const hostAbort = new AbortController();
  const activeCalls = new Set<Promise<unknown>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const assertActive = (): void => {
    if (disposed) {
      throw new Error("Agent Runtime Host is disposed");
    }
  };

  const dispose = (): Promise<void> => {
    if (disposal !== undefined) {
      return disposal;
    }
    disposed = true;
    hostAbort.abort(new DOMException("Agent Runtime Host is disposed", "AbortError"));
    disposal = Promise.race([settleActiveCalls(activeCalls), waitForDisposalDeadline()]);
    return disposal;
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
            const signal =
              options?.signal === undefined
                ? hostAbort.signal
                : AbortSignal.any([hostAbort.signal, options.signal]);
            let call: Promise<unknown>;
            call = buildCodexSetupView(boundScope, input, { signal })
              .then(result => {
                signal.throwIfAborted();
                return result;
              })
              .finally(() => activeCalls.delete(call));
            activeCalls.add(call);
            return call as ReturnType<RuntimeAccessHandle["codexSetup"]["inspect"]>;
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
    sourceIdentityKey: randomBytes(32),
    sourceReader: createNodeConfigurationSourceReader(),
  });

  return createAgentRuntimeHost({
    authorizeSetupInspection: security.authorizeSetupInspection,
    discoverCodexInstallations: execution.discoverCodexInstallations,
    inspectCodexConfiguration: configuration.inspectCodexConfiguration,
  });
};
