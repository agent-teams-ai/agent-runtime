import { join } from "node:path";

import { writeJsonFixture } from "../config-precedence/fixture-files.ts";
import { copiedCredentialScenario } from "../credential-routes/scenarios.ts";
import type { ProbeScenario } from "../scenario-execution/scenario.ts";
import {
  normalizeClaudeE2e,
  normalizeCodexE2e,
  normalizeOpenCodeE2e,
} from "./normalize-e2e.ts";

const PROMPT =
  "Reply with exactly runtime-profile-spike-ok. Do not use tools.";

export const providerE2eScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => {
  const credentialRoot = join(process.cwd(), ".spike", "credential-sources");
  const opencodeBase = copiedCredentialScenario({
    id: "opencode-authenticated-e2e",
    provider: "opencode",
    source: join(credentialRoot, "opencode-auth.json"),
    destination: (sandbox) =>
      join(sandbox.xdgData, "opencode", "auth.json"),
    invocation: (sandbox) => ({
      executable: opencodeExecutable,
      args: [
        "run",
        "--pure",
        "--format",
        "json",
        "--model",
        "openai/gpt-5.4-mini",
        "--dir",
        sandbox.workspace,
        PROMPT,
      ],
      cwd: sandbox.workspace,
      timeoutMs: 120_000,
    }),
    normalizeResult: normalizeOpenCodeE2e,
  });

  return [
    copiedCredentialScenario({
      id: "claude-authenticated-default-e2e",
      provider: "claude",
      source: "/root/.claude/.credentials.json",
      destination: (sandbox) =>
        join(sandbox.claudeConfig, ".credentials.json"),
      invocation: () => ({
        executable: "claude",
        args: [
          "-p",
          PROMPT,
          "--tools",
          "",
          "--permission-mode",
          "dontAsk",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--max-budget-usd",
          "0.10",
        ],
        timeoutMs: 120_000,
      }),
      normalizeResult: normalizeClaudeE2e,
    }),
    copiedCredentialScenario({
      id: "claude-authenticated-safe-mode-e2e",
      provider: "claude",
      source: "/root/.claude/.credentials.json",
      destination: (sandbox) =>
        join(sandbox.claudeConfig, ".credentials.json"),
      invocation: () => ({
        executable: "claude",
        args: [
          "-p",
          PROMPT,
          "--safe-mode",
          "--tools",
          "",
          "--permission-mode",
          "dontAsk",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--max-budget-usd",
          "0.10",
        ],
        timeoutMs: 120_000,
      }),
      normalizeResult: normalizeClaudeE2e,
    }),
    copiedCredentialScenario({
      id: "codex-authenticated-e2e",
      provider: "codex",
      source: join(credentialRoot, "codex-auth.json"),
      destination: (sandbox) => join(sandbox.codexHome, "auth.json"),
      invocation: (sandbox) => ({
        executable: "codex",
        args: [
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--json",
          "--sandbox",
          "read-only",
          "-m",
          "gpt-5.4-mini",
          "-C",
          sandbox.workspace,
          "-c",
          'approval_policy="never"',
          "-c",
          'web_search="disabled"',
          PROMPT,
        ],
        timeoutMs: 120_000,
      }),
      normalizeResult: normalizeCodexE2e,
    }),
    {
      ...opencodeBase,
      async prepare(sandbox) {
        await opencodeBase.prepare?.(sandbox);
        await writeJsonFixture(
          join(sandbox.xdgConfig, "opencode", "opencode.json"),
          {
            permission: "deny",
          },
        );
      },
    },
  ];
};
