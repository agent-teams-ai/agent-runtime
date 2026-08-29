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
  copyTrustedCodexSetupScope,
  copyTrustedClaudeCodeSetupScope,
  copyTrustedContainedTurnScope,
  type TrustedRuntimeAccessScope,
} from "./trusted-runtime-access-scope.js";
import { createCodexSetupInspectionPlanner } from "./codex-setup-inspection-planner.js";
import { createClaudeCodeSetupInspectionPlanner } from "./claude-code-setup-inspection-planner.js";
import {
  createContainedTurnRuntimeAccess,
  type ContainedTurnCapabilityBundle,
  type ContainedTurnCompositionScope,
} from "./contained-turn-runtime-access.js";
import { raceWithAbort } from "./runtime-access-lifecycle.js";

export type CodexSetupCapabilityBundle = BuildCodexSetupViewDependencies;

export type ClaudeCodeSetupCapabilityBundle = BuildClaudeCodeSetupViewDependencies;

export interface AgentRuntimeHostDependencies {
  readonly claudeCodeSetup: ClaudeCodeSetupCapabilityBundle;
  readonly codexSetup: CodexSetupCapabilityBundle;
  readonly containedTurn?: ContainedTurnCapabilityBundle;
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
  while (activeCalls.size > 0) {
    await Promise.allSettled(activeCalls);
  }
};

const rejectAtDisposalDeadline = async (
  activeCalls: ReadonlySet<Promise<unknown>>,
): Promise<never> => {
  await delay(1_000, null, { ref: false });
  throw new AgentRuntimeHostDisposalIncompleteError(activeCalls.size);
};

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

const codexUnavailableOutcome: InspectCodexRuntimeSetupOutcome = Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: "capability_unavailable" as const,
  })]),
  status: "unsupported" as const,
});

type ProviderScopeSnapshot<Scope> =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly scope: Scope; readonly status: "available" };

const snapshotProviderScope = <Scope>(
  read: () => Scope | undefined,
  copy: (scope: Scope) => Scope | undefined,
): ProviderScopeSnapshot<Scope> => {
  try {
    const scope = read();
    if (scope === undefined) {
      return Object.freeze({ status: "absent" });
    }
    const copied = copy(scope);
    return copied === undefined
      ? Object.freeze({ status: "invalid" })
      : Object.freeze({ scope: copied, status: "available" });
  } catch {
    return Object.freeze({ status: "invalid" });
  }
};

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
  const hasContainedTurn = typeof value === "object" && value !== null &&
    Reflect.ownKeys(value).includes("containedTurn");
  assertClosedPlainBundle(
    value,
    "Agent Runtime capability dependencies",
    hasContainedTurn
      ? ["claudeCodeSetup", "codexSetup", "containedTurn"]
      : ["claudeCodeSetup", "codexSetup"],
  );
  const claudeCodeSetup = value.claudeCodeSetup;
  const codexSetup = value.codexSetup;
  const containedTurn = value.containedTurn;
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
  if (containedTurn !== undefined) {
    assertClosedPlainBundle(
      containedTurn,
      "Contained turn capability bundle",
      ["cancel", "observe", "submit"],
    );
  }
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
    ...(containedTurn === undefined ? {} : {
      containedTurn: Object.freeze({
        cancel: Object.freeze({
          execute: snapshotCapabilityMethod<ContainedTurnCapabilityBundle["cancel"]["execute"]>(containedTurn, "Contained turn capability bundle", "cancel", "execute"),
        }),
        observe: Object.freeze({
          execute: snapshotCapabilityMethod<ContainedTurnCapabilityBundle["observe"]["execute"]>(containedTurn, "Contained turn capability bundle", "observe", "execute"),
        }),
        submit: Object.freeze({
          execute: snapshotCapabilityMethod<ContainedTurnCapabilityBundle["submit"]["execute"]>(containedTurn, "Contained turn capability bundle", "submit", "execute"),
        }),
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
  const activeContainedTurns = new Map<string, Readonly<{
    operationId: string;
    scope: ContainedTurnCompositionScope;
  }>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const trackCall = <T>(operation: Promise<T>): Promise<T> => {
    activeCalls.add(operation);
    void operation.finally(() => activeCalls.delete(operation)).catch(() => {});
    return operation;
  };

  const requestContainedTurnCancellation = (
    operation: Readonly<{ operationId: string; scope: ContainedTurnCompositionScope }>,
  ): Promise<unknown> => capabilityDependencies.containedTurn === undefined
    ? Promise.resolve()
    : trackCall(capabilityDependencies.containedTurn.cancel.execute(operation));

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
    for (const operation of activeContainedTurns.values()) {
      void requestContainedTurnCancellation(operation);
    }
    disposal = Promise.race([
      settleActiveCalls(activeCalls),
      rejectAtDisposalDeadline(activeCalls),
    ]);
    return disposal;
  };

  return Object.freeze({
    bindAccess(scope: TrustedRuntimeAccessScope) {
      assertActive();
      const boundClaudeCodeScope = snapshotProviderScope(
        () => scope.claudeCodeSetup,
        copyTrustedClaudeCodeSetupScope,
      );
      const boundCodexScope = snapshotProviderScope(
        () => scope.codexSetup,
        copyTrustedCodexSetupScope,
      );
      const boundContainedTurnScope = snapshotProviderScope<ContainedTurnCompositionScope>(
        () => scope.containedTurn,
        copyTrustedContainedTurnScope,
      );
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
              boundClaudeCodeScope.status === "absent"
                ? Promise.resolve(claudeCodeUnavailableOutcome)
                : boundClaudeCodeScope.status === "invalid"
                  ? Promise.resolve(claudeCodeScopeLimitOutcome)
                  : buildClaudeCodeSetupView(boundClaudeCodeScope.scope, { signal });
            return raceWithAbort(trackCall(operation), signal);
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
              boundCodexScope.status === "absent"
                ? Promise.resolve(codexUnavailableOutcome)
                : boundCodexScope.status === "invalid"
                  ? Promise.resolve(codexScopeLimitOutcome)
                  : buildCodexSetupView(boundCodexScope.scope, input, { signal });
            return raceWithAbort(trackCall(operation), signal);
          },
        }),
        containedTurn: createContainedTurnRuntimeAccess({
          assertActive,
          capability: capabilityDependencies.containedTurn,
          hostSignal: hostAbort.signal,
          isDisposed: () => disposed,
          onAccepted: operation => {activeContainedTurns.set(operation.operationId, operation);},
          onSettled: operationId => {activeContainedTurns.delete(operationId);},
          requestCancellation: requestContainedTurnCancellation,
          scope: boundContainedTurnScope.status === "available"
            ? boundContainedTurnScope.scope
            : undefined,
          trackCall,
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
