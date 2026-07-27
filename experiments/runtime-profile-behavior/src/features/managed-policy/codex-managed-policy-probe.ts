import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { spawnProvider, terminateChildTree } from "./child-process.ts";
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
await writeSystemConfig(
  root,
  "codex/requirements.toml",
  [
    "allow_managed_hooks_only = true",
    'allowed_sandbox_modes = ["read-only"]',
    "",
  ].join("\n"),
);
mountSyntheticEtc(root);

interface RpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

const child = spawnProvider("codex", ["app-server", "--stdio"], {
  cwd: join(root, "workspace"),
  env: providerEnvironment(root),
  stdin: "pipe",
});
if (child.stdin === null || child.stdout === null) {
  throw new Error("Codex app-server pipes are unavailable");
}

const responses = new Map<number, RpcResponse>();
const waiters = new Map<number, () => void>();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line) as RpcResponse;
    if (message.id !== undefined) {
      responses.set(message.id, message);
      waiters.get(message.id)?.();
    }
  } catch {
    // Diagnostics are not protocol messages.
  }
});

let nextId = 1;
const request = async (
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<RpcResponse> => {
  const id = nextId;
  nextId += 1;
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  if (!responses.has(id)) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Codex request timed out: ${method}`)),
        10_000,
      );
      waiters.set(id, () => {
        clearTimeout(timeout);
        waiters.delete(id);
        resolve();
      });
    });
  }
  const response = responses.get(id);
  if (response === undefined) {
    throw new Error(`Missing Codex response: ${method}`);
  }
  return response;
};

await request("initialize", {
  clientInfo: { name: "runtime-profile-spike", version: "0.0.0" },
  capabilities: { experimentalApi: true },
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
);

const before = await request("configRequirements/read");
await writeFile(
  "/etc/codex/requirements.toml",
  [
    "allow_managed_hooks_only = false",
    'allowed_sandbox_modes = ["read-only", "workspace-write"]',
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const after = await request("configRequirements/read");
await writeFile("/etc/codex/requirements.toml", "invalid = [\n", {
  mode: 0o600,
});
const corrupt = await request("configRequirements/read");

terminateChildTree(child);
lines.close();

const requirements = (response: RpcResponse): Record<string, unknown> | null => {
  if (typeof response.result !== "object" || response.result === null) {
    return null;
  }
  const value = (response.result as Record<string, unknown>).requirements;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
};

process.stdout.write(
  `${JSON.stringify({
    provider: "codex",
    before: requirements(before),
    sameProcessAfterDrift: requirements(after),
    corruptRequirementsRejected: corrupt.error !== undefined,
    corruptError: corrupt.error,
  })}\n`,
);
