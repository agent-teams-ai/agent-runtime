import type { ObservationAssertion, ProviderId } from "../../model.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

export const managedPolicyAssertions = (
  provider: ProviderId,
  observation: Readonly<Record<string, unknown>>,
): readonly ObservationAssertion[] => {
  if (provider === "claude") {
    const staticPolicy = record(observation.staticManagedPolicy);
    const helper = record(observation.policyHelper);
    return [
      {
        id: "claude.system-managed-hook-lockdown",
        passed:
          staticPolicy.userHookExecuted === false &&
          staticPolicy.managedHookExecuted === true,
        expected: { userHookExecuted: false, managedHookExecuted: true },
        actual: staticPolicy,
      },
      {
        id: "claude.policy-helper-refresh-ran",
        passed:
          Number(helper.startupHelperCalls) >= 1 &&
          Number(helper.refreshHelperCalls) >= 2,
        expected: "startup and background refresh calls",
        actual: helper,
      },
      {
        id: "claude.refresh-failure-kept-process-alive",
        passed: helper.survivedRefreshFailure === true,
        expected: true,
        actual: helper.survivedRefreshFailure,
      },
      {
        id: "claude.refresh-failure-retained-last-policy",
        passed: helper.userPromptHookSuppressedAfterRefreshFailure === true,
        expected: true,
        actual: helper.userPromptHookSuppressedAfterRefreshFailure,
      },
      {
        id: "claude.policy-helper-startup-fails-closed",
        passed: Number(helper.failedStartupExitCode) !== 0,
        expected: "non-zero exit",
        actual: helper.failedStartupExitCode,
      },
    ];
  }
  if (provider === "codex") {
    const before = record(observation.before);
    const after = record(observation.sameProcessAfterDrift);
    return [
      {
        id: "codex.system-requirements-loaded",
        passed:
          before.allowManagedHooksOnly === true &&
          array(before.allowedSandboxModes).includes("read-only"),
        expected: "managed hook lockdown and read-only sandbox",
        actual: before,
      },
      {
        id: "codex.requirements-reread-in-process",
        passed:
          after.allowManagedHooksOnly === false &&
          array(after.allowedSandboxModes).includes("workspace-write"),
        expected: "updated requirements in same app-server",
        actual: after,
      },
      {
        id: "codex.corrupt-requirements-rejected",
        passed: observation.corruptRequirementsRejected === true,
        expected: true,
        actual: observation.corruptRequirementsRejected,
      },
    ];
  }

  const precedence = record(observation.staticManagedPrecedence);
  const drift = record(observation.sameProcessDrift);
  const next = record(observation.newProcessAfterDrift);
  return [
    {
      id: "opencode.system-managed-config-wins",
      passed:
        precedence.username === "managed-before" &&
        precedence.bashPermission === "deny",
      expected: { username: "managed-before", bashPermission: "deny" },
      actual: precedence,
    },
    {
      id: "opencode.managed-config-is-process-scoped",
      passed:
        array(drift.firstCommands).includes("before-drift") &&
        array(drift.secondCommands).includes("before-drift") &&
        !array(drift.secondCommands).includes("after-drift"),
      expected: "same ACP host remains on before-drift",
      actual: drift,
    },
    {
      id: "opencode.new-process-loads-managed-drift",
      passed:
        next.username === "after-drift" &&
        array(next.commands).includes("after-drift"),
      expected: "new process loads after-drift",
      actual: next,
    },
    {
      id: "opencode.corrupt-managed-config-rejected",
      passed: observation.corruptManagedConfigRejected === true,
      expected: true,
      actual: observation.corruptManagedConfigRejected,
    },
  ];
};
