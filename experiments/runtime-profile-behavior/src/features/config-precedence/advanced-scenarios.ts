import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ProbeScenario,
  ScenarioSandbox,
} from "../scenario-execution/scenario.ts";
import {
  mcpMarker,
  writeFixture,
  writeJsonFixture,
  writeSkillFixture,
} from "./fixture-files.ts";
import { codexNativeInspectionAssertions } from "./codex-native-inspection-assertions.ts";

const prepareCodexProjectMcp = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeFixture(
    join(sandbox.codexHome, "config.toml"),
    [
      `[projects.${JSON.stringify(sandbox.workspace)}]`,
      `trust_level = "trusted"`,
      "",
      "[mcp_servers.shared]",
      `command = "/bin/echo"`,
      `args = ["global"]`,
      "",
      "[mcp_servers.global-only]",
      `command = "/bin/echo"`,
      `args = ["global-only"]`,
      "",
    ].join("\n"),
  );
  await writeFixture(
    join(sandbox.workspace, ".codex", "config.toml"),
    [
      "[mcp_servers.shared]",
      `args = ["project"]`,
      "",
      "[mcp_servers.project-only]",
      `command = "/bin/echo"`,
      `args = ["project-only"]`,
      "",
    ].join("\n"),
  );
};

const prepareCodexProfileFilename = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeFixture(
    join(sandbox.codexHome, "config.toml"),
    `developer_instructions = "runtime-profile-spike:global"\n`,
  );
  await writeFixture(
    join(sandbox.codexHome, "team.config.toml"),
    `developer_instructions = "runtime-profile-spike:team-config"\n`,
  );
  await writeFixture(
    join(sandbox.codexHome, "profile-team.config.toml"),
    `developer_instructions = "runtime-profile-spike:profile-team-config"\n`,
  );
};

const prepareCodexDisabledMcp = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeFixture(
    join(sandbox.codexHome, "config.toml"),
    [
      `[projects.${JSON.stringify(sandbox.workspace)}]`,
      `trust_level = "trusted"`,
      "",
      "[mcp_servers.shared]",
      `command = "/bin/echo"`,
      `args = ["global"]`,
      `enabled = true`,
      "",
    ].join("\n"),
  );
  await writeFixture(
    join(sandbox.workspace, ".codex", "config.toml"),
    [
      "[mcp_servers.shared]",
      `enabled = false`,
      "",
    ].join("\n"),
  );
};

const prepareClaudeDisabledProjectMcp = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeJsonFixture(join(sandbox.claudeConfig, ".claude.json"), {
    mcpServers: {
      "user-only": mcpMarker("user-only"),
    },
    projects: {
      [sandbox.workspace]: {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: ["project-disabled"],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false,
      },
    },
  });
  await writeJsonFixture(join(sandbox.workspace, ".mcp.json"), {
    mcpServers: {
      "project-disabled": mcpMarker("project-disabled"),
    },
  });
};

const opencodeMcp = (marker: string): object => ({
  type: "local",
  command: ["/bin/echo", marker],
  enabled: true,
});

const prepareOpenCodeDisabledMcp = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeJsonFixture(
    join(sandbox.xdgConfig, "opencode", "opencode.json"),
    {
      mcp: {
        shared: opencodeMcp("global"),
      },
    },
  );
  await writeJsonFixture(join(sandbox.workspace, "opencode.json"), {
    mcp: {
      shared: {
        enabled: false,
      },
    },
  });
};

const codexAppServerProbe = fileURLToPath(
  new URL("./codex-app-server-probe.ts", import.meta.url),
);

const prepareCodexNativeInspection = async (
  sandbox: ScenarioSandbox,
  trusted: boolean,
): Promise<void> => {
  const userConfig = [
    `model = "marker-global"`,
    `developer_instructions = "runtime-profile-spike:global"`,
    "",
    "[mcp_servers.shared]",
    `command = "/bin/echo"`,
    `args = ["global"]`,
    "",
  ];
  if (trusted) {
    userConfig.push(
      `[projects.${JSON.stringify(sandbox.workspace)}]`,
      `trust_level = "trusted"`,
      "",
    );
  }
  await writeFixture(
    join(sandbox.codexHome, "config.toml"),
    userConfig.join("\n"),
  );
  await writeFixture(
    join(sandbox.workspace, ".codex", "config.toml"),
    [
      `model = "marker-project"`,
      `developer_instructions = "runtime-profile-spike:project"`,
      "",
      "[mcp_servers.shared]",
      `args = ["project"]`,
      "",
    ].join("\n"),
  );
  await writeSkillFixture(
    join(sandbox.codexHome, "skills", "shared", "SKILL.md"),
    "shared",
    "codex-global",
  );
  await writeSkillFixture(
    join(sandbox.workspace, ".agents", "skills", "shared", "SKILL.md"),
    "shared",
    "agents-project",
  );
  await writeSkillFixture(
    join(
      sandbox.workspace,
      ".agents",
      "skills",
      "project-only",
      "SKILL.md",
    ),
    "project-only",
    "agents-project-only",
  );
};

export const advancedConfigurationScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "codex-project-config-process-cwd",
    provider: "codex",
    prepare: prepareCodexProjectMcp,
    invocation: (sandbox) => ({
      executable: "codex",
      args: ["-C", sandbox.workspace, "mcp", "list", "--json"],
      cwd: sandbox.home,
    }),
  },
  {
    id: "codex-runtime-profile-filename",
    provider: "codex",
    prepare: prepareCodexProfileFilename,
    invocation: (sandbox) => ({
      executable: "codex",
      args: [
        "-C",
        sandbox.workspace,
        "-p",
        "team",
        "debug",
        "prompt-input",
      ],
    }),
  },
  {
    id: "codex-mcp-disable-inherited",
    provider: "codex",
    prepare: prepareCodexDisabledMcp,
    invocation: (sandbox) => ({
      executable: "codex",
      args: ["-C", sandbox.workspace, "mcp", "list", "--json"],
    }),
  },
  {
    id: "claude-project-mcp-disabled",
    provider: "claude",
    prepare: prepareClaudeDisabledProjectMcp,
    invocation: () => ({
      executable: "claude",
      args: [
        "--setting-sources",
        "user,project,local",
        "mcp",
        "list",
      ],
      timeoutMs: 45_000,
    }),
  },
  {
    id: "opencode-mcp-disable-inherited",
    provider: "opencode",
    prepare: prepareOpenCodeDisabledMcp,
    invocation: (sandbox) => ({
      executable: opencodeExecutable,
      args: ["debug", "config", "--pure"],
      cwd: sandbox.workspace,
    }),
  },
  {
    id: "codex-native-inspection-trusted",
    provider: "codex",
    prepare: (sandbox) => prepareCodexNativeInspection(sandbox, true),
    assertions: codexNativeInspectionAssertions({
      trusted: true,
      effectiveModel: "marker-project",
      effectiveMcpArg: "project",
    }),
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [codexAppServerProbe, sandbox.workspace],
      cwd: sandbox.workspace,
      timeoutMs: 30_000,
    }),
  },
  {
    id: "codex-native-inspection-untrusted",
    provider: "codex",
    prepare: (sandbox) => prepareCodexNativeInspection(sandbox, false),
    assertions: codexNativeInspectionAssertions({
      trusted: false,
      effectiveModel: "marker-global",
      effectiveMcpArg: "global",
    }),
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [codexAppServerProbe, sandbox.workspace],
      cwd: sandbox.workspace,
      timeoutMs: 30_000,
    }),
  },
];
