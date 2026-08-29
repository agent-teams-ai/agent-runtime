import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientApp,
  methods,
  ndJsonStream,
  type ClientConnection,
} from "@agentclientprotocol/sdk";

import {
  ProbeEvidence,
  type SafeCallbackEvidence,
} from "./opencode-acp-probe-evidence.ts";
import {
  awaitBoundedConnectionClose,
  terminateBoundedProcess,
  type ProcessResult,
} from "./opencode-acp-probe-lifecycle.ts";
import {
  executeProbeWorkflow,
  type RetainedWorkflow,
} from "./opencode-acp-probe-workflow.ts";

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
const WORKFLOW_DEADLINE_MS = 120_000;

interface HandshakeSummary extends RetainedWorkflow {
  readonly requestedProtocolVersion: 1 | 2;
  readonly negotiatedProtocolVersion?: number;
  readonly promptText?: "runtime-profile-acp-ok";
  readonly protocolAnomalies: ProbeEvidence["anomalies"];
  readonly process: ProcessResult & {
    readonly stderr: ReturnType<ProbeEvidence["stderr"]>;
  };
  readonly closureOutcome: "closed" | "closure_timeout";
  readonly availableCommandsBySession: Readonly<Record<string, readonly string[]>>;
  readonly retainedCallbacks: readonly SafeCallbackEvidence[];
}

const createBoundedAgentStream = (input: {
  readonly stdout: Readable;
  readonly evidence: ProbeEvidence;
}): ReadableStream<Uint8Array> => {
  let stdoutBytes = 0;
  let lineBytes = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        input.evidence.anomaly("stdout_byte_limit_exceeded", "stdout");
        throw new Error("Bounded ACP stdout byte limit exceeded");
      }
      for (const byte of chunk) {
        if (byte === 0x0a) {
          lineBytes = 0;
        } else if (++lineBytes > MAX_STDOUT_LINE_BYTES) {
          input.evidence.anomaly("stdout_line_limit_exceeded", "stdout");
          throw new Error("Bounded ACP stdout line limit exceeded");
        }
      }
      controller.enqueue(chunk);
    },
  });
  return (Readable.toWeb(input.stdout) as ReadableStream<Uint8Array>).pipeThrough(
    bounded,
  );
};

const createClient = (input: {
  readonly evidence: ProbeEvidence;
}): ClientApp => {
  return new ClientApp({ name: "agent-runtime-opencode-characterization" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      input.evidence.callback("permission", params);
      return { outcome: { outcome: "cancelled" } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update =
        typeof params.update === "object" && params.update !== null
          ? (params.update as Record<string, unknown>)
          : {};
      if (update.sessionUpdate === "available_commands_update") {
        input.evidence.callback("available_commands", params);
      } else if (update.sessionUpdate === "agent_message_chunk") {
        input.evidence.callback("prompt_marker", params);
      } else if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      ) {
        input.evidence.callback("tool_update", params);
      }
    });
};

const commandIndex = (
  callbacks: readonly SafeCallbackEvidence[],
): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(
    callbacks
      .filter(
        (callback): callback is SafeCallbackEvidence & { readonly commandNames: string[] } =>
          callback.kind === "available_commands" && callback.commandNames !== undefined,
      )
      .map((callback) => [callback.sessionId, callback.commandNames]),
  );

const runHandshake = async (input: {
  readonly requestedProtocolVersion: 1 | 2;
  readonly resumeSessionId?: string;
  readonly executePrompt?: boolean;
  readonly configPathToMutate?: string;
  readonly configDriftAction?: string;
}): Promise<HandshakeSummary> => {
  const evidence = new ProbeEvidence();
  const child = spawn(executable, ["acp", "--pure", "--cwd", workspace], {
    cwd: workspace,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrObserved = 0;
  let stderrTruncated = false;
  const stderrChunks: Uint8Array[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrObserved += chunk.byteLength;
    const retainedBytes = stderrChunks.reduce((total, value) => total + value.byteLength, 0);
    const remaining = MAX_STDERR_BYTES - retainedBytes;
    if (remaining > 0) {
      stderrChunks.push(chunk.subarray(0, remaining));
    }
    stderrTruncated ||= chunk.byteLength > remaining;
  });
  const exited = Promise.withResolvers<Omit<ProcessResult, "termination">>();
  child.once("error", () => exited.resolve({ exitCode: null, signal: null }));
  child.once("close", (exitCode, signal) => exited.resolve({ exitCode, signal }));

  const fromAgent = createBoundedAgentStream({ stdout: child.stdout, evidence });
  const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const connection: ClientConnection = createClient({ evidence }).connect(
    ndJsonStream(toAgent, fromAgent),
  );
  let workflow: RetainedWorkflow;
  let closureOutcome: "closed" | "closure_timeout";
  try {
    workflow = await executeProbeWorkflow({
      connection,
      evidence,
      requestedProtocolVersion: input.requestedProtocolVersion,
      workspace,
      executePrompt: input.executePrompt ?? false,
      configDriftAction: input.configDriftAction ?? "mutate",
      deadlineAt: Date.now() + WORKFLOW_DEADLINE_MS,
      ...(input.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: input.resumeSessionId }),
      ...(input.configPathToMutate === undefined
        ? {}
        : { configPathToMutate: input.configPathToMutate }),
    });
  } finally {
    child.stdin.end();
    closureOutcome = await awaitBoundedConnectionClose({
      connection,
      timeoutMs: 1_000,
      evidence,
    });
  }
  const processResult = await terminateBoundedProcess({
    child,
    exit: exited.promise,
    gracefulMs: 2_000,
    sigtermMs: 1_000,
    sigkillMs: 1_000,
    evidence,
  });
  const stderr = evidence.stderr(
    Buffer.concat(stderrChunks),
    stderrObserved,
    stderrTruncated,
  );
  const promptMarkerMatched = evidence.callbacks.some(
    (callback) => callback.kind === "prompt_marker" && callback.promptMarkerMatched,
  );
  return {
    requestedProtocolVersion: input.requestedProtocolVersion,
    ...workflow,
    ...(workflow.initialize?.result.protocolVersion === undefined
      ? {}
      : { negotiatedProtocolVersion: workflow.initialize.result.protocolVersion }),
    ...(promptMarkerMatched ? { promptText: "runtime-profile-acp-ok" as const } : {}),
    protocolAnomalies: evidence.anomalies,
    process: { ...processResult, stderr },
    closureOutcome,
    availableCommandsBySession: commandIndex(evidence.callbacks),
    retainedCallbacks: evidence.callbacks,
  };
};

const failed = (summary: HandshakeSummary): boolean =>
  summary.workflowError !== undefined ||
  summary.closureOutcome === "closure_timeout" ||
  summary.process.termination === "unconfirmed_after_sigkill";

if (driftConfigPath !== undefined) {
  const v1 = await runHandshake({
    requestedProtocolVersion: 1,
    configPathToMutate: driftConfigPath,
    configDriftAction: driftAction,
  });
  process.stdout.write(`${JSON.stringify({ v1 }, null, 2)}\n`);
  if (failed(v1) || v1.negotiatedProtocolVersion !== 1) {
    process.exitCode = 1;
  }
} else {
  const v1 = await runHandshake({ requestedProtocolVersion: 1, executePrompt: true });
  const v2 = await runHandshake({
    requestedProtocolVersion: 2,
    ...(v1.sessionNew?.result.sessionId === undefined
      ? {}
      : { resumeSessionId: v1.sessionNew.result.sessionId }),
  });
  process.stdout.write(`${JSON.stringify({ v1, v2 }, null, 2)}\n`);
  if (failed(v1) || failed(v2) || v1.negotiatedProtocolVersion !== 1) {
    process.exitCode = 1;
  }
}
