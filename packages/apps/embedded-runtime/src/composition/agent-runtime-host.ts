import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV1,
  createClaudeCodeConfigurationSourceReaderAdapter,
  createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1,
  createNodeConfigurationSourceReader,
  createSmolTomlParser,
  createStrictClaudeCodeJsonParser,
} from "@agent-teams/runtime-configuration/composition";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "@agent-teams/runtime-security/composition";

import {
  createBuildClaudeCodeSetupView,
  type BuildClaudeCodeSetupViewDependencies,
} from "../application/build-claude-code-setup-view.js";
import {
  createBuildCodexSetupView,
  type BuildCodexSetupViewDependencies,
} from "../application/build-codex-setup-view.js";
import type {
  InspectCodexRuntimeSetup,
  InspectCodexRuntimeSetupOutcome,
  InspectClaudeCodeRuntimeSetupOutcome,
  RuntimeAccessHandle,
} from "../contracts/runtime-access.js";
import {
  copyTrustedClaudeCodeSetupScope,
  copyTrustedRuntimeAccessScope,
  type TrustedRuntimeAccessScope,
} from "./trusted-runtime-access-scope.js";
import { createCodexSetupInspectionPlanner } from "./codex-setup-inspection-planner.js";
import { createClaudeCodeSetupInspectionPlanner } from "./claude-code-setup-inspection-planner.js";

export interface AgentRuntimeHostDependencies extends BuildCodexSetupViewDependencies {
  readonly authorizeClaudeCodeSetupInspection?: BuildClaudeCodeSetupViewDependencies["authorizeClaudeCodeSetupInspection"];
  readonly discoverClaudeCodeInstallations?: BuildClaudeCodeSetupViewDependencies["discoverClaudeCodeInstallations"];
  readonly inspectClaudeCodeConfiguration?: BuildClaudeCodeSetupViewDependencies["inspectClaudeCodeConfiguration"];
  readonly planClaudeCodeSetupInspection?: BuildClaudeCodeSetupViewDependencies["planClaudeCodeSetupInspection"];
}

export interface AgentRuntimeHost extends AsyncDisposable {
  bindAccess(scope: TrustedRuntimeAccessScope): RuntimeAccessHandle;
  dispose(): Promise<void>;
}

export class AgentRuntimeHostDisposalIncompleteError extends Error {
  public readonly activeCallCount: number;

  public constructor(activeCallCount: number) {
    super("Agent Runtime Host disposal deadline elapsed with active calls");
    this.name = "AgentRuntimeHostDisposalIncompleteError";
    this.activeCallCount = activeCallCount;
  }
}

const settleActiveCalls = async (activeCalls: ReadonlySet<Promise<unknown>>): Promise<void> => {
  await Promise.allSettled(activeCalls);
};

const rejectAtDisposalDeadline = async (
  activeCalls: ReadonlySet<Promise<unknown>>,
): Promise<never> => {
  await delay(1_000, null, { ref: false });
  throw new AgentRuntimeHostDisposalIncompleteError(activeCalls.size);
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

const expectedClaudeCodeLimitations = Object.freeze({
  interactiveShellPath: "unobserved" as const,
  managedPolicy: "unobserved" as const,
  sessionOverrides: "unobserved" as const,
});

const claudeCodeUnavailableOutcome: InspectClaudeCodeRuntimeSetupOutcome = Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: "capability_unavailable" as const,
  })]),
  expectedLimitations: expectedClaudeCodeLimitations,
  status: "unsupported" as const,
});

const claudeCodeScopeLimitOutcome: InspectClaudeCodeRuntimeSetupOutcome = Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: "access_scope_limit_exceeded" as const,
  })]),
  expectedLimitations: expectedClaudeCodeLimitations,
  status: "unsupported" as const,
});

const codexScopeLimitOutcome: InspectCodexRuntimeSetupOutcome = Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: "access_scope_limit_exceeded" as const,
  })]),
  status: "unsupported" as const,
});

export const createAgentRuntimeHost = (
  dependencies: AgentRuntimeHostDependencies,
): AgentRuntimeHost => {
  const buildCodexSetupView = createBuildCodexSetupView(dependencies, randomBytes(32));
  const claudeDependencyCount = [
    dependencies.authorizeClaudeCodeSetupInspection,
    dependencies.discoverClaudeCodeInstallations,
    dependencies.inspectClaudeCodeConfiguration,
    dependencies.planClaudeCodeSetupInspection,
  ].filter(dependency => dependency !== undefined).length;
  if (claudeDependencyCount !== 0 && claudeDependencyCount !== 4) {
    throw new TypeError("Claude Code setup inspection dependencies must be supplied together");
  }
  const buildClaudeCodeSetupView = claudeDependencyCount === 0
    ? undefined
    : createBuildClaudeCodeSetupView(
      dependencies as BuildClaudeCodeSetupViewDependencies,
      randomBytes(32),
    );
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
    disposal = Promise.race([
      settleActiveCalls(activeCalls),
      rejectAtDisposalDeadline(activeCalls),
    ]);
    return disposal;
  };

  return Object.freeze({
    bindAccess(scope: TrustedRuntimeAccessScope) {
      assertActive();
      let claudeCodeScope: TrustedRuntimeAccessScope["claudeCodeSetup"];
      let claudeCodeScopeReadable = true;
      try {
        claudeCodeScope = scope.claudeCodeSetup;
      } catch {
        claudeCodeScopeReadable = false;
      }
      const claudeCodeUnavailable =
        buildClaudeCodeSetupView === undefined ||
        (claudeCodeScopeReadable && claudeCodeScope === undefined);
      const boundClaudeCodeScope = claudeCodeUnavailable || !claudeCodeScopeReadable ||
        claudeCodeScope === undefined
        ? undefined
        : copyTrustedClaudeCodeSetupScope(claudeCodeScope);
      const boundCodexScope = copyTrustedRuntimeAccessScope(scope);
      return Object.freeze({
        claudeCodeSetup: Object.freeze({
          inspect: async (options?: { readonly signal?: AbortSignal }) => {
            assertActive();
            const callerSignal = options?.signal;
            const signal = callerSignal === undefined
              ? hostAbort.signal
              : AbortSignal.any([hostAbort.signal, callerSignal]);
            signal.throwIfAborted();
            const operation: Promise<InspectClaudeCodeRuntimeSetupOutcome> =
              claudeCodeUnavailable
                ? Promise.resolve(claudeCodeUnavailableOutcome)
                : boundClaudeCodeScope === undefined
                  ? Promise.resolve(claudeCodeScopeLimitOutcome)
                  : buildClaudeCodeSetupView(boundClaudeCodeScope, { signal });
            activeCalls.add(operation);
            operation.then(
              () => activeCalls.delete(operation),
              () => activeCalls.delete(operation),
            );
            return raceWithAbort(operation, signal);
          },
        }),
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
            const operation: Promise<InspectCodexRuntimeSetupOutcome> =
              boundCodexScope === undefined
              ? Promise.resolve(codexScopeLimitOutcome)
              : buildCodexSetupView(boundCodexScope, input, { signal });
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
  const nodeConfigurationSourceReader = createNodeConfigurationSourceReader();
  const configuration = createCodexConfigurationInspectionFeature({
    parser: createSmolTomlParser(),
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(),
    sourceIdentityKey: randomBytes(32),
    sourceReader: nodeConfigurationSourceReader,
  });
  const claudeConfiguration = createClaudeCodeConfigurationInspectionFeature({
    parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV1(),
    sourceIdentityKey: randomBytes(32),
    sourceReader: createClaudeCodeConfigurationSourceReaderAdapter(),
  });

  return createAgentRuntimeHost({
    authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
    authorizeSetupInspection: security.authorizeSetupInspection,
    discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
    discoverCodexInstallations: execution.discoverCodexInstallations,
    inspectClaudeCodeConfiguration: claudeConfiguration,
    inspectCodexConfiguration: configuration.inspectCodexConfiguration,
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner(process.platform),
    planCodexSetupInspection: createCodexSetupInspectionPlanner(process.platform),
  });
};
