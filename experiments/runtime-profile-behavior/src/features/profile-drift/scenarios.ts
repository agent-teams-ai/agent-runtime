import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScenarioEvidence } from "../../model.ts";
import {
  writeFixture,
  writeJsonFixture,
} from "../config-precedence/fixture-files.ts";
import type { ProbeScenario } from "../scenario-execution/scenario.ts";

const codexConfigDriftProbe = fileURLToPath(
  new URL("./codex-config-drift-probe.ts", import.meta.url),
);
const opencodeAcpProbe = fileURLToPath(
  new URL(
    "../acp-compatibility/opencode-acp-handshake-probe.ts",
    import.meta.url,
  ),
);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const assertions = (evidence: ScenarioEvidence) => {
  let output: Record<string, unknown> = {};
  try {
    output = record(JSON.parse(evidence.result.stdout));
  } catch {
    output = {};
  }
  const before = record(output.before);
  const after = record(output.after);
  return [
    {
      id: "codex.config-drift-probe-succeeded",
      passed: evidence.result.exitCode === 0,
      expected: 0,
      actual: evidence.result.exitCode,
    },
    {
      id: "codex.config-drift-started-with-initial-revision",
      passed: before.model === "marker-before",
      expected: "marker-before",
      actual: before.model,
    },
    {
      id: "codex.config-drift-produced-valid-observation",
      passed:
        after.model === "marker-before" ||
        after.model === "marker-after",
      expected: "marker-before or marker-after",
      actual: after.model,
    },
  ];
};

const opencodeAssertions = (evidence: ScenarioEvidence) => {
  let output: Record<string, unknown> = {};
  try {
    output = record(JSON.parse(evidence.result.stdout));
  } catch {
    output = {};
  }
  const v1 = record(output.v1);
  const firstSessionId = record(record(v1.sessionNew).result).sessionId;
  const secondSessionId = record(
    record(v1.sessionNewAfterDrift).result,
  ).sessionId;
  const commands = record(v1.availableCommandsBySession);
  const firstCommands =
    typeof firstSessionId === "string" &&
    Array.isArray(commands[firstSessionId])
      ? commands[firstSessionId]
      : [];
  const secondCommands =
    typeof secondSessionId === "string" &&
    Array.isArray(commands[secondSessionId])
      ? commands[secondSessionId]
      : [];
  return [
    {
      id: "opencode.acp-config-drift-probe-succeeded",
      passed: evidence.result.exitCode === 0,
      expected: 0,
      actual: evidence.result.exitCode,
    },
    {
      id: "opencode.acp-first-session-used-initial-config",
      passed: firstCommands.includes("before-drift"),
      expected: "before-drift",
      actual: firstCommands,
    },
    {
      id: "opencode.acp-second-session-produced-valid-drift-observation",
      passed:
        secondCommands.includes("before-drift") ||
        secondCommands.includes("after-drift"),
      expected: "before-drift or after-drift",
      actual: secondCommands,
    },
  ];
};

export const profileDriftScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "codex-app-server-config-drift",
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
      args: [codexConfigDriftProbe, sandbox.workspace],
      cwd: sandbox.workspace,
      timeoutMs: 30_000,
    }),
    assertions,
  },
  {
    id: "opencode-acp-config-drift",
    provider: "opencode",
    prepare: async (sandbox) => {
      await writeJsonFixture(
        join(sandbox.xdgConfig, "opencode", "opencode.jsonc"),
        {
          username: "before-drift",
          command: {
            "before-drift": {
              template: "Before drift",
              description: "Before drift",
            },
          },
        },
      );
    },
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [
        opencodeAcpProbe,
        opencodeExecutable,
        sandbox.workspace,
        join(sandbox.xdgConfig, "opencode", "opencode.jsonc"),
      ],
      cwd: sandbox.workspace,
      timeoutMs: 60_000,
    }),
    assertions: opencodeAssertions,
  },
];
