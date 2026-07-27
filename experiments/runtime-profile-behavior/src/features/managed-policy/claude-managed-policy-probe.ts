import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  spawnProvider,
  terminateChildTree,
  waitForChild,
} from "./child-process.ts";
import {
  mountSyntheticEtc,
  prepareIsolatedProviderRoot,
  providerEnvironment,
  writeSystemConfig,
} from "./isolated-system-config.ts";

const root = process.argv[2];
if (root === undefined) {
  throw new Error("Expected probe root");
}

await prepareIsolatedProviderRoot(root);
const userMarker = join(root, "user-hook.marker");
const managedMarker = join(root, "managed-hook.marker");
const promptMarker = join(root, "user-prompt-hook.marker");
await writeFile(
  join(root, "home", ".claude", "settings.json"),
  `${JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            {
              type: "command",
              command: 'printf user > "$USER_HOOK_MARKER"',
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: 'printf prompt > "$PROMPT_HOOK_MARKER"',
            },
          ],
        },
      ],
    },
  })}\n`,
);
await writeSystemConfig(
  root,
  "claude-code/managed-settings.json",
  `${JSON.stringify({
    allowManagedHooksOnly: true,
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            {
              type: "command",
              command: 'printf managed > "$MANAGED_HOOK_MARKER"',
            },
          ],
        },
      ],
    },
  })}\n`,
);
mountSyntheticEtc(root);

const workspace = join(root, "workspace");
const staticPolicy = await waitForChild(
  spawnProvider("claude", ["--init-only"], {
    cwd: workspace,
    env: providerEnvironment(root, {
      USER_HOOK_MARKER: userMarker,
      MANAGED_HOOK_MARKER: managedMarker,
      PROMPT_HOOK_MARKER: promptMarker,
    }),
  }),
);

const helperLog = join(root, "policy-helper.log");
const helperMode = join(root, "policy-helper.mode");
const helperPath = join(root, "policy-helper.sh");
await writeFile(helperMode, "ok", { mode: 0o600 });
await writeFile(
  helperPath,
  [
    "#!/bin/sh",
    `printf 'call\\n' >> ${JSON.stringify(helperLog)}`,
    `if test "$(cat ${JSON.stringify(helperMode)})" = fail; then exit 42; fi`,
    `printf '%s\\n' '{"managedSettings":{"allowManagedHooksOnly":true}}'`,
    "",
  ].join("\n"),
  { mode: 0o700 },
);
await writeFile(
  "/etc/claude-code/managed-settings.json",
  `${JSON.stringify({
    policyHelper: {
      path: helperPath,
      timeoutMs: 2_000,
      refreshIntervalMs: 60_000,
    },
  })}\n`,
  { mode: 0o600 },
);

const longLived = spawnProvider(
  "claude",
  [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ],
  {
    cwd: workspace,
    env: providerEnvironment(root, { PROMPT_HOOK_MARKER: promptMarker }),
    stdin: "pipe",
  },
);
const longLivedCompletion = waitForChild(longLived, 90_000);
let longLivedClosed = false;
longLived.once("close", () => {
  longLivedClosed = true;
});
await new Promise((resolve) => setTimeout(resolve, 4_000));
const startupHelperCalls = (await readFile(helperLog, "utf8"))
  .split("\n")
  .filter(Boolean).length;
await writeFile(helperMode, "fail", { mode: 0o600 });
await new Promise((resolve) => setTimeout(resolve, 58_000));
const refreshHelperCalls = (await readFile(helperLog, "utf8"))
  .split("\n")
  .filter(Boolean).length;
const survivedRefreshFailure = !longLivedClosed;
if (!longLivedClosed) {
  longLived.stdin?.write(
    `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Reply with ok. Do not use tools." }],
      },
    })}\n`,
  );
  longLived.stdin?.end();
}
await longLivedCompletion;
const userPromptHookSuppressedAfterRefreshFailure = !(await fileExists(
  promptMarker,
));
terminateChildTree(longLived);

const failedStartup = await waitForChild(
  spawnProvider("claude", ["--init-only"], {
    cwd: workspace,
    env: providerEnvironment(root),
  }),
);

process.stdout.write(
  `${JSON.stringify({
    provider: "claude",
    staticManagedPolicy: {
      exitCode: staticPolicy.exitCode,
      userHookExecuted: await fileExists(userMarker),
      managedHookExecuted: await fileExists(managedMarker),
    },
    policyHelper: {
      startupHelperCalls,
      refreshHelperCalls,
      survivedRefreshFailure,
      userPromptHookSuppressedAfterRefreshFailure,
      failedStartupExitCode: failedStartup.exitCode,
    },
  })}\n`,
);

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
