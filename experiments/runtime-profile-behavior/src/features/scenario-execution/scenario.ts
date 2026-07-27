import type {
  CommandResult,
  ObservationAssertion,
  ProviderId,
  ScenarioEvidence,
} from "../../model.ts";

export interface ScenarioSandbox {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly temp: string;
  readonly xdgConfig: string;
  readonly xdgData: string;
  readonly xdgState: string;
  readonly xdgCache: string;
  readonly codexHome: string;
  readonly claudeConfig: string;
}

export interface ProbeInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly expectedTimeout?: boolean;
  readonly trace?: boolean;
}

export interface ProbeScenario {
  readonly id: string;
  readonly provider: ProviderId;
  readonly prepare?: (sandbox: ScenarioSandbox) => Promise<void>;
  readonly invocation: (sandbox: ScenarioSandbox) => ProbeInvocation;
  readonly normalizeResult?: (result: CommandResult) => CommandResult;
  readonly verify?: (
    sandbox: ScenarioSandbox,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly assertions?: (
    evidence: ScenarioEvidence,
  ) => readonly ObservationAssertion[];
}

export const baselineScenarios = (
  opencodeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "claude-empty-mcp",
    provider: "claude",
    invocation: () => ({
      executable: "claude",
      args: ["--setting-sources", "user,project,local", "mcp", "list"],
    }),
  },
  {
    id: "codex-empty-mcp",
    provider: "codex",
    invocation: (sandbox) => ({
      executable: "codex",
      args: ["-C", sandbox.workspace, "mcp", "list", "--json"],
    }),
  },
  {
    id: "codex-empty-prompt-input",
    provider: "codex",
    invocation: (sandbox) => ({
      executable: "codex",
      args: ["-C", sandbox.workspace, "debug", "prompt-input"],
    }),
  },
  {
    id: "opencode-empty-config",
    provider: "opencode",
    invocation: (sandbox) => ({
      executable: opencodeExecutable,
      args: ["debug", "config", "--pure"],
      cwd: sandbox.workspace,
    }),
  },
];
