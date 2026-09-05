import { copyContainedTurnAccessAuthority } from "./contained-turn-access-authority.js";
import type { AuthorityBoundContainedTurnCapability } from "./contained-turn-authority-capability.js";
import { randomBytes } from "node:crypto";

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
  type ContainedTurnCompositionScope,
  type TrustedRuntimeAccessScope,
} from "./trusted-runtime-access-scope.js";
import { createCodexSetupInspectionPlanner } from "./codex-setup-inspection-planner.js";
import { createClaudeCodeSetupInspectionPlanner } from "./claude-code-setup-inspection-planner.js";
import {
  createContainedTurnSubmissionCoordinator,
  createContainedTurnRuntimeAccess,
} from "./contained-turn-runtime-access.js";
import { createAgentRuntimeHostDisposalLifecycle } from "./agent-runtime-host-disposal.js";
import { raceWithAbort } from "./runtime-access-lifecycle.js";

const { types } = process.getBuiltinModule("node:util");

export {
  AgentRuntimeHostDisposalIncompleteError,
  AgentRuntimeHostLifecycleError,
  ContainedTurnOwnerContractError,
} from "./agent-runtime-host-disposal.js";
export type {
  AgentRuntimeHostContainedTurnDisposalIssue,
  AgentRuntimeHostContainedTurnDisposalStatus,
  AgentRuntimeHostDisposalStatus,
  AgentRuntimeHostLifecycleErrorCode,
  ContainedTurnOwnerContractErrorCode,
} from "./agent-runtime-host-disposal.js";

export type CodexSetupCapabilityBundle = BuildCodexSetupViewDependencies;

export type ClaudeCodeSetupCapabilityBundle = BuildClaudeCodeSetupViewDependencies;

export interface AgentRuntimeHostDependencies {
  readonly claudeCodeSetup: ClaudeCodeSetupCapabilityBundle;
  readonly codexSetup: CodexSetupCapabilityBundle;
  readonly containedTurn?: AuthorityBoundContainedTurnCapability;
}

export interface AgentRuntimeHost extends AsyncDisposable {
  bindAccess(scope: TrustedRuntimeAccessScope): RuntimeAccessHandle;
  dispose(): Promise<void>;
}

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
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) {
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

const copyAuthorityRevision = (capability: Record<string, unknown>): string => {
  const descriptor = Object.getOwnPropertyDescriptor(capability, "authorityRevision");
  const authorityRevision = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  const copied = copyContainedTurnAccessAuthority({ authorityRevision, projectId: "probe", tenantId: "probe" });
  if (copied === undefined) { throw new TypeError("Contained-turn access authority is invalid"); }
  return copied.authorityRevision;
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
      ["authorityRevision", "cancel", "observe", "submit"],
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
        authorityRevision: copyAuthorityRevision(containedTurn),
        cancel: Object.freeze({
          execute: snapshotCapabilityMethod<AuthorityBoundContainedTurnCapability["cancel"]["execute"]>(containedTurn, "Contained turn capability bundle", "cancel", "execute"),
        }),
        observe: Object.freeze({
          execute: snapshotCapabilityMethod<AuthorityBoundContainedTurnCapability["observe"]["execute"]>(containedTurn, "Contained turn capability bundle", "observe", "execute"),
        }),
        submit: Object.freeze({
          execute: snapshotCapabilityMethod<AuthorityBoundContainedTurnCapability["submit"]["execute"]>(containedTurn, "Contained turn capability bundle", "submit", "execute"),
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
  const lifecycle = createAgentRuntimeHostDisposalLifecycle(capabilityDependencies.containedTurn);
  const containedTurnSubmissionCoordinator = capabilityDependencies.containedTurn === undefined
    ? undefined
    : createContainedTurnSubmissionCoordinator({
        capability: capabilityDependencies.containedTurn,
        hostSignal: lifecycle.signal,
        isDisposed: lifecycle.isDisposed,
        onAccepted: lifecycle.registerContainedTurn,
        onObserved: lifecycle.recordContainedTurnStatus,
        requestCancellation: lifecycle.requestContainedTurnCancellation,
        executeCall: lifecycle.executeCall,
      });

  return Object.freeze({
    bindAccess(scope: TrustedRuntimeAccessScope) {
      lifecycle.assertActive();
      const boundClaudeCodeScope = snapshotProviderScope(
        () => scope.claudeCodeSetup,
        copyTrustedClaudeCodeSetupScope,
      );
      const boundCodexScope = snapshotProviderScope(
        () => scope.codexSetup,
        copyTrustedCodexSetupScope,
      );
      const boundContainedTurnScope = snapshotProviderScope<ContainedTurnCompositionScope>(
        () => {
          if (types.isProxy(scope)) { throw new TypeError("Contained-turn access scope is invalid"); }
          const descriptor = Object.getOwnPropertyDescriptor(scope, "containedTurn");
          if (descriptor === undefined) { return; }
          if (!("value" in descriptor)) { throw new TypeError("Contained-turn access scope is invalid"); }
          return descriptor.value as ContainedTurnCompositionScope | undefined;
        },
        copyTrustedContainedTurnScope,
      );
      return Object.freeze({
        claudeCodeSetup: Object.freeze({
          inspect: async (options?: { readonly signal?: AbortSignal }) => {
            lifecycle.assertActive();
            const callerSignal = options?.signal;
            const signal = callerSignal === undefined
              ? lifecycle.signal
              : AbortSignal.any([lifecycle.signal, callerSignal]);
            signal.throwIfAborted();
            const operation = () => boundClaudeCodeScope.status === "absent"
                ? Promise.resolve(claudeCodeUnavailableOutcome)
                : boundClaudeCodeScope.status === "invalid"
                  ? Promise.resolve(claudeCodeScopeLimitOutcome)
                  : buildClaudeCodeSetupView(boundClaudeCodeScope.scope, { signal });
            return raceWithAbort(lifecycle.executeCall(operation), signal);
          },
        }),
        codexSetup: Object.freeze({
          inspect: async (
            input: InspectCodexRuntimeSetup,
            options?: { readonly signal?: AbortSignal },
          ) => {
            lifecycle.assertActive();
            const signal =
              options?.signal === undefined
                ? lifecycle.signal
                : AbortSignal.any([lifecycle.signal, options.signal]);
            signal.throwIfAborted();
            const operation = () => boundCodexScope.status === "absent"
                ? Promise.resolve(codexUnavailableOutcome)
                : boundCodexScope.status === "invalid"
                  ? Promise.resolve(codexScopeLimitOutcome)
                  : buildCodexSetupView(boundCodexScope.scope, input, { signal });
            return raceWithAbort(lifecycle.executeCall(operation), signal);
          },
        }),
        containedTurn: createContainedTurnRuntimeAccess({
          assertActive: lifecycle.assertActive,
          capability: capabilityDependencies.containedTurn,
          hostSignal: lifecycle.signal,
          isDisposed: lifecycle.isDisposed,
          onAccepted: lifecycle.registerContainedTurn,
          onObserved: lifecycle.recordContainedTurnStatus,
          requestCancellation: lifecycle.requestContainedTurnCancellation,
          scope: boundContainedTurnScope.status === "available"
            ? copyContainedTurnAccessAuthority({
                ...boundContainedTurnScope.scope,
                authorityRevision: capabilityDependencies.containedTurn?.authorityRevision,
              })
            : undefined,
          submissionCoordinator: containedTurnSubmissionCoordinator,
          executeCall: lifecycle.executeCall,
        }),
      });
    },
    dispose: lifecycle.dispose,
    [Symbol.asyncDispose]: lifecycle.dispose,
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
