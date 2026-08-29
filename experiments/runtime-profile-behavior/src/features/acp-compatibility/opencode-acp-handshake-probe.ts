import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import {
  ClientApp,
  methods,
  ndJsonStream,
  type ClientConnection,
} from "@agentclientprotocol/sdk";

const executable = process.argv[2];
const workspace = process.argv[3];
const driftConfigPath = process.argv[4];
const driftAction = process.argv[5] ?? "mutate";
if (executable === undefined || workspace === undefined) {
  throw new Error("Expected OpenCode executable and workspace");
}

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_MESSAGES = 512;
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_ANOMALIES = 32;
const WORKFLOW_DEADLINE_MS = 120_000;
const GRACEFUL_EXIT_MS = 2_000;
const SIGTERM_EXIT_MS = 1_000;
const SIGKILL_EXIT_MS = 1_000;

type JsonRpcMessage = {
  readonly jsonrpc?: "2.0";
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

type ProcessResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: "exited" | "sigterm" | "sigkill" | "unconfirmed_after_sigkill";
};

type TypedRequest = <Result>(
  method: string,
  invoke: () => Promise<Result>,
  timeoutMs?: number,
) => Promise<JsonRpcMessage>;

type WorkflowResult = {
  readonly initialize: JsonRpcMessage | undefined;
  readonly sessionNew: JsonRpcMessage | undefined;
  readonly sessionList: JsonRpcMessage | undefined;
  readonly sessionClose: JsonRpcMessage | undefined;
  readonly sessionResume: JsonRpcMessage | undefined;
  readonly resumedSessionClose: JsonRpcMessage | undefined;
  readonly promptResponse: JsonRpcMessage | undefined;
  readonly sessionNewAfterDrift: JsonRpcMessage | undefined;
  readonly sessionCloseAfterDrift: JsonRpcMessage | undefined;
  readonly workflowError: string | undefined;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const redacted = (value: string): string => {
  let result = value;
  for (const path of [workspace, executable, driftConfigPath]) {
    if (path !== undefined && path.length > 0) {
      result = result.split(path).join("<REDACTED_PATH>");
    }
  }
  return result
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, "$1<REDACTED>")
    .slice(0, MAX_STDERR_BYTES);
};

const errorEvidence = (error: unknown): Readonly<Record<string, unknown>> => ({
  name: error instanceof Error ? error.name.slice(0, 128) : "Error",
  message: redacted(error instanceof Error ? error.message : "Unknown ACP error").slice(0, 1_024),
});

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const executeSdkWorkflow = async (input: {
  readonly connection: ClientConnection;
  readonly typedRequest: TypedRequest;
  readonly requestedProtocolVersion: 1 | 2;
  readonly resumeSessionId: string | undefined;
  readonly executePrompt: boolean;
  readonly configPathToMutate: string | undefined;
  readonly configDriftAction: string;
}): Promise<WorkflowResult> => {
  const { connection, typedRequest } = input;
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
    initialize = await typedRequest("initialize", () =>
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: input.requestedProtocolVersion,
        clientCapabilities: {},
        clientInfo: {
          name: "agent-runtime-profile-spike",
          title: "Agent Runtime Profile Spike",
          version: "0.0.0",
        },
      }),
    );
    const negotiatedProtocolVersion = record(initialize.result).protocolVersion;
    if (negotiatedProtocolVersion === 1 || negotiatedProtocolVersion === 2) {
      if (input.resumeSessionId !== undefined) {
        sessionResume = await typedRequest("session/resume", () =>
          connection.agent.request(methods.agent.session.resume, {
            sessionId: input.resumeSessionId,
            cwd: workspace,
            mcpServers: [],
          }),
        );
        resumedSessionClose = await typedRequest("session/close", () =>
          connection.agent.request(methods.agent.session.close, {
            sessionId: input.resumeSessionId,
          }),
        );
      }
      sessionNew = await typedRequest("session/new", () =>
        connection.agent.request(methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [],
        }),
      );
      const sessionId = record(sessionNew.result).sessionId;
      if (input.executePrompt && typeof sessionId === "string") {
        promptResponse = await typedRequest(
          "session/prompt",
          () =>
            connection.agent.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: "Reply with exactly runtime-profile-acp-ok. Do not use tools.",
                },
              ],
            }),
          60_000,
        );
      }
      if (input.configPathToMutate !== undefined) {
        await delay(150);
        if (input.configDriftAction === "delete") {
          await unlink(input.configPathToMutate);
        } else {
          await writeFile(
            input.configPathToMutate,
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
        sessionNewAfterDrift = await typedRequest("session/new", () =>
          connection.agent.request(methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [],
          }),
        );
        await delay(150);
        const driftSessionId = record(sessionNewAfterDrift.result).sessionId;
        if (typeof driftSessionId === "string") {
          sessionCloseAfterDrift = await typedRequest("session/close", () =>
            connection.agent.request(methods.agent.session.close, {
              sessionId: driftSessionId,
            }),
          );
        }
      }
      sessionList = await typedRequest("session/list", () =>
        connection.agent.request(methods.agent.session.list, { cwd: workspace }),
      );
      if (typeof sessionId === "string") {
        sessionClose = await typedRequest("session/close", () =>
          connection.agent.request(methods.agent.session.close, { sessionId }),
        );
      }
    }
  } catch (error) {
    workflowError = redacted(
      error instanceof Error ? error.message : "Unknown ACP workflow error",
    ).slice(0, 1_024);
  }
  return {
    initialize,
    sessionNew,
    sessionList,
    sessionClose,
    sessionResume,
    resumedSessionClose,
    promptResponse,
    sessionNewAfterDrift,
    sessionCloseAfterDrift,
    workflowError,
  };
};

const summarizeHandshake = (input: {
  requestedProtocolVersion: 1 | 2;
  initialize: JsonRpcMessage | undefined;
  sessionNew: JsonRpcMessage | undefined;
  sessionList: JsonRpcMessage | undefined;
  sessionClose: JsonRpcMessage | undefined;
  sessionResume: JsonRpcMessage | undefined;
  resumedSessionClose: JsonRpcMessage | undefined;
  promptResponse: JsonRpcMessage | undefined;
  sessionNewAfterDrift: JsonRpcMessage | undefined;
  sessionCloseAfterDrift: JsonRpcMessage | undefined;
  messages: readonly JsonRpcMessage[];
  protocolAnomalies: readonly string[];
  workflowError: string | undefined;
  processResult: ProcessResult;
  stderr: string;
}) => ({
  requestedProtocolVersion: input.requestedProtocolVersion,
  initialize: input.initialize,
  negotiatedProtocolVersion: record(input.initialize?.result).protocolVersion,
  sessionNew: input.sessionNew,
  sessionList: input.sessionList,
  sessionClose: input.sessionClose,
  sessionResume: input.sessionResume,
  resumedSessionClose: input.resumedSessionClose,
  promptResponse: input.promptResponse,
  sessionNewAfterDrift: input.sessionNewAfterDrift,
  sessionCloseAfterDrift: input.sessionCloseAfterDrift,
  promptText: input.messages
    .map((message) => record(record(message.params).update))
    .filter(
      (update) =>
        update.sessionUpdate === "agent_message_chunk" &&
        record(update.content).type === "text",
    )
    .map((update) => record(update.content).text)
    .filter((text): text is string => typeof text === "string")
    .join("")
    .slice(0, MAX_MESSAGE_BYTES),
  workflowError: input.workflowError,
  protocolAnomalies: input.protocolAnomalies,
  process: {
    ...input.processResult,
    stderr: input.stderr,
  },
  unsolicitedMethods: input.messages
    .filter((message) => message.method !== undefined && message.id === undefined)
    .map((message) => message.method),
  unsolicitedNotifications: input.messages
    .filter((message) => message.method !== undefined && message.id === undefined)
    .map(({ method, params }) => ({ method, params })),
  clientRequests: input.messages
    .filter((message) => message.method !== undefined && message.id !== undefined)
    .map(({ method, params }) => ({ method, params })),
  availableCommandsBySession: Object.fromEntries(
    input.messages
      .map((message) => record(message.params))
      .filter(
        (params) =>
          record(params.update).sessionUpdate === "available_commands_update",
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
});

const runHandshake = async (
  requestedProtocolVersion: 1 | 2,
  resumeSessionId?: string,
  executePrompt = false,
  configPathToMutate?: string,
  configDriftAction = "mutate",
) => {
  const child = spawn(executable, ["acp", "--pure", "--cwd", workspace], {
    cwd: workspace,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: JsonRpcMessage[] = [];
  const protocolAnomalies: string[] = [];
  const timedOutRequestIds = new Set<number>();
  let retainedMessageBytes = 0;
  let nextId = 1;
  let stdoutBytes = 0;
  let stdoutLineBytes = 0;
  let stderrBytes = 0;
  let stderrTruncated = false;
  const stderrChunks: Uint8Array[] = [];
  const deadlineAt = Date.now() + WORKFLOW_DEADLINE_MS;

  const retainAnomaly = (classification: string): void => {
    if (protocolAnomalies.length < MAX_ANOMALIES) {
      protocolAnomalies.push(classification);
    }
  };
  const retainMessage = (message: JsonRpcMessage): void => {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (
      messages.length >= MAX_MESSAGES ||
      retainedMessageBytes + bytes > MAX_MESSAGE_BYTES
    ) {
      retainAnomaly("message_evidence_limit_exceeded");
      return;
    }
    retainedMessageBytes += bytes;
    messages.push(message);
  };

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_STDERR_BYTES) {
      stderrTruncated = true;
      return;
    }
    const retained = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
    stderrChunks.push(retained);
    stderrBytes += retained.byteLength;
    stderrTruncated ||= retained.byteLength < chunk.byteLength;
  });

  const exit = Promise.withResolvers<Omit<ProcessResult, "termination">>();
  child.once("error", () => exit.resolve({ exitCode: null, signal: null }));
  child.once("close", (exitCode, signal) => exit.resolve({ exitCode, signal }));

  const boundedStdout = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        retainAnomaly("stdout_byte_limit_exceeded");
        throw new Error("OpenCode ACP stdout byte limit exceeded");
      }
      for (const byte of chunk) {
        if (byte === 0x0a) {
          stdoutLineBytes = 0;
        } else {
          stdoutLineBytes += 1;
          if (stdoutLineBytes > MAX_STDOUT_LINE_BYTES) {
            retainAnomaly("stdout_line_limit_exceeded");
            throw new Error("OpenCode ACP stdout line limit exceeded");
          }
        }
      }
      controller.enqueue(chunk);
    },
  });
  const fromAgent = (
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  ).pipeThrough(boundedStdout);
  const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;

  const app = new ClientApp({ name: "agent-runtime-opencode-characterization" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      retainMessage({
        jsonrpc: "2.0",
        id: "sdk-client-request",
        method: methods.client.session.requestPermission,
        params,
      });
      return { outcome: { outcome: "cancelled" } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      retainMessage({
        jsonrpc: "2.0",
        method: methods.client.session.update,
        params,
      });
    });
  const connection: ClientConnection = app.connect(ndJsonStream(toAgent, fromAgent));

  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (args[0] === "Got response to unknown request") {
      const id = typeof args[1] === "number" ? args[1] : -1;
      retainAnomaly(
        timedOutRequestIds.has(id)
          ? "late_response_after_request_deadline"
          : "duplicate_response_or_unknown_request_id",
      );
      return;
    }
    originalConsoleError(...args);
  };

  const typedRequest = async <Result>(
    method: string,
    invoke: () => Promise<Result>,
    timeoutMs = 15_000,
  ): Promise<JsonRpcMessage> => {
    const id = nextId;
    nextId += 1;
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    const effectiveTimeoutMs = Math.min(timeoutMs, remainingMs);
    let timedOut = false;
    const operation = invoke();
    void operation
      .then(() => {
        if (timedOut) {
          retainAnomaly("late_response_after_request_deadline");
        }
        return null;
      })
      .catch(() => null);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            timedOutRequestIds.add(id);
            reject(new Error(`ACP request deadline exceeded: ${method}`));
          }, effectiveTimeoutMs);
        }),
      ]);
      const message = { jsonrpc: "2.0" as const, id, result };
      retainMessage(message);
      return message;
    } catch (error) {
      if (timedOut) {
        throw error;
      }
      const message = { jsonrpc: "2.0" as const, id, error: errorEvidence(error) };
      retainMessage(message);
      return message;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  let workflow: WorkflowResult;
  try {
    workflow = await executeSdkWorkflow({
      connection,
      typedRequest,
      requestedProtocolVersion,
      resumeSessionId,
      executePrompt,
      configPathToMutate,
      configDriftAction,
    });
  } finally {
    connection.close();
    child.stdin.end();
    await Promise.race([
      connection.closed,
      delay(1_000),
    ]);
    console.error = originalConsoleError;
  }

  const exited = async (timeoutMs: number) =>
    Promise.race([
      exit.promise.then((result) => ({ result, timedOut: false as const })),
      new Promise<{ readonly timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  let processResult: ProcessResult;
  const graceful = await exited(GRACEFUL_EXIT_MS);
  if (!graceful.timedOut) {
    processResult = { ...graceful.result, termination: "exited" };
  } else {
    child.kill("SIGTERM");
    const afterTerm = await exited(SIGTERM_EXIT_MS);
    if (!afterTerm.timedOut) {
      processResult = { ...afterTerm.result, termination: "sigterm" };
    } else {
      child.kill("SIGKILL");
      const afterKill = await exited(SIGKILL_EXIT_MS);
      processResult = afterKill.timedOut
        ? {
            exitCode: null,
            signal: "SIGKILL",
            termination: "unconfirmed_after_sigkill",
          }
        : { ...afterKill.result, termination: "sigkill" };
    }
  }

  const stderr = redacted(
    `${Buffer.concat(stderrChunks).toString("utf8")}${
      stderrTruncated ? "\n<STDERR_TRUNCATED>" : ""
    }`,
  );
  const failClosedWorkflow: WorkflowResult = {
    ...workflow,
    workflowError:
      workflow.workflowError ??
      (processResult.termination === "unconfirmed_after_sigkill"
        ? "OpenCode process termination remained unconfirmed after SIGKILL"
        : undefined),
  };
  return summarizeHandshake({
    requestedProtocolVersion,
    ...failClosedWorkflow,
    messages,
    protocolAnomalies,
    processResult,
    stderr,
  });
};

if (driftConfigPath !== undefined) {
  const v1 = await runHandshake(1, undefined, false, driftConfigPath, driftAction);
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
