import { spawn } from "node:child_process";

const workspace = process.argv[2];
if (workspace === undefined) {
  throw new Error("Expected workspace path");
}

interface RpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const child = spawn("codex", ["app-server", "--stdio"], {
  cwd: workspace,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const messages: RpcMessage[] = [];
let stdoutBuffer = "";
let stderr = "";
let completed = false;

const completion = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error("Codex app-server probe timed out"));
  }, 15_000);

  child.on("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on("close", (code) => {
    if (!completed) {
      clearTimeout(timeout);
      reject(
        new Error(
          `Codex app-server exited before responses, code=${String(code)}`,
        ),
      );
    }
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        messages.push(JSON.parse(line) as RpcMessage);
      } catch {
        continue;
      }
    }

    if (messages.some((message) => message.id === 4)) {
      completed = true;
      clearTimeout(timeout);
      resolve();
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
});

const requests = [
  {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "runtime-profile-spike", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    },
  },
  { method: "initialized", params: {} },
  {
    id: 2,
    method: "config/read",
    params: { cwd: workspace, includeLayers: true },
  },
  {
    id: 3,
    method: "skills/list",
    params: { cwds: [workspace], forceReload: true },
  },
  {
    id: 4,
    method: "hooks/list",
    params: { cwds: [workspace] },
  },
];

for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
}

try {
  await completion;
} finally {
  child.kill("SIGTERM");
}

const result = (id: number): Record<string, unknown> => {
  const message = messages.find((candidate) => candidate.id === id);
  if (message?.error !== undefined) {
    throw new Error(`Codex app-server request ${id} failed`);
  }
  return (message?.result ?? {}) as Record<string, unknown>;
};

const configResult = result(2);
const config = (configResult.config ?? {}) as Record<string, unknown>;
const layers = Array.isArray(configResult.layers)
  ? configResult.layers
  : [];
const skillsResult = result(3);
const skillsData = Array.isArray(skillsResult.data)
  ? skillsResult.data
  : [];
const skillEntry = (skillsData[0] ?? {}) as Record<string, unknown>;
const skills = Array.isArray(skillEntry.skills) ? skillEntry.skills : [];
const hooksResult = result(4);
const hooksData = Array.isArray(hooksResult.data) ? hooksResult.data : [];
const hookEntry = (hooksData[0] ?? {}) as Record<string, unknown>;
const hooks = Array.isArray(hookEntry.hooks) ? hookEntry.hooks : [];

const selectedSkills = skills
  .filter((value) => {
    const skill = value as Record<string, unknown>;
    return skill.scope !== "system";
  })
  .map((value) => {
    const skill = value as Record<string, unknown>;
    return {
      name: skill.name,
      scope: skill.scope,
      enabled: skill.enabled,
      path: skill.path,
    };
  });

const notifications = messages
  .filter((message) => message.id === undefined && message.method !== undefined)
  .map((message) => ({
    method: message.method,
    summary:
      typeof message.params === "object" && message.params !== null
        ? (message.params as Record<string, unknown>).summary
        : undefined,
  }));

process.stdout.write(
  `${JSON.stringify(
    {
      config: {
        model: config.model,
        developerInstructions: config.developer_instructions,
        mcpServers: config.mcp_servers,
      },
      layers: layers.map((value) => {
        const layer = value as Record<string, unknown>;
        const name = (layer.name ?? {}) as Record<string, unknown>;
        const layerConfig = (layer.config ?? {}) as Record<string, unknown>;
        return {
          type: name.type,
          file: name.file,
          profile: name.profile,
          configKeys: Object.keys(layerConfig).sort(),
        };
      }),
      originKeys: Object.keys(
        (configResult.origins ?? {}) as Record<string, unknown>,
      ).sort(),
      skills: selectedSkills,
      skillErrors: skillEntry.errors,
      hooks,
      hookWarnings: hookEntry.warnings,
      hookErrors: hookEntry.errors,
      notifications,
      stderr: stderr.slice(0, 4_000),
    },
    null,
    2,
  )}\n`,
);
