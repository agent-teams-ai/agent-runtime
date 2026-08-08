import { join } from "node:path";

import type { CommandResult } from "../../model.ts";
import type {
  ProbeScenario,
  ScenarioSandbox,
  ProbeInvocation,
} from "../scenario-execution/scenario.ts";
import {
  copyCredentialFixture,
  type CredentialFixtureGuard,
  writeCorruptCredentialFixture,
} from "./credential-fixture.ts";

const normalizeClaudeAuth = (result: CommandResult): CommandResult => {
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return {
      ...result,
      stdout: `${JSON.stringify(
        {
          loggedIn: parsed.loggedIn,
          authMethod: parsed.authMethod,
          apiProvider: parsed.apiProvider,
          subscriptionType: parsed.subscriptionType,
        },
        null,
        2,
      )}\n`,
    };
  } catch {
    return result;
  }
};

export const copiedCredentialScenario = (input: {
  readonly id: string;
  readonly provider: ProbeScenario["provider"];
  readonly source: string;
  readonly destination: (sandbox: ScenarioSandbox) => string;
  readonly invocation: (sandbox: ScenarioSandbox) => ProbeInvocation;
  readonly normalizeResult?: (result: CommandResult) => CommandResult;
  readonly assertions?: ProbeScenario["assertions"];
}): ProbeScenario => {
  let guard: CredentialFixtureGuard | undefined;
  return {
    id: input.id,
    provider: input.provider,
    async prepare(sandbox) {
      guard = await copyCredentialFixture(
        input.source,
        input.destination(sandbox),
      );
    },
    invocation: input.invocation,
    ...(input.normalizeResult === undefined
      ? {}
      : { normalizeResult: input.normalizeResult }),
    ...(input.assertions === undefined ? {} : { assertions: input.assertions }),
    async verify() {
      if (guard === undefined) {
        throw new Error("Credential fixture guard was not initialized");
      }
      return guard.verifySourceUnchanged();
    },
  };
};

const corruptCredentialScenario = (input: {
  readonly id: string;
  readonly provider: ProbeScenario["provider"];
  readonly destination: (sandbox: ScenarioSandbox) => string;
  readonly invocation: (sandbox: ScenarioSandbox) => {
    executable: string;
    args: readonly string[];
    cwd?: string;
  };
  readonly normalizeResult?: (result: CommandResult) => CommandResult;
}): ProbeScenario => ({
  id: input.id,
  provider: input.provider,
  prepare: (sandbox) =>
    writeCorruptCredentialFixture(input.destination(sandbox)),
  invocation: input.invocation,
  ...(input.normalizeResult === undefined
    ? {}
    : { normalizeResult: input.normalizeResult }),
});

const claudeRouteScenario = (
  id: string,
  environment: Readonly<Record<string, string>>,
): ProbeScenario => ({
  id,
  provider: "claude",
  invocation: () => ({
    executable: "claude",
    args: ["auth", "status", "--json"],
    environment,
  }),
  normalizeResult: normalizeClaudeAuth,
});

export const credentialScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => {
  const credentialRoot = join(process.cwd(), ".spike", "credential-sources");

  return [
    copiedCredentialScenario({
      id: "claude-copied-credential-status",
      provider: "claude",
      source: "/root/.claude/.credentials.json",
      destination: (sandbox) =>
        join(sandbox.claudeConfig, ".credentials.json"),
      invocation: () => ({
        executable: "claude",
        args: ["auth", "status", "--json"],
      }),
      normalizeResult: normalizeClaudeAuth,
    }),
    corruptCredentialScenario({
      id: "claude-corrupt-credential",
      provider: "claude",
      destination: (sandbox) =>
        join(sandbox.claudeConfig, ".credentials.json"),
      invocation: () => ({
        executable: "claude",
        args: ["auth", "status", "--json"],
      }),
      normalizeResult: normalizeClaudeAuth,
    }),
    copiedCredentialScenario({
      id: "codex-copied-credential-status",
      provider: "codex",
      source: join(credentialRoot, "codex-auth.json"),
      destination: (sandbox) => join(sandbox.codexHome, "auth.json"),
      invocation: (sandbox) => ({
        executable: "codex",
        args: ["-C", sandbox.workspace, "login", "status"],
      }),
    }),
    corruptCredentialScenario({
      id: "codex-corrupt-credential",
      provider: "codex",
      destination: (sandbox) => join(sandbox.codexHome, "auth.json"),
      invocation: (sandbox) => ({
        executable: "codex",
        args: ["-C", sandbox.workspace, "login", "status"],
      }),
    }),
    copiedCredentialScenario({
      id: "opencode-copied-credential-status",
      provider: "opencode",
      source: join(credentialRoot, "opencode-auth.json"),
      destination: (sandbox) =>
        join(sandbox.xdgData, "opencode", "auth.json"),
      invocation: (sandbox) => ({
        executable: opencodeExecutable,
        args: ["providers", "list", "--pure"],
        cwd: sandbox.workspace,
      }),
    }),
    corruptCredentialScenario({
      id: "opencode-corrupt-credential",
      provider: "opencode",
      destination: (sandbox) =>
        join(sandbox.xdgData, "opencode", "auth.json"),
      invocation: (sandbox) => ({
        executable: opencodeExecutable,
        args: ["providers", "list", "--pure"],
        cwd: sandbox.workspace,
      }),
    }),
    claudeRouteScenario("claude-bedrock-route", {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "runtime-spike-missing",
    }),
    claudeRouteScenario("claude-vertex-route", {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "runtime-spike-region",
    }),
    claudeRouteScenario("claude-foundry-route", {
      CLAUDE_CODE_USE_FOUNDRY: "1",
    }),
  ];
};
