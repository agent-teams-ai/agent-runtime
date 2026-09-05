import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ClientConnection } from "@agentclientprotocol/sdk";

import { ProbeEvidence } from "./opencode-acp-probe-evidence.ts";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: "exited" | "sigterm" | "sigkill" | "unconfirmed_after_sigkill";
}

export const awaitBoundedConnectionClose = async (input: {
  readonly connection: Pick<ClientConnection, "close" | "closed">;
  readonly timeoutMs: number;
  readonly evidence: ProbeEvidence;
}): Promise<"closed" | "closure_timeout" | "closure_failed"> => {
  const timeout = Promise.withResolvers<"closure_timeout">();
  const timer = setTimeout(() => timeout.resolve("closure_timeout"), input.timeoutMs);
  try {
    // Observe rejection before calling close, including when close itself throws.
    const closed = input.connection.closed.then(
      () => "closed" as const,
      (error: unknown) => {
        input.evidence.anomaly("closure_failed", "sdk_connection", error);
        return "closure_failed" as const;
      },
    );
    input.connection.close();
    const result = await Promise.race([closed, timeout.promise]);
    if (result === "closure_timeout") {
      input.evidence.anomaly("closure_timeout", "sdk_connection");
    }
    return result;
  } catch (error) {
    input.evidence.anomaly("closure_failed", "sdk_connection", error);
    return "closure_failed";
  } finally {
    clearTimeout(timer);
  }
};

const exited = async (
  exit: Promise<Omit<ProcessResult, "termination">>,
  timeoutMs: number,
): Promise<
  | { readonly timedOut: false; readonly result: Omit<ProcessResult, "termination"> }
  | { readonly timedOut: true }
> => {
  const timeout = Promise.withResolvers<{ readonly timedOut: true }>();
  const timer = setTimeout(() => timeout.resolve({ timedOut: true }), timeoutMs);
  const result = await Promise.race([
    exit.then((value) => ({ timedOut: false as const, result: value })),
    timeout.promise,
  ]);
  clearTimeout(timer);
  return result;
};

export const terminateBoundedProcess = async (input: {
  readonly child: Pick<
    ChildProcessWithoutNullStreams,
    "kill" | "stdin" | "stdout" | "stderr" | "unref"
  >;
  readonly exit: Promise<Omit<ProcessResult, "termination">>;
  readonly gracefulMs: number;
  readonly sigtermMs: number;
  readonly sigkillMs: number;
  readonly evidence: ProbeEvidence;
}): Promise<ProcessResult> => {
  const graceful = await exited(input.exit, input.gracefulMs);
  if (!graceful.timedOut) {
    return { ...graceful.result, termination: "exited" };
  }
  input.child.kill("SIGTERM");
  const afterTerm = await exited(input.exit, input.sigtermMs);
  if (!afterTerm.timedOut) {
    return { ...afterTerm.result, termination: "sigterm" };
  }
  input.child.kill("SIGKILL");
  const afterKill = await exited(input.exit, input.sigkillMs);
  if (!afterKill.timedOut) {
    return { ...afterKill.result, termination: "sigkill" };
  }
  input.evidence.anomaly("termination_unconfirmed", "process");
  input.child.stdin.destroy();
  input.child.stdout.destroy();
  input.child.stderr.destroy();
  input.child.unref();
  return {
    exitCode: null,
    signal: "SIGKILL",
    termination: "unconfirmed_after_sigkill",
  };
};
