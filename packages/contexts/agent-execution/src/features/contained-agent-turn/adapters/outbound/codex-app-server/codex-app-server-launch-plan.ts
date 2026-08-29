import type { HostCustodyLaunchPlan } from "../host-custody/custodied-provider-process.js";

const DISABLED_CODEX_FEATURES = Object.freeze([
  "apps",
  "browser_use",
  "computer_use",
  "image_generation",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
] as const);

export interface CodexAppServerLaunchPlanOptions {
  readonly binaryRevision: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly executableSha256: string;
}

export const createCodexAppServerLaunchPlan = (
  options: CodexAppServerLaunchPlanOptions,
): HostCustodyLaunchPlan => {
  const launchArguments = ["app-server", "--stdio", "--strict-config"];
  for (const feature of DISABLED_CODEX_FEATURES) {launchArguments.push("--disable", feature);}
  return Object.freeze({
    arguments: Object.freeze(launchArguments),
    binaryRevision: options.binaryRevision,
    containmentProfile: "cooperative-posix",
    environment: Object.freeze({ ...options.environment }),
    executablePath: options.executablePath,
    executableSha256: options.executableSha256,
    provider: "codex",
  });
};
