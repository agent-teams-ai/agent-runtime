import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1,
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

const raceWithAbort = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      settle(() => reject(
        signal.reason ?? new DOMException("Agent Runtime inspection was cancelled", "AbortError"),
      ));
    };

    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    );
  });

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
            signal.throwIfAborted();
            const operation = buildCodexSetupView(boundScope, input, { signal });
            activeCalls.add(operation);
            operation.then(
              () => activeCalls.delete(operation),
              () => activeCalls.delete(operation),
            );
            return raceWithAbort(operation, signal);
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
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(),
    sourceIdentityKey: randomBytes(32),
    sourceReader: createNodeConfigurationSourceReader(),
  });

  return createAgentRuntimeHost({
    authorizeSetupInspection: security.authorizeSetupInspection,
    discoverCodexInstallations: execution.discoverCodexInstallations,
    inspectCodexConfiguration: configuration.inspectCodexConfiguration,
  });
};
