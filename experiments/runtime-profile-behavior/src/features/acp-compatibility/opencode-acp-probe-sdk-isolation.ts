import { Readable } from "node:stream";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

import {
  ClientApp,
  methods,
  ndJsonStream,
  type ClientConnection,
} from "@agentclientprotocol/sdk";

import {
  ProbeEvidence,
  type ProbeAnomaly,
  type SafeCallbackEvidence,
  type SafeStderrEvidence,
} from "./opencode-acp-probe-evidence.ts";
import { awaitBoundedConnectionClose } from "./opencode-acp-probe-lifecycle.ts";
import {
  executeProbeWorkflow,
  type RetainedWorkflow,
} from "./opencode-acp-probe-workflow.ts";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

interface WorkerInput {
  readonly fromAgent: ReadableStream<Uint8Array>;
  readonly toAgent: WritableStream<Uint8Array>;
  readonly requestedProtocolVersion: 1 | 2;
  readonly workspace: string;
  readonly resumeSessionId?: string;
  readonly executePrompt: boolean;
  readonly configPathToMutate?: string;
  readonly configDriftAction: string;
  readonly deadlineAt: number;
}

interface WorkerResult {
  readonly workflow: RetainedWorkflow;
  readonly closureOutcome: "closed" | "closure_timeout";
  readonly anomalies: readonly ProbeAnomaly[];
  readonly callbacks: readonly SafeCallbackEvidence[];
}

export interface IsolatedSdkResult extends WorkerResult {
  readonly diagnostics: {
    readonly stdout: SafeStderrEvidence;
    readonly stderr: SafeStderrEvidence;
  };
  readonly diagnosticAnomalies: readonly ProbeAnomaly[];
}

const createClient = (evidence: ProbeEvidence): ClientApp =>
  new ClientApp({ name: "agent-runtime-opencode-characterization" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      evidence.callback("permission", params);
      return { outcome: { outcome: "cancelled" } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update =
        typeof params.update === "object" && params.update !== null
          ? (params.update as Record<string, unknown>)
          : {};
      if (update.sessionUpdate === "available_commands_update") {
        evidence.callback("available_commands", params);
      } else if (update.sessionUpdate === "agent_message_chunk") {
        evidence.callback("prompt_marker", params);
      } else if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      ) {
        evidence.callback("tool_update", params);
      }
    });

const runWorker = async (input: WorkerInput): Promise<WorkerResult> => {
  const evidence = new ProbeEvidence();
  const connection: ClientConnection = createClient(evidence).connect(
    ndJsonStream(input.toAgent, input.fromAgent),
  );
  const workflow = await executeProbeWorkflow({
    connection,
    evidence,
    requestedProtocolVersion: input.requestedProtocolVersion,
    workspace: input.workspace,
    executePrompt: input.executePrompt,
    configDriftAction: input.configDriftAction,
    deadlineAt: input.deadlineAt,
    ...(input.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: input.resumeSessionId }),
    ...(input.configPathToMutate === undefined
      ? {}
      : { configPathToMutate: input.configPathToMutate }),
  });
  const closureOutcome = await awaitBoundedConnectionClose({
    connection,
    timeoutMs: 1_000,
    evidence,
  });
  return {
    workflow,
    closureOutcome,
    anomalies: evidence.anomalies,
    callbacks: evidence.callbacks,
  };
};

const captureDiagnostics = (
  stream: Readable,
  field: string,
  evidence: ProbeEvidence,
): Promise<SafeStderrEvidence> =>
  new Promise((resolve) => {
    let observed = 0;
    let retained = 0;
    const chunks: Uint8Array[] = [];
    stream.on("data", (chunk: Buffer) => {
      observed = Math.min(Number.MAX_SAFE_INTEGER, observed + chunk.byteLength);
      const remaining = MAX_DIAGNOSTIC_BYTES - retained;
      if (remaining > 0) {
        const safeChunk = chunk.subarray(0, remaining);
        chunks.push(safeChunk);
        retained += safeChunk.byteLength;
      }
    });
    stream.once("close", () => {
      resolve(
        evidence.boundedBytes(
          field,
          Buffer.concat(chunks),
          observed,
          observed > retained,
          "diagnostic_truncated",
        ),
      );
    });
    stream.resume();
  });

export const runIsolatedSdkWorkflow = async (
  input: WorkerInput & {
    readonly timeoutMs: number;
    readonly evidence: ProbeEvidence;
  },
): Promise<IsolatedSdkResult> => {
  const isolatedInput: WorkerInput = {
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    requestedProtocolVersion: input.requestedProtocolVersion,
    workspace: input.workspace,
    executePrompt: input.executePrompt,
    configDriftAction: input.configDriftAction,
    deadlineAt: input.deadlineAt,
    ...(input.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: input.resumeSessionId }),
    ...(input.configPathToMutate === undefined
      ? {}
      : { configPathToMutate: input.configPathToMutate }),
  };
  const worker = new Worker(new URL(import.meta.url), {
    workerData: isolatedInput,
    transferList: [input.fromAgent, input.toAgent],
    stdout: true,
    stderr: true,
  });
  const diagnosticEvidence = new ProbeEvidence();
  const stdout = captureDiagnostics(
    worker.stdout,
    "sdk_diagnostics_stdout",
    diagnosticEvidence,
  );
  const stderr = captureDiagnostics(
    worker.stderr,
    "sdk_diagnostics_stderr",
    diagnosticEvidence,
  );
  const result = Promise.withResolvers<WorkerResult>();
  let settled = false;
  worker.once("message", (message: WorkerResult) => {
    settled = true;
    result.resolve(message);
  });
  worker.once("error", (error) => {
    if (!settled) {
      settled = true;
      result.resolve({
        workflow: {
          workflowError: input.evidence.error("workflow_failed", "sdk_worker", error),
        },
        closureOutcome: "closure_timeout",
        anomalies: [],
        callbacks: [],
      });
    }
  });
  worker.once("exit", () => {
    if (!settled) {
      settled = true;
      result.resolve({
        workflow: {
          workflowError: input.evidence.error("workflow_failed", "sdk_worker_exit"),
        },
        closureOutcome: "closure_timeout",
        anomalies: [],
        callbacks: [],
      });
    }
  });
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      input.evidence.anomaly("sdk_isolation_timeout", "sdk_worker");
      result.resolve({
        workflow: {
          workflowError: input.evidence.error("workflow_failed", "sdk_worker_timeout"),
        },
        closureOutcome: "closure_timeout",
        anomalies: [],
        callbacks: [],
      });
    }
  }, input.timeoutMs);
  const retained = await result.promise;
  clearTimeout(timeout);
  await worker.terminate();
  return {
    ...retained,
    diagnostics: { stdout: await stdout, stderr: await stderr },
    diagnosticAnomalies: diagnosticEvidence.anomalies,
  };
};

if (!isMainThread) {
  const result = await runWorker(workerData as WorkerInput);
  parentPort?.postMessage(result, []);
  parentPort?.close();
}
