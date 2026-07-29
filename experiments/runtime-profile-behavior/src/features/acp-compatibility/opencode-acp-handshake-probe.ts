import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const executable = process.argv[2];
const workspace = process.argv[3];
const driftConfigPath = process.argv[4];
const driftAction = process.argv[5] ?? "mutate";
if (executable === undefined || workspace === undefined) {
  throw new Error("Expected OpenCode executable and workspace");
}

type JsonRpcMessage = {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

type PendingRequest = {
  readonly resolve: (message: JsonRpcMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const runHandshake = async (
  requestedProtocolVersion: 1 | 2,
  resumeSessionId?: string,
  executePrompt = false,
  configPathToMutate?: string,
  configDriftAction = "mutate",
) => {
  const child = spawn(
    executable,
    ["acp", "--pure", "--cwd", workspace],
    {
      cwd: workspace,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const messages: JsonRpcMessage[] = [];
  const pending = new Map<number | string, PendingRequest>();
  let nextId = 1;
  let stderr = "";
  let exited = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitPromise = new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      exited = true;
      resolve({ exitCode, signal });
    });
  });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      messages.push({ method: "<invalid-json>", params: line });
      return;
    }
    messages.push(message);
    if (
      message.id !== undefined &&
      message.id !== null &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const request = pending.get(message.id);
      if (request !== undefined) {
        clearTimeout(request.timeout);
        pending.delete(message.id);
        request.resolve(message);
      }
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const response =
        message.method === "session/request_permission"
          ? {
              jsonrpc: "2.0",
              id: message.id,
              result: { outcome: { outcome: "cancelled" } },
            }
          : {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32601,
                message: `Unsupported spike client method: ${message.method}`,
              },
            };
      child.stdin.write(
        `${JSON.stringify(response)}\n`,
      );
    }
  });

  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<JsonRpcMessage> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };

  const initializeParams =
    requestedProtocolVersion === 1
      ? {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "agent-runtime-profile-spike",
            version: "0.0.0",
          },
        }
      : {
          protocolVersion: 2,
          info: {
            name: "agent-runtime-profile-spike",
            title: "Agent Runtime Profile Spike",
            version: "0.0.0",
          },
          capabilities: {},
        };

  let initialize: JsonRpcMessage | undefined;
  let sessionNew: JsonRpcMessage | undefined;
  let sessionList: JsonRpcMessage | undefined;
  let sessionClose: JsonRpcMessage | undefined;
  let sessionResume: JsonRpcMessage | undefined;
  let resumedSessionClose: JsonRpcMessage | undefined;
  let promptResponse: JsonRpcMessage | undefined;
  let sessionNewAfterDrift: JsonRpcMessage | undefined;
  let sessionCloseAfterDrift: JsonRpcMessage | undefined;
  let workflowError: string | undefined;
  try {
    initialize = await request("initialize", initializeParams);
    const initializeResult = record(initialize.result);
    const negotiatedProtocolVersion = initializeResult.protocolVersion;
    if (negotiatedProtocolVersion === 1 || negotiatedProtocolVersion === 2) {
      if (resumeSessionId !== undefined) {
        sessionResume = await request("session/resume", {
          sessionId: resumeSessionId,
          cwd: workspace,
          mcpServers: [],
        });
        resumedSessionClose = await request("session/close", {
          sessionId: resumeSessionId,
        });
      }
      sessionNew = await request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      const sessionId = record(sessionNew.result).sessionId;
      if (executePrompt && typeof sessionId === "string") {
        promptResponse = await request(
          "session/prompt",
          {
            sessionId,
            prompt: [
              {
                type: "text",
                text: "Reply with exactly runtime-profile-acp-ok. Do not use tools.",
              },
            ],
          },
          60_000,
        );
      }
      if (configPathToMutate !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (configDriftAction === "delete") {
          await unlink(configPathToMutate);
        } else {
          await writeFile(
            configPathToMutate,
            `${JSON.stringify(
              {
                username: "after-drift",
                command: {
                  "after-drift": {
                    template: "After drift",
                    description: "After drift",
                  },
                },
              },
              null,
              2,
            )}\n`,
            { mode: 0o600 },
          );
        }
        sessionNewAfterDrift = await request("session/new", {
          cwd: workspace,
          mcpServers: [],
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const driftSessionId = record(
          sessionNewAfterDrift.result,
        ).sessionId;
        if (typeof driftSessionId === "string") {
          sessionCloseAfterDrift = await request("session/close", {
            sessionId: driftSessionId,
          });
        }
      }
      sessionList = await request("session/list", { cwd: workspace });
      if (typeof sessionId === "string") {
        sessionClose = await request("session/close", { sessionId });
      }
    }
  } catch (error) {
    workflowError = error instanceof Error ? error.message : "Unknown ACP error";
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("ACP connection closed"));
    }
    pending.clear();
    child.stdin.end();
  }

  await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (!exited) {
    child.kill("SIGTERM");
  }
  const processResult = await exitPromise;
  lines.close();

  return {
    requestedProtocolVersion,
    initialize,
    negotiatedProtocolVersion: record(initialize?.result).protocolVersion,
    sessionNew,
    sessionList,
    sessionClose,
    sessionResume,
    resumedSessionClose,
    promptResponse,
    sessionNewAfterDrift,
    sessionCloseAfterDrift,
    promptText: messages
      .map((message) => record(record(message.params).update))
      .filter(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          record(update.content).type === "text",
      )
      .map((update) => record(update.content).text)
      .filter((text): text is string => typeof text === "string")
      .join(""),
    workflowError,
    process: {
      ...processResult,
      stderr,
    },
    unsolicitedMethods: messages
      .filter(
        (message) =>
          message.method !== undefined &&
          message.id === undefined,
      )
      .map((message) => message.method),
    unsolicitedNotifications: messages
      .filter(
        (message) =>
          message.method !== undefined &&
          message.id === undefined,
      )
      .map(({ method, params }) => ({ method, params })),
    clientRequests: messages
      .filter(
        (message) =>
          message.method !== undefined &&
          message.id !== undefined,
      )
      .map(({ method, params }) => ({ method, params })),
    availableCommandsBySession: Object.fromEntries(
      messages
        .map((message) => record(message.params))
        .filter(
          (params) =>
            record(params.update).sessionUpdate ===
            "available_commands_update",
        )
        .map((params) => [
          params.sessionId,
          Array.isArray(record(params.update).availableCommands)
            ? (
                record(params.update).availableCommands as Array<
                  Record<string, unknown>
                >
              ).map((command) => command.name)
            : [],
        ]),
    ),
  };
};

if (driftConfigPath !== undefined) {
  const v1 = await runHandshake(
    1,
    undefined,
    false,
    driftConfigPath,
    driftAction,
  );
  process.stdout.write(`${JSON.stringify({ v1 }, null, 2)}\n`);
  if (
    v1.workflowError !== undefined ||
    record(v1.initialize?.result).protocolVersion !== 1
  ) {
    process.exitCode = 1;
  }
} else {
  const v1 = await runHandshake(1, undefined, true);
  const v1SessionId = record(record(v1.sessionNew).result).sessionId;
  const v2 = await runHandshake(
    2,
    typeof v1SessionId === "string" ? v1SessionId : undefined,
  );
  process.stdout.write(`${JSON.stringify({ v1, v2 }, null, 2)}\n`);

  if (
    v1.workflowError !== undefined ||
    v2.workflowError !== undefined ||
    record(v1.initialize?.result).protocolVersion !== 1
  ) {
    process.exitCode = 1;
  }
}
