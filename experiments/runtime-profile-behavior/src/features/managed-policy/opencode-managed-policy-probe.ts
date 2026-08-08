import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "../process-execution/run-command.ts";
import {
  mountSyntheticEtc,
  prepareIsolatedProviderRoot,
  providerEnvironment,
  writeSystemConfig,
} from "./isolated-system-config.ts";

const root = process.argv[2];
const opencodeExecutable = process.argv[3];
const handshakeProbe = process.argv[4];
if (
  root === undefined ||
  opencodeExecutable === undefined ||
  handshakeProbe === undefined
) {
  throw new Error("Expected probe root, OpenCode executable, and ACP probe");
}

await prepareIsolatedProviderRoot(root);
await writeFile(
  join(root, "home", ".config", "opencode", "opencode.json"),
  `${JSON.stringify({
    username: "global",
    permission: { bash: "allow" },
  })}\n`,
);
await writeFile(
  join(root, "workspace", "opencode.json"),
  `${JSON.stringify({
    username: "project",
    permission: { bash: "ask" },
  })}\n`,
);
await writeSystemConfig(
  root,
  "opencode/opencode.json",
  `${JSON.stringify({
    username: "managed-before",
    permission: { bash: "deny" },
    command: {
      "before-drift": {
        template: "Before drift",
        description: "Before drift",
      },
    },
  })}\n`,
);
mountSyntheticEtc(root);

const environment = providerEnvironment(root);
const staticResult = await runCommand(opencodeExecutable, {
  args: ["debug", "config", "--pure"],
  cwd: join(root, "workspace"),
  env: environment,
  timeoutMs: 20_000,
});
if (staticResult.exitCode !== 0) {
  throw new Error(`OpenCode static probe failed: ${staticResult.stderr}`);
}
const staticConfig = JSON.parse(staticResult.stdout) as Record<string, unknown>;

const driftResult = await runCommand(process.execPath, {
  args: [
    handshakeProbe,
    opencodeExecutable,
    join(root, "workspace"),
    "/etc/opencode/opencode.json",
  ],
  cwd: join(root, "workspace"),
  env: environment,
  timeoutMs: 30_000,
});
if (driftResult.exitCode !== 0) {
  throw new Error(`OpenCode ACP drift probe failed: ${driftResult.stderr}`);
}
const drift = JSON.parse(driftResult.stdout) as Record<string, unknown>;
const v1 = drift.v1 as Record<string, unknown>;
const firstSessionId = sessionId(v1.sessionNew);
const secondSessionId = sessionId(v1.sessionNewAfterDrift);
const commands = v1.availableCommandsBySession as Record<string, unknown>;

const newProcessResult = await runCommand(opencodeExecutable, {
  args: ["debug", "config", "--pure"],
  cwd: join(root, "workspace"),
  env: environment,
  timeoutMs: 20_000,
});
if (newProcessResult.exitCode !== 0) {
  throw new Error(`OpenCode post-drift probe failed: ${newProcessResult.stderr}`);
}
const newProcessConfig = JSON.parse(
  newProcessResult.stdout,
) as Record<string, unknown>;
await writeFile("/etc/opencode/opencode.json", "{not-valid-json\n", {
  mode: 0o600,
});
const corruptResult = await runCommand(opencodeExecutable, {
  args: ["debug", "config", "--pure"],
  cwd: join(root, "workspace"),
  env: environment,
  timeoutMs: 20_000,
});

process.stdout.write(
  `${JSON.stringify({
    provider: "opencode",
    staticManagedPrecedence: {
      username: staticConfig.username,
      bashPermission: (staticConfig.permission as Record<string, unknown>)?.bash,
    },
    sameProcessDrift: {
      firstCommands: firstSessionId === null ? [] : commands[firstSessionId],
      secondCommands: secondSessionId === null ? [] : commands[secondSessionId],
    },
    newProcessAfterDrift: {
      username: newProcessConfig.username,
      commands: Object.keys(
        (newProcessConfig.command as Record<string, unknown> | undefined) ?? {},
      ).toSorted(),
    },
    corruptManagedConfigRejected: corruptResult.exitCode !== 0,
  })}\n`,
);

function sessionId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const result = (value as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const id = (result as Record<string, unknown>).sessionId;
  return typeof id === "string" ? id : null;
}
