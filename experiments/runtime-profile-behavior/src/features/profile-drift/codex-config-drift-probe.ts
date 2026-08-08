import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const workspace = process.argv[2];
const driftAction = process.argv[3] ?? "mutate";
if (workspace === undefined) {
  throw new Error("Expected workspace path");
}
const codexHome = process.env.CODEX_HOME;
if (codexHome === undefined) {
  throw new Error("CODEX_HOME is required");
}

type RpcMessage = {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
};

const child = spawn("codex", ["app-server", "--stdio"], {
  cwd: workspace,
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});
const messages = new Map<number, RpcMessage>();
const waiters = new Map<number, () => void>();
let stderr = "";

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
  stderr += chunk;
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line) as RpcMessage;
    if (message.id !== undefined) {
      messages.set(message.id, message);
      waiters.get(message.id)?.();
    }
  } catch {
    // Ignore non-protocol diagnostics.
  }
});

let nextId = 1;
const request = async (
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const id = nextId;
  nextId += 1;
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  if (!messages.has(id)) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Codex request timed out: ${method}`)),
        15_000,
      );
      waiters.set(id, () => {
        clearTimeout(timeout);
        waiters.delete(id);
        resolve();
      });
    });
  }
  const response = messages.get(id);
  if (response?.error !== undefined) {
    throw new Error(`Codex request failed: ${JSON.stringify(response.error)}`);
  }
  return (response?.result ?? {}) as Record<string, unknown>;
};

await request("initialize", {
  clientInfo: { name: "runtime-profile-spike", version: "0.0.0" },
  capabilities: { experimentalApi: true },
});
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    method: "initialized",
    params: {},
  })}\n`,
);

const readConfig = async () => {
  const result = await request("config/read", {
    cwd: workspace,
    includeLayers: true,
  });
  const config = (result.config ?? {}) as Record<string, unknown>;
  return {
    model: config.model,
    developerInstructions: config.developer_instructions,
    layerCount: Array.isArray(result.layers) ? result.layers.length : 0,
  };
};

const before = await readConfig();
await writeFile(
  join(codexHome, "config.toml"),
  driftAction === "corrupt"
    ? "this is not valid toml = [\n"
    : [
        'model = "marker-after"',
        'developer_instructions = "runtime-profile-spike:after"',
        "",
        `[projects.${JSON.stringify(workspace)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
  { mode: 0o600 },
);
let after: Record<string, unknown> | null = null;
let afterError: string | null = null;
try {
  after = await readConfig();
} catch (error) {
  afterError = error instanceof Error ? error.message : "Unknown config error";
}

child.stdin.end();
await Promise.race([
  new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  }),
  new Promise((resolve) => {
    setTimeout(resolve, 1_000);
  }),
]);
if (child.exitCode === null && child.signalCode === null) {
  child.kill("SIGTERM");
}
lines.close();

process.stdout.write(
  `${JSON.stringify(
    {
      before,
      after,
      afterError,
      driftAction,
      changedWithinProcess:
        after !== null &&
        (before.model !== after.model ||
          before.developerInstructions !== after.developerInstructions),
      stderr: stderr.slice(0, 2_000),
    },
    null,
    2,
  )}\n`,
);
