import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  mergeProbeAnomalies,
  ProbeEvidence,
  type ProbeAnomaly,
  type SafeCallbackEvidence,
  type SafeStderrEvidence,
} from "./opencode-acp-probe-evidence.ts";
import {
  terminateBoundedProcess,
  type ProcessResult,
} from "./opencode-acp-probe-lifecycle.ts";
import type { RetainedWorkflow } from "./opencode-acp-probe-workflow.ts";
import { runIsolatedSdkWorkflow } from "./opencode-acp-probe-sdk-isolation.ts";

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
const WORKFLOW_DEADLINE_MS = 90_000;

interface HandshakeSummary extends RetainedWorkflow {
  readonly requestedProtocolVersion: 1 | 2;
  readonly negotiatedProtocolVersion?: number;
  readonly promptText?: "runtime-profile-acp-ok";
  readonly protocolAnomalies: readonly ProbeAnomaly[];
  readonly process: ProcessResult & {
    readonly stderr: ReturnType<ProbeEvidence["stderr"]>;
  };
  readonly closureOutcome: "closed" | "closure_timeout";
  readonly sdkDiagnostics: {
    readonly stdout: SafeStderrEvidence;
    readonly stderr: SafeStderrEvidence;
  };
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
  let sdkResult;
  try {
    sdkResult = await runIsolatedSdkWorkflow({
      fromAgent,
      toAgent,
      evidence,
      requestedProtocolVersion: input.requestedProtocolVersion,
      workspace,
      executePrompt: input.executePrompt ?? false,
      configDriftAction: input.configDriftAction ?? "mutate",
      deadlineAt: Date.now() + WORKFLOW_DEADLINE_MS,
      timeoutMs: WORKFLOW_DEADLINE_MS + 2_000,
      ...(input.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: input.resumeSessionId }),
      ...(input.configPathToMutate === undefined
        ? {}
        : { configPathToMutate: input.configPathToMutate }),
    });
  } catch (error) {
    evidence.anomaly("evidence_value_rejected", "sdk_worker_failure", error);
    const emptyDiagnostics = evidence.boundedBytes(
      "sdk_diagnostics_unavailable",
      new Uint8Array(),
      0,
      false,
    );
    sdkResult = {
      workflow: {
        workflowError: evidence.error("workflow_failed", "sdk_worker", error),
      },
      closureOutcome: "closure_timeout" as const,
      anomalies: [],
      callbacks: [],
      diagnostics: { stdout: emptyDiagnostics, stderr: emptyDiagnostics },
      diagnosticAnomalies: [],
    };
  } finally {
    child.stdin.end();
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
  const promptMarkerMatched = sdkResult.callbacks.some(
    (callback) => callback.kind === "prompt_marker" && callback.promptMarkerMatched,
  );
  return {
    requestedProtocolVersion: input.requestedProtocolVersion,
    ...sdkResult.workflow,
    ...(sdkResult.workflow.initialize?.result.protocolVersion === undefined
      ? {}
      : {
          negotiatedProtocolVersion:
            sdkResult.workflow.initialize.result.protocolVersion,
        }),
    ...(promptMarkerMatched ? { promptText: "runtime-profile-acp-ok" as const } : {}),
    protocolAnomalies: mergeProbeAnomalies(
      sdkResult.anomalies,
      sdkResult.diagnosticAnomalies,
      evidence.anomalies,
    ),
    process: { ...processResult, stderr },
    closureOutcome: sdkResult.closureOutcome,
    sdkDiagnostics: sdkResult.diagnostics,
    availableCommandsBySession: commandIndex(sdkResult.callbacks),
    retainedCallbacks: sdkResult.callbacks,
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
