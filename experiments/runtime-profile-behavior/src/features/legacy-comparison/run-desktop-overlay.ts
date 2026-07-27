import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runCommand } from "../process-execution/run-command.ts";
import type { ComparisonFixture, DesktopOverlaySummary } from "./types.ts";

const helperSource = `
import { pathToFileURL } from "node:url";

const [modulePath, fixtureRoot, preferredMcpName] = process.argv.slice(2);
if (!modulePath || !fixtureRoot || !preferredMcpName) throw new Error("probe arguments required");
const module = await import(pathToFileURL(modulePath).href);
const home = fixtureRoot + "/home";
const workspace = fixtureRoot + "/workspace";
const scanner = new module.OpenCodeBehaviorSourceScanner({ homePath: home });
const builder = new module.OpenCodeManagedOverlayBuilder(scanner);
const overlay = await builder.build({
  projectPath: workspace,
  preferredMcpName,
  appMcpCommand: "/bin/false",
  appMcpArgs: [],
  appMcpEnv: { RUNTIME_PROFILE_SPIKE: "1" },
});
process.stdout.write(JSON.stringify({
  appMcpServerName: overlay.appMcpServerName,
  env: overlay.env,
  preservedSources: overlay.preservedSources,
  diagnostics: overlay.diagnostics,
  declaredMcpNames: [...await scanner.readDeclaredMcpNames(workspace)].sort(),
}));
`;

export const runDesktopOverlay = async (
  desktopRoot: string,
  fixture: ComparisonFixture,
  preferredMcpName = "agent-teams",
): Promise<DesktopOverlaySummary> => {
  const sourcePath = join(
    desktopRoot,
    "src/main/services/team/opencode/config/OpenCodeManagedOverlay.ts",
  );
  const policyPath = join(
    desktopRoot,
    "src/main/services/runtime/openCodeAutoUpdatePolicy.ts",
  );
  const generatedPath = join(fixture.root, "OpenCodeManagedOverlay.generated.ts");
  const helperPath = join(fixture.root, "desktop-overlay-helper.ts");
  const source = await readFile(sourcePath, "utf8");
  const rewritten = source.replace(
    "from '@main/services/runtime/openCodeAutoUpdatePolicy'",
    `from ${JSON.stringify(pathToFileURL(policyPath).href)}`,
  );
  if (source === rewritten) {
    throw new Error("Desktop overlay import boundary changed; update the spike loader");
  }
  await Promise.all([
    writeFile(generatedPath, rewritten, { mode: 0o600 }),
    writeFile(helperPath, helperSource, { mode: 0o600 }),
  ]);
  const result = await runCommand(process.execPath, {
    args: [
      "--experimental-transform-types",
      helperPath,
      generatedPath,
      fixture.root,
      preferredMcpName,
    ],
    cwd: desktopRoot,
    env: { HOME: fixture.home, PATH: process.env.PATH },
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Desktop overlay probe failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as DesktopOverlaySummary;
};
