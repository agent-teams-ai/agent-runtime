import {
  access,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScenarioEvidence } from "../../model.ts";
import {
  writeFixture,
  writeJsonFixture,
  writeSkillFixture,
} from "../config-precedence/fixture-files.ts";
import type {
  ProbeScenario,
  ScenarioSandbox,
} from "../scenario-execution/scenario.ts";
import { opencodeMcpCancellationScenario } from "./opencode-mcp-cancellation-scenario.ts";

const relocationProbe = fileURLToPath(
  new URL("./opencode-relocation-probe.ts", import.meta.url),
);

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const markerVerification = async (
  path: string,
): Promise<Readonly<Record<string, unknown>>> => ({
  markerExists: await exists(path),
  markerContent: (await exists(path)) ? await readFile(path, "utf8") : null,
});

const verification = (evidence: ScenarioEvidence): Record<string, unknown> =>
  (evidence.verification ?? {}) as Record<string, unknown>;

const markerAssertions = (
  id: string,
  expected: boolean,
  evidence: ScenarioEvidence,
) => [
  {
    id: `${id}.command-completed`,
    passed: evidence.result.exitCode === 0,
    expected: 0,
    actual: evidence.result.exitCode,
  },
  {
    id: `${id}.marker-state`,
    passed: verification(evidence).markerExists === expected,
    expected,
    actual: verification(evidence).markerExists,
  },
];

const prepareOpenCodePlugin = async (
  sandbox: ScenarioSandbox,
): Promise<string> => {
  const markerPath = join(sandbox.root, "outside-workspace", "plugin.marker");
  await mkdir(join(sandbox.root, "outside-workspace"), { recursive: true });
  await mkdir(join(sandbox.xdgConfig, "opencode"), { recursive: true });
  await symlink(
    join(process.cwd(), "node_modules"),
    join(sandbox.xdgConfig, "opencode", "node_modules"),
    "dir",
  );
  await writeFixture(
    join(sandbox.workspace, ".opencode", "plugins", "capability-probe.js"),
    [
      'import { writeFile } from "node:fs/promises";',
      "export const CapabilityProbe = async () => {",
      "  await writeFile(process.env.RUNTIME_PROFILE_EXTENSION_MARKER, 'plugin-executed\\n');",
      "  return {};",
      "};",
      "",
    ].join("\n"),
  );
  return markerPath;
};

const pluginScenario = (
  opencodeExecutable: string,
  pure: boolean,
): ProbeScenario => {
  let markerPath = "";
  const id = pure ? "opencode-pure-disables-project-plugin" : "opencode-project-plugin-executes";
  return {
    id,
    provider: "opencode",
    prepare: async (sandbox) => {
      markerPath = await prepareOpenCodePlugin(sandbox);
    },
    invocation: () => ({
      executable: opencodeExecutable,
      args: ["debug", "config", ...(pure ? ["--pure"] : [])],
      environment: { RUNTIME_PROFILE_EXTENSION_MARKER: markerPath },
      timeoutMs: 30_000,
      trace: false,
    }),
    verify: () => markerVerification(markerPath),
    assertions: (evidence) => markerAssertions(id, !pure, evidence),
  };
};

const claudeHookScenario = (): ProbeScenario => {
  let markerPath = "";
  return {
    id: "claude-session-start-hook-executes",
    provider: "claude",
    prepare: async (sandbox) => {
      markerPath = join(sandbox.root, "outside-workspace", "hook.marker");
      await mkdir(join(sandbox.root, "outside-workspace"), { recursive: true });
      await writeJsonFixture(join(sandbox.claudeConfig, "settings.json"), {
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [
                {
                  type: "command",
                  command:
                    'printf "hook-executed\\n" > "$RUNTIME_PROFILE_EXTENSION_MARKER"',
                },
              ],
            },
          ],
        },
      });
    },
    invocation: () => ({
      executable: "claude",
      args: ["--init-only"],
      environment: { RUNTIME_PROFILE_EXTENSION_MARKER: markerPath },
      timeoutMs: 30_000,
    }),
    verify: () => markerVerification(markerPath),
    assertions: (evidence) =>
      markerAssertions("claude-session-start-hook-executes", true, evidence),
  };
};

const opencodeMcpFailureScenario = (
  opencodeExecutable: string,
): ProbeScenario => {
  let markerPath = "";
  return {
    id: "opencode-broken-and-delayed-mcp",
    provider: "opencode",
    prepare: async (sandbox) => {
      markerPath = join(sandbox.root, "outside-workspace", "mcp.marker");
      await mkdir(join(sandbox.root, "outside-workspace"), { recursive: true });
      const serverPath = join(sandbox.root, "delayed-mcp.mjs");
      await writeFile(
        serverPath,
        [
          'import { writeFile } from "node:fs/promises";',
          "await writeFile(process.argv[2], 'mcp-started\\n');",
          "setTimeout(() => process.exit(0), 3000);",
          "",
        ].join("\n"),
      );
      await writeJsonFixture(
        join(sandbox.xdgConfig, "opencode", "opencode.json"),
        {
          mcp: {
            broken: {
              type: "local",
              command: ["/definitely/missing-runtime-profile-command"],
              enabled: true,
              timeout: 500,
            },
            delayed: {
              type: "local",
              command: [process.execPath, serverPath, markerPath],
              enabled: true,
              timeout: 500,
            },
          },
        },
      );
    },
    invocation: () => ({
      executable: opencodeExecutable,
      args: ["mcp", "list"],
      timeoutMs: 15_000,
    }),
    verify: () => markerVerification(markerPath),
    assertions: (evidence) => [
      {
        id: "opencode.mcp-list-bounded",
        passed: !evidence.result.timedOut && evidence.result.durationMs < 10_000,
        expected: "less than 10000ms without harness timeout",
        actual: evidence.result.durationMs,
      },
      {
        id: "opencode.delayed-mcp-started",
        passed: verification(evidence).markerExists === true,
        expected: true,
        actual: verification(evidence).markerExists,
      },
      {
        id: "opencode.mcp-failures-reported",
        passed:
          evidence.result.stdout.includes("broken") &&
          evidence.result.stdout.includes("delayed"),
        expected: "both MCP identities in output",
        actual: evidence.result.stdout,
      },
    ],
  };
};

const relocationAssertions = (evidence: ScenarioEvidence) => {
  let output: Record<string, unknown> = {};
  try {
    output = JSON.parse(evidence.result.stdout) as Record<string, unknown>;
  } catch {
    output = {};
  }
  const markers = (key: "before" | "after"): string[] =>
    Array.isArray(output[key])
      ? (output[key] as Record<string, unknown>[])
          .map((item) => item.marker)
          .filter((item): item is string => typeof item === "string")
      : [];
  return [
    {
      id: "opencode.relative-skill-before-relocation",
      passed: markers("before").includes("relocatable-marker"),
      expected: "relocatable-marker",
      actual: markers("before"),
    },
    {
      id: "opencode.relative-skill-after-relocation",
      passed: markers("after").includes("relocatable-marker"),
      expected: "relocatable-marker",
      actual: markers("after"),
    },
  ];
};

const relocationScenario = (opencodeExecutable: string): ProbeScenario => ({
  id: "opencode-relative-skill-workspace-relocation",
  provider: "opencode",
  prepare: async (sandbox) => {
    await writeSkillFixture(
      join(
        sandbox.workspace,
        ".opencode",
        "skills",
        "relocatable",
        "SKILL.md",
      ),
      "relocatable",
      "relocatable-marker",
    );
  },
  invocation: (sandbox) => ({
    executable: process.execPath,
    args: [relocationProbe, opencodeExecutable, sandbox.root],
    timeoutMs: 60_000,
  }),
  assertions: relocationAssertions,
});

export const extensionSafetyScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  pluginScenario(opencodeExecutable, false),
  pluginScenario(opencodeExecutable, true),
  claudeHookScenario(),
  opencodeMcpFailureScenario(opencodeExecutable),
  opencodeMcpCancellationScenario(opencodeExecutable),
  relocationScenario(opencodeExecutable),
];
