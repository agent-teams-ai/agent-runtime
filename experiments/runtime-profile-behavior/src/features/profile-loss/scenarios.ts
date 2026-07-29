import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScenarioEvidence } from "../../model.ts";
import {
  writeFixture,
  writeJsonFixture,
} from "../config-precedence/fixture-files.ts";
import type { ProbeScenario } from "../scenario-execution/scenario.ts";

const codexProbe = fileURLToPath(
  new URL("../profile-drift/codex-config-drift-probe.ts", import.meta.url),
);
const opencodeProbe = fileURLToPath(
  new URL(
    "../acp-compatibility/opencode-acp-handshake-probe.ts",
    import.meta.url,
  ),
);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const parseOutput = (evidence: ScenarioEvidence): Record<string, unknown> => {
  try {
    return record(JSON.parse(evidence.result.stdout));
  } catch {
    return {};
  }
};

const commandsForSession = (
  v1: Record<string, unknown>,
  responseKey: string,
): readonly string[] => {
  const sessionId = record(record(v1[responseKey]).result).sessionId;
  const commands = record(v1.availableCommandsBySession);
  return typeof sessionId === "string" && Array.isArray(commands[sessionId])
    ? (commands[sessionId] as string[])
    : [];
};

export const profileLossScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "opencode-active-process-after-config-deletion",
    provider: "opencode",
    prepare: async (sandbox) => {
      await writeJsonFixture(
        join(sandbox.xdgConfig, "opencode", "opencode.jsonc"),
        {
          command: {
            "before-loss": {
              template: "Before loss",
              description: "Before loss",
            },
          },
        },
      );
    },
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [
        opencodeProbe,
        opencodeExecutable,
        sandbox.workspace,
        join(sandbox.xdgConfig, "opencode", "opencode.jsonc"),
        "delete",
      ],
      timeoutMs: 60_000,
    }),
    verify: async (sandbox) => {
      try {
        await access(join(sandbox.xdgConfig, "opencode", "opencode.jsonc"));
        return { sourceExists: true };
      } catch {
        return { sourceExists: false };
      }
    },
    assertions: (evidence) => {
      const v1 = record(parseOutput(evidence).v1);
      return [
        {
          id: "opencode.config-source-was-deleted",
          passed: evidence.verification?.sourceExists === false,
          expected: false,
          actual: evidence.verification?.sourceExists,
        },
        {
          id: "opencode.existing-process-retained-loaded-config",
          passed: commandsForSession(v1, "sessionNewAfterDrift").includes(
            "before-loss",
          ),
          expected: "before-loss",
          actual: commandsForSession(v1, "sessionNewAfterDrift"),
        },
      ];
    },
  },
  {
    id: "codex-active-process-after-config-corruption",
    provider: "codex",
    prepare: async (sandbox) => {
      await writeFixture(
        join(sandbox.codexHome, "config.toml"),
        [
          'model = "marker-before"',
          'developer_instructions = "runtime-profile-spike:before"',
          "",
          `[projects.${JSON.stringify(sandbox.workspace)}]`,
          'trust_level = "trusted"',
          "",
        ].join("\n"),
      );
    },
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [codexProbe, sandbox.workspace, "corrupt"],
      timeoutMs: 30_000,
    }),
    assertions: (evidence) => {
      const output = parseOutput(evidence);
      const before = record(output.before);
      return [
        {
          id: "codex.started-with-pinned-config",
          passed: before.model === "marker-before",
          expected: "marker-before",
          actual: before.model,
        },
        {
          id: "codex.corrupt-config-not-silently-accepted",
          passed:
            typeof output.afterError === "string" &&
            output.afterError.length > 0 &&
            output.after === null,
          expected: "typed provider config error",
          actual: {
            after: output.after,
            afterError: output.afterError,
          },
        },
      ];
    },
  },
];
