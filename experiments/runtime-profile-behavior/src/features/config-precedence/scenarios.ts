import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ProbeScenario,
  ScenarioSandbox,
} from "../scenario-execution/scenario.ts";
import { advancedConfigurationScenarios } from "./advanced-scenarios.ts";
import {
  mcpMarker,
  writeFixture,
  writeJsonFixture,
  writeSkillFixture,
} from "./fixture-files.ts";
import {
  normalizeOpenCodeConfigUsername,
  normalizeOpenCodeSkillList,
} from "./normalize-opencode.ts";

const prepareClaudeMcpCollision = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeJsonFixture(join(sandbox.claudeConfig, ".claude.json"), {
    mcpServers: {
      shared: mcpMarker("user"),
      "user-only": mcpMarker("user-only"),
    },
    projects: {
      [sandbox.workspace]: {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {
          shared: mcpMarker("local"),
          "local-only": mcpMarker("local-only"),
        },
        enabledMcpjsonServers: ["shared", "project-only"],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false,
      },
    },
  });
  await writeJsonFixture(join(sandbox.workspace, ".mcp.json"), {
    mcpServers: {
      shared: mcpMarker("project"),
      "project-only": mcpMarker("project-only"),
    },
  });
};

const prepareCodexMcpCollision = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeFixture(
    join(sandbox.codexHome, "config.toml"),
    [
      `model = "marker-global"`,
      "",
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
    join(sandbox.codexHome, "profile-team.config.toml"),
    [
      `model = "marker-profile"`,
      "",
      "[mcp_servers.shared]",
      `args = ["profile"]`,
      "",
      "[mcp_servers.profile-only]",
      `command = "/bin/echo"`,
      `args = ["profile-only"]`,
      "",
    ].join("\n"),
  );
  await writeFixture(
    join(sandbox.codexHome, "team.config.toml"),
    [
      "[mcp_servers.help-implied-profile-name]",
      `command = "/bin/echo"`,
      `args = ["help-implied-profile-name"]`,
      "",
    ].join("\n"),
  );
  await writeFixture(
    join(sandbox.workspace, ".codex", "config.toml"),
    [
      `model = "marker-project"`,
      "",
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

const opencodeMcp = (marker: string): object => ({
  type: "local",
  command: ["/bin/echo", marker],
  enabled: true,
});

const prepareOpenCodeConfigCollision = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeJsonFixture(
    join(sandbox.xdgConfig, "opencode", "opencode.json"),
    {
      username: "global",
      mcp: {
        shared: opencodeMcp("global"),
        "global-only": opencodeMcp("global-only"),
      },
    },
  );
  await writeJsonFixture(join(sandbox.root, "custom-opencode.json"), {
    username: "custom",
    mcp: {
      shared: opencodeMcp("custom"),
      "custom-only": opencodeMcp("custom-only"),
    },
  });
  await writeJsonFixture(join(sandbox.workspace, "opencode.json"), {
    username: "project",
    mcp: {
      shared: opencodeMcp("project"),
      "project-only": opencodeMcp("project-only"),
    },
  });
};

const prepareOpenCodeSkillCollision = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeSkillFixture(
    join(sandbox.xdgConfig, "opencode", "skills", "shared", "SKILL.md"),
    "shared",
    "opencode-global",
  );
  await writeSkillFixture(
    join(sandbox.home, ".claude", "skills", "shared", "SKILL.md"),
    "shared",
    "claude-compatible",
  );
  await writeSkillFixture(
    join(sandbox.home, ".agents", "skills", "shared", "SKILL.md"),
    "shared",
    "agents-compatible",
  );
  await writeSkillFixture(
    join(sandbox.workspace, ".opencode", "skills", "shared", "SKILL.md"),
    "shared",
    "opencode-project",
  );
};

const prepareCodexSkillCollision = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
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
};

const prepareOpenCodeExternalSkillSources = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeSkillFixture(
    join(
      sandbox.xdgConfig,
      "opencode",
      "skills",
      "opencode-global",
      "SKILL.md",
    ),
    "opencode-global",
    "opencode-global",
  );
  await writeSkillFixture(
    join(sandbox.home, ".claude", "skills", "claude-external", "SKILL.md"),
    "claude-external",
    "claude-external",
  );
  await writeSkillFixture(
    join(sandbox.home, ".agents", "skills", "agents-external", "SKILL.md"),
    "agents-external",
    "agents-external",
  );
  await writeSkillFixture(
    join(
      sandbox.workspace,
      ".opencode",
      "skills",
      "opencode-project",
      "SKILL.md",
    ),
    "opencode-project",
    "opencode-project",
  );
};

const prepareOpenCodeProjectConfigToggle = async (
  sandbox: ScenarioSandbox,
): Promise<void> => {
  await writeJsonFixture(
    join(sandbox.xdgConfig, "opencode", "opencode.json"),
    { username: "global" },
  );
  await writeJsonFixture(join(sandbox.workspace, "opencode.json"), {
    username: "project",
  });
};

const opencodeRepeatSkillProbe = fileURLToPath(
  new URL("./opencode-repeat-skill-probe.ts", import.meta.url),
);

export const configurationScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "claude-mcp-native-sources",
    provider: "claude",
    prepare: prepareClaudeMcpCollision,
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
    id: "codex-mcp-precedence",
    provider: "codex",
    prepare: prepareCodexMcpCollision,
    invocation: (sandbox) => ({
      executable: "codex",
      args: [
        "-C",
        sandbox.workspace,
        "-p",
        "team",
        "-c",
        'mcp_servers.shared.args=["session"]',
        "mcp",
        "list",
        "--json",
      ],
    }),
  },
  {
    id: "opencode-config-precedence",
    provider: "opencode",
    prepare: prepareOpenCodeConfigCollision,
    invocation: (sandbox) => ({
      executable: opencodeExecutable,
      args: ["debug", "config", "--pure"],
      cwd: sandbox.workspace,
      environment: {
        OPENCODE_CONFIG: join(sandbox.root, "custom-opencode.json"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          username: "session",
          mcp: {
            shared: opencodeMcp("session"),
            "session-only": opencodeMcp("session-only"),
          },
        }),
      },
    }),
  },
  {
    id: "opencode-skill-collision",
    provider: "opencode",
    prepare: prepareOpenCodeSkillCollision,
    invocation: (sandbox) => ({
      executable: opencodeExecutable,
      args: ["debug", "skill", "--pure"],
      cwd: sandbox.workspace,
    }),
    normalizeResult: normalizeOpenCodeSkillList,
  },
  {
    id: "opencode-external-skills-disabled",
    provider: "opencode",
    prepare: prepareOpenCodeExternalSkillSources,
    invocation: (sandbox) => ({
      executable: opencodeExecutable,
      args: ["debug", "skill", "--pure"],
      cwd: sandbox.workspace,
      environment: {
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      },
    }),
    normalizeResult: normalizeOpenCodeSkillList,
  },
  {
    id: "opencode-project-config-disabled",
    provider: "opencode",
    prepare: prepareOpenCodeProjectConfigToggle,
    invocation: (sandbox) => ({
      executable: opencodeExecutable,
      args: ["debug", "config", "--pure"],
      cwd: sandbox.workspace,
      environment: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    }),
    normalizeResult: normalizeOpenCodeConfigUsername,
  },
  {
    id: "codex-skill-collision",
    provider: "codex",
    prepare: prepareCodexSkillCollision,
    invocation: (sandbox) => ({
      executable: "codex",
      args: ["-C", sandbox.workspace, "debug", "prompt-input"],
    }),
  },
  ...advancedConfigurationScenarios(opencodeExecutable),
];

export const stabilityScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "opencode-skill-collision-repeat-50",
    provider: "opencode",
    prepare: prepareOpenCodeSkillCollision,
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [
        opencodeRepeatSkillProbe,
        opencodeExecutable,
        sandbox.workspace,
        "50",
      ],
      cwd: sandbox.workspace,
      timeoutMs: 180_000,
      trace: false,
    }),
  },
];
