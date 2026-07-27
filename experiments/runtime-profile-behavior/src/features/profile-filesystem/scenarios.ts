import { chmod, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandResult, ScenarioEvidence } from "../../model.ts";
import { writeFixture, writeJsonFixture } from "../config-precedence/fixture-files.ts";
import { normalizeOpenCodeConfigUsername } from "../config-precedence/normalize-opencode.ts";
import {
  copyCredentialFixture,
  type CredentialFixtureGuard,
} from "../credential-routes/credential-fixture.ts";
import { runCommand } from "../process-execution/run-command.ts";
import type {
  ProbeScenario,
  ScenarioSandbox,
} from "../scenario-execution/scenario.ts";

const NOBODY = "65534:65534";
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

const requireCommandSuccess = async (
  executable: string,
  args: readonly string[],
): Promise<void> => {
  const result = await runCommand(executable, { args });
  if (result.exitCode !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${result.stderr}`,
    );
  }
};

const makeUnprivilegedWithReadOnlyPath = async (
  sandbox: ScenarioSandbox,
  readOnlyPath: string,
): Promise<void> => {
  const sandboxRoot = dirname(sandbox.root);
  const runRoot = dirname(sandboxRoot);
  const runsRoot = dirname(runRoot);
  const spikeRoot = dirname(runsRoot);
  for (const path of [spikeRoot, runsRoot, runRoot, sandboxRoot]) {
    const current = await stat(path);
    await chmod(path, current.mode | 0o001);
  }
  await requireCommandSuccess("chown", ["-R", NOBODY, sandbox.root]);
  await requireCommandSuccess("chmod", ["-R", "a-w", readOnlyPath]);
};

const asNobody = (
  executable: string,
  args: readonly string[],
): readonly string[] => [
  "--reuid=65534",
  "--regid=65534",
  "--clear-groups",
  "--",
  executable,
  ...args,
];

const exitAndMarkerAssertions = (
  marker: string,
): NonNullable<ProbeScenario["assertions"]> =>
  (evidence: ScenarioEvidence) => [
    {
      id: `${evidence.provider}.read-only-config-command-succeeded`,
      passed: evidence.result.exitCode === 0,
      expected: 0,
      actual: evidence.result.exitCode,
    },
    {
      id: `${evidence.provider}.read-only-config-marker-observed`,
      passed: evidence.result.stdout.includes(marker),
      expected: marker,
      actual: evidence.result.stdout,
    },
  ];

const prepareClaude = async (sandbox: ScenarioSandbox): Promise<void> => {
  await writeJsonFixture(join(sandbox.claudeConfig, ".claude.json"), {
    mcpServers: {
      "readonly-global": {
        type: "stdio",
        command: "/bin/echo",
        args: ["readonly-global"],
      },
    },
  });
  await makeUnprivilegedWithReadOnlyPath(sandbox, sandbox.claudeConfig);
};

const prepareCodex = async (sandbox: ScenarioSandbox): Promise<void> => {
  await writeFixture(
    join(sandbox.codexHome, "config.toml"),
    [
      "[mcp_servers.readonly-global]",
      'command = "/bin/echo"',
      'args = ["readonly-global"]',
      "",
    ].join("\n"),
  );
  await makeUnprivilegedWithReadOnlyPath(sandbox, sandbox.codexHome);
};

const prepareOpenCode = async (sandbox: ScenarioSandbox): Promise<void> => {
  const configRoot = join(sandbox.xdgConfig, "opencode");
  await writeJsonFixture(join(configRoot, "opencode.jsonc"), {
    username: "readonly-global",
  });
  await writeFixture(
    join(configRoot, ".gitignore"),
    "node_modules\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\n",
  );
  await makeUnprivilegedWithReadOnlyPath(sandbox, sandbox.xdgConfig);
};

const normalizeCodexExecution = (result: CommandResult): CommandResult => {
  const events = result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const thread = events.find((event) => event.type === "thread.started");
  const message = events.find(
    (event) =>
      event.type === "item.completed" &&
      typeof event.item === "object" &&
      event.item !== null &&
      (event.item as Record<string, unknown>).type === "agent_message",
  );
  return {
    ...result,
    stdout: `${JSON.stringify(
      {
        threadId: thread?.thread_id,
        finalText:
          typeof message?.item === "object" && message.item !== null
            ? (message.item as Record<string, unknown>).text
            : undefined,
        eventTypes: [...new Set(events.map((event) => event.type))],
      },
      null,
      2,
    )}\n`,
  };
};

const codexExecutionAssertions = (
  expectedMarker: string,
  expectedSuccess: boolean,
): NonNullable<ProbeScenario["assertions"]> =>
  (evidence) => {
    let output: Record<string, unknown> = {};
    try {
      output = JSON.parse(evidence.result.stdout) as Record<string, unknown>;
    } catch {
      output = {};
    }
    if (!expectedSuccess) {
      return [
        {
          id: `${evidence.scenarioId}.read-only-runtime-root-rejected`,
          passed:
            evidence.result.exitCode !== 0 &&
            evidence.result.stderr.includes("Permission denied"),
          expected: "permission-denied execution failure",
          actual: {
            exitCode: evidence.result.exitCode,
            stderr: evidence.result.stderr,
          },
        },
        {
          id: `${evidence.scenarioId}.provider-thread-not-created`,
          passed: output.threadId === undefined,
          expected: undefined,
          actual: output.threadId,
        },
      ];
    }
    return [
      {
        id: `${evidence.scenarioId}.execution-succeeded`,
        passed: evidence.result.exitCode === 0,
        expected: 0,
        actual: evidence.result.exitCode,
      },
      {
        id: `${evidence.scenarioId}.returned-marker`,
        passed: output.finalText === expectedMarker,
        expected: expectedMarker,
        actual: output.finalText,
      },
      {
        id: `${evidence.scenarioId}.provider-thread-created`,
        passed: typeof output.threadId === "string",
        expected: "opaque thread id",
        actual: output.threadId,
      },
    ];
  };

const codexExecutionArgs = (
  sandbox: ScenarioSandbox,
  marker: string,
  ephemeral: boolean,
): readonly string[] =>
  asNobody("codex", [
    "exec",
    ...(ephemeral ? ["--ephemeral"] : []),
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--sandbox",
    "read-only",
    "-m",
    "gpt-5.4-mini",
    "-C",
    sandbox.workspace,
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "plugin_sharing",
    "--disable",
    "skill_mcp_dependency_install",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    `Reply with exactly ${marker}. Do not use tools.`,
  ]);

const readOnlyCodexExecutionScenario = (
  ephemeral: boolean,
): ProbeScenario => {
  const marker = ephemeral
    ? "runtime-profile-readonly-ephemeral-ok"
    : "runtime-profile-readonly-persisted-ok";
  let guard: CredentialFixtureGuard | undefined;
  return {
    id: ephemeral
      ? "codex-read-only-config-ephemeral-execution"
      : "codex-read-only-config-persisted-execution",
    provider: "codex",
    async prepare(sandbox) {
      guard = await copyCredentialFixture(
        join(
          process.cwd(),
          ".spike",
          "credential-sources",
          "codex-auth.json",
        ),
        join(sandbox.codexHome, "auth.json"),
      );
      await writeFixture(
        join(sandbox.codexHome, "config.toml"),
        [
          `[projects.${JSON.stringify(sandbox.workspace)}]`,
          'trust_level = "trusted"',
          "",
        ].join("\n"),
      );
      await makeUnprivilegedWithReadOnlyPath(
        sandbox,
        sandbox.codexHome,
      );
    },
    invocation: (sandbox) => ({
      executable: "setpriv",
      args: codexExecutionArgs(sandbox, marker, ephemeral),
      timeoutMs: 70_000,
    }),
    normalizeResult: normalizeCodexExecution,
    assertions: codexExecutionAssertions(marker, false),
    async verify() {
      if (guard === undefined) {
        throw new Error("Credential fixture guard was not initialized");
      }
      return guard.verifySourceUnchanged();
    },
  };
};

const linkedImmutableCodexConfigScenario = (): ProbeScenario => {
  const marker = "runtime-profile-linked-immutable-config-ok";
  let guard: CredentialFixtureGuard | undefined;
  return {
    id: "codex-writable-runtime-linked-immutable-config",
    provider: "codex",
    async prepare(sandbox) {
      guard = await copyCredentialFixture(
        join(
          process.cwd(),
          ".spike",
          "credential-sources",
          "codex-auth.json",
        ),
        join(sandbox.codexHome, "auth.json"),
      );
      const revisionRoot = join(sandbox.root, "profile-revision");
      const revisionConfig = join(revisionRoot, "config.toml");
      await writeFixture(
        revisionConfig,
        [
          `[projects.${JSON.stringify(sandbox.workspace)}]`,
          'trust_level = "trusted"',
          "",
        ].join("\n"),
      );
      await symlink(
        revisionConfig,
        join(sandbox.codexHome, "config.toml"),
      );
      await makeUnprivilegedWithReadOnlyPath(sandbox, revisionRoot);
    },
    invocation: (sandbox) => ({
      executable: "setpriv",
      args: codexExecutionArgs(sandbox, marker, false),
      timeoutMs: 70_000,
    }),
    normalizeResult: normalizeCodexExecution,
    assertions: (evidence) => [
      ...codexExecutionAssertions(marker, true)(evidence),
      {
        id: "codex.immutable-profile-source-unchanged",
        passed: !evidence.filesystem.changed.some((entry) =>
          entry.after.path.startsWith("profile-revision/"),
        ),
        expected: [],
        actual: evidence.filesystem.changed
          .map((entry) => entry.after.path)
          .filter((path) => path.startsWith("profile-revision/")),
      },
    ],
    async verify() {
      if (guard === undefined) {
        throw new Error("Credential fixture guard was not initialized");
      }
      return guard.verifySourceUnchanged();
    },
  };
};

const readOnlyOpenCodeAcpScenario = (
  opencodeExecutable: string,
): ProbeScenario => ({
  id: "opencode-read-only-config-acp-execution",
  provider: "opencode",
  prepare: prepareOpenCode,
  invocation: (sandbox) => ({
    executable: "setpriv",
    args: asNobody(process.execPath, [
      opencodeAcpProbe,
      opencodeExecutable,
      sandbox.workspace,
    ]),
    cwd: sandbox.workspace,
    timeoutMs: 100_000,
  }),
  assertions: (evidence) => {
    let output: Record<string, unknown> = {};
    try {
      output = record(JSON.parse(evidence.result.stdout));
    } catch {
      output = {};
    }
    const v1 = record(output.v1);
    return [
      {
        id: "opencode.read-only-config-acp-execution-succeeded",
        passed:
          evidence.result.exitCode === 0 &&
          String(v1.promptText).trim() === "runtime-profile-acp-ok",
        expected: "runtime-profile-acp-ok",
        actual: {
          exitCode: evidence.result.exitCode,
          promptText: v1.promptText,
        },
      },
      {
        id: "opencode.read-only-config-remained-unchanged",
        passed: !evidence.filesystem.changed.some((entry) =>
          entry.after.path.startsWith("home/.config/"),
        ),
        expected: [],
        actual: evidence.filesystem.changed
          .map((entry) => entry.after.path)
          .filter((path) => path.startsWith("home/.config/")),
      },
    ];
  },
});

export const profileFilesystemScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "claude-read-only-config-root",
    provider: "claude",
    prepare: prepareClaude,
    invocation: () => ({
      executable: "setpriv",
      args: asNobody("claude", [
        "--setting-sources",
        "user",
        "mcp",
        "list",
      ]),
      timeoutMs: 45_000,
    }),
    assertions: exitAndMarkerAssertions("readonly-global"),
  },
  {
    id: "codex-read-only-config-root",
    provider: "codex",
    prepare: prepareCodex,
    invocation: (sandbox) => ({
      executable: "setpriv",
      args: asNobody("codex", [
        "-C",
        sandbox.workspace,
        "mcp",
        "list",
        "--json",
      ]),
      timeoutMs: 30_000,
    }),
    assertions: exitAndMarkerAssertions("readonly-global"),
  },
  {
    id: "opencode-read-only-config-writable-state",
    provider: "opencode",
    prepare: prepareOpenCode,
    invocation: (sandbox) => ({
      executable: "setpriv",
      args: asNobody(opencodeExecutable, ["debug", "config", "--pure"]),
      cwd: sandbox.workspace,
      timeoutMs: 30_000,
    }),
    normalizeResult: normalizeOpenCodeConfigUsername,
    assertions: exitAndMarkerAssertions("readonly-global"),
  },
  readOnlyCodexExecutionScenario(true),
  readOnlyCodexExecutionScenario(false),
  linkedImmutableCodexConfigScenario(),
  readOnlyOpenCodeAcpScenario(opencodeExecutable),
];
