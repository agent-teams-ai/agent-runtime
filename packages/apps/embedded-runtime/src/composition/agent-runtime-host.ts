import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV2,
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

export type CodexSetupCapabilityBundle = BuildCodexSetupViewDependencies;

export type ClaudeCodeSetupCapabilityBundle = BuildClaudeCodeSetupViewDependencies;

export interface AgentRuntimeHostDependencies {
  readonly claudeCodeSetup: ClaudeCodeSetupCapabilityBundle;
  readonly codexSetup: CodexSetupCapabilityBundle;
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
  executableCompatibility: "unqualified" as const,
  interactiveShellPath: "unobserved" as const,
  managedPolicy: "unobserved" as const,
  modelCompatibility: "unobserved" as const,
  precedence: "not-evaluated" as const,
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

function assertClosedPlainBundle(
  value: unknown,
  bundleName: string,
  expectedBindings: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${bundleName} must be a plain capability bundle`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${bundleName} must be a plain capability bundle`);
  }

  const expectedKeys = expectedBindings.toSorted();
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some(key => typeof key !== "string") ||
    actualKeys.map(String).toSorted().join("\0") !== expectedKeys.join("\0")) {
    throw new TypeError(`${bundleName} must contain exactly: ${expectedKeys.join(", ")}`);
  }
}

const snapshotCapabilityMethod = <Method>(
  bundle: Record<string, unknown>,
  bundleName: string,
  bindingName: string,
  methodName: "execute" | "plan",
): Method => {
  const binding = bundle[bindingName];
  if ((typeof binding !== "object" && typeof binding !== "function") || binding === null) {
    throw new TypeError(`${bundleName}.${bindingName} must provide ${methodName}()`);
  }
  const method = (binding as Record<"execute" | "plan", unknown>)[methodName];
  if (typeof method !== "function") {
    throw new TypeError(`${bundleName}.${bindingName} must provide ${methodName}()`);
  }
  return method.bind(binding) as Method;
};

const snapshotAgentRuntimeHostDependencies = (
  value: unknown,
): AgentRuntimeHostDependencies => {
  assertClosedPlainBundle(value, "Agent Runtime capability dependencies", [
    "claudeCodeSetup",
    "codexSetup",
  ]);
  const claudeCodeSetup = value.claudeCodeSetup;
  const codexSetup = value.codexSetup;
  assertClosedPlainBundle(
    claudeCodeSetup,
    "Claude Code setup capability bundle",
    [
      "authorizeClaudeCodeSetupInspection",
      "discoverClaudeCodeInstallations",
      "inspectClaudeCodeConfiguration",
      "planClaudeCodeSetupInspection",
    ],
  );
  assertClosedPlainBundle(
    codexSetup,
    "Codex setup capability bundle",
    [
      "authorizeSetupInspection",
      "discoverCodexInstallations",
      "inspectCodexConfiguration",
      "planCodexSetupInspection",
    ],
  );

  return Object.freeze({
    claudeCodeSetup: Object.freeze({
      authorizeClaudeCodeSetupInspection: Object.freeze({
        execute: snapshotCapabilityMethod<ClaudeCodeSetupCapabilityBundle["authorizeClaudeCodeSetupInspection"]["execute"]>(claudeCodeSetup, "Claude Code setup capability bundle", "authorizeClaudeCodeSetupInspection", "execute"),
      }),
      discoverClaudeCodeInstallations: Object.freeze({
        execute: snapshotCapabilityMethod<ClaudeCodeSetupCapabilityBundle["discoverClaudeCodeInstallations"]["execute"]>(claudeCodeSetup, "Claude Code setup capability bundle", "discoverClaudeCodeInstallations", "execute"),
      }),
      inspectClaudeCodeConfiguration: Object.freeze({
        execute: snapshotCapabilityMethod<ClaudeCodeSetupCapabilityBundle["inspectClaudeCodeConfiguration"]["execute"]>(claudeCodeSetup, "Claude Code setup capability bundle", "inspectClaudeCodeConfiguration", "execute"),
      }),
      planClaudeCodeSetupInspection: Object.freeze({
        plan: snapshotCapabilityMethod<ClaudeCodeSetupCapabilityBundle["planClaudeCodeSetupInspection"]["plan"]>(claudeCodeSetup, "Claude Code setup capability bundle", "planClaudeCodeSetupInspection", "plan"),
      }),
    }),
    codexSetup: Object.freeze({
      authorizeSetupInspection: Object.freeze({
        execute: snapshotCapabilityMethod<CodexSetupCapabilityBundle["authorizeSetupInspection"]["execute"]>(codexSetup, "Codex setup capability bundle", "authorizeSetupInspection", "execute"),
      }),
      discoverCodexInstallations: Object.freeze({
        execute: snapshotCapabilityMethod<CodexSetupCapabilityBundle["discoverCodexInstallations"]["execute"]>(codexSetup, "Codex setup capability bundle", "discoverCodexInstallations", "execute"),
      }),
      inspectCodexConfiguration: Object.freeze({
        execute: snapshotCapabilityMethod<CodexSetupCapabilityBundle["inspectCodexConfiguration"]["execute"]>(codexSetup, "Codex setup capability bundle", "inspectCodexConfiguration", "execute"),
      }),
      planCodexSetupInspection: Object.freeze({
        plan: snapshotCapabilityMethod<CodexSetupCapabilityBundle["planCodexSetupInspection"]["plan"]>(codexSetup, "Codex setup capability bundle", "planCodexSetupInspection", "plan"),
      }),
    }),
  });
};

export const createAgentRuntimeHost = (
  dependencies: AgentRuntimeHostDependencies,
): AgentRuntimeHost => {
  const capabilityDependencies = snapshotAgentRuntimeHostDependencies(dependencies);
  const buildCodexSetupView = createBuildCodexSetupView(
    capabilityDependencies.codexSetup,
    randomBytes(32),
  );
  const buildClaudeCodeSetupView = createBuildClaudeCodeSetupView(
    capabilityDependencies.claudeCodeSetup,
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
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(),
    sourceIdentityKey: randomBytes(32),
    sourceReader: createClaudeCodeConfigurationSourceReaderAdapter(),
  });

  return createAgentRuntimeHost({
    claudeCodeSetup: {
      authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
      discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
      inspectClaudeCodeConfiguration: claudeConfiguration,
      planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner(process.platform),
    },
    codexSetup: {
      authorizeSetupInspection: security.authorizeSetupInspection,
      discoverCodexInstallations: execution.discoverCodexInstallations,
      inspectCodexConfiguration: configuration.inspectCodexConfiguration,
      planCodexSetupInspection: createCodexSetupInspectionPlanner(process.platform),
    },
  });
};
