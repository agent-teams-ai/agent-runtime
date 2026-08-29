import { unlink, writeFile } from "node:fs/promises";

import { methods, type ClientConnection } from "@agentclientprotocol/sdk";

import {
  ProbeEvidence,
  type SafeErrorEvidence,
  type SafeSdkResult,
} from "./opencode-acp-probe-evidence.ts";

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export interface RetainedWorkflow {
  readonly initialize?: SafeSdkResult;
  readonly sessionNew?: SafeSdkResult;
  readonly sessionList?: SafeSdkResult;
  readonly sessionClose?: SafeSdkResult;
  readonly sessionResume?: SafeSdkResult;
  readonly resumedSessionClose?: SafeSdkResult;
  readonly promptResponse?: SafeSdkResult;
  readonly sessionNewAfterDrift?: SafeSdkResult;
  readonly sessionCloseAfterDrift?: SafeSdkResult;
  readonly workflowError?: SafeErrorEvidence;
}

interface RequestResult<Result> {
  readonly value: Result;
  readonly retained: SafeSdkResult;
}

class ProbeRequestFailure extends Error {
  readonly evidence: SafeErrorEvidence;

  constructor(evidence: SafeErrorEvidence) {
    super(evidence.code);
    this.evidence = evidence;
  }
}

export const requestWithDeadline = async <Result>(input: {
  readonly method: string;
  readonly invoke: () => Promise<Result>;
  readonly timeoutMs: number;
  readonly evidence: ProbeEvidence;
}): Promise<RequestResult<Result>> => {
  let timedOut = false;
  const request = input.invoke();
  void request.then(
    () => {
      if (timedOut) {
        input.evidence.anomaly("late_request_resolved_after_timeout", input.method);
      }
      return null;
    },
    (error: unknown) => {
      if (timedOut) {
        input.evidence.anomaly(
          "late_request_rejected_after_timeout",
          input.method,
          error,
        );
      }
      return null;
    },
  );
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timedOut = true;
    input.evidence.anomaly("request_timeout_ambiguity", input.method);
    timeout.reject(
      new ProbeRequestFailure(
        input.evidence.error("request_timeout_ambiguity", input.method),
      ),
    );
  }, input.timeoutMs);
  try {
    const value = await Promise.race([request, timeout.promise]);
    const retained = input.evidence.sdkResult(input.method, value);
    if (retained === undefined) {
      throw new ProbeRequestFailure(
        input.evidence.error("workflow_failed", input.method),
      );
    }
    return { value, retained };
  } catch (error) {
    if (error instanceof ProbeRequestFailure) {
      throw error;
    }
    input.evidence.anomaly("request_rejected", input.method, error);
    throw new ProbeRequestFailure(
      input.evidence.error("request_rejected", input.method, error),
    );
  } finally {
    clearTimeout(timer);
  }
};

const sessionIdOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const sessionId = (value as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
};

const mutateConfig = async (path: string, action: string): Promise<void> => {
  await delay(150);
  if (action === "delete") {
    await unlink(path);
    return;
  }
  await writeFile(
    path,
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
};

type Request = <Result>(
  method: string,
  invoke: () => Promise<Result>,
  timeoutMs?: number,
) => Promise<RequestResult<Result>>;

export const executeProbeWorkflow = async (input: {
  readonly connection: ClientConnection;
  readonly evidence: ProbeEvidence;
  readonly requestedProtocolVersion: 1 | 2;
  readonly workspace: string;
  readonly resumeSessionId?: string;
  readonly executePrompt: boolean;
  readonly configPathToMutate?: string;
  readonly configDriftAction: string;
  readonly deadlineAt: number;
}): Promise<RetainedWorkflow> => {
  const retained: { -readonly [Key in keyof RetainedWorkflow]?: RetainedWorkflow[Key] } = {};
  const request: Request = async (method, invoke, timeoutMs = 15_000) =>
    requestWithDeadline({
      method,
      invoke,
      timeoutMs: Math.max(1, Math.min(timeoutMs, input.deadlineAt - Date.now())),
      evidence: input.evidence,
    });
  try {
    const initialized = await request("initialize", () =>
      input.connection.agent.request(methods.agent.initialize, {
        protocolVersion: input.requestedProtocolVersion,
        clientCapabilities: {},
        clientInfo: {
          name: "agent-runtime-profile-spike",
          title: "Agent Runtime Profile Spike",
          version: "0.0.0",
        },
      }),
    );
    retained.initialize = initialized.retained;
    const protocolVersion = (initialized.value as { protocolVersion?: unknown }).protocolVersion;
    if (protocolVersion !== 1) {
      throw new ProbeRequestFailure(input.evidence.error("workflow_failed", "initialize"));
    }
    if (input.resumeSessionId !== undefined) {
      retained.sessionResume = (
        await request("session/resume", () =>
          input.connection.agent.request(methods.agent.session.resume, {
            sessionId: input.resumeSessionId,
            cwd: input.workspace,
            mcpServers: [],
          }),
        )
      ).retained;
      retained.resumedSessionClose = (
        await request("session/close", () =>
          input.connection.agent.request(methods.agent.session.close, {
            sessionId: input.resumeSessionId,
          }),
        )
      ).retained;
    }
    const sessionNew = await request("session/new", () =>
      input.connection.agent.request(methods.agent.session.new, {
        cwd: input.workspace,
        mcpServers: [],
      }),
    );
    retained.sessionNew = sessionNew.retained;
    const sessionId = sessionIdOf(sessionNew.value);
    if (input.executePrompt && sessionId !== undefined) {
      retained.promptResponse = (
        await request(
          "session/prompt",
          () =>
            input.connection.agent.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: "Reply with exactly runtime-profile-acp-ok. Do not use tools.",
                },
              ],
            }),
          60_000,
        )
      ).retained;
    }
    if (input.configPathToMutate !== undefined) {
      await mutateConfig(input.configPathToMutate, input.configDriftAction);
      const driftSession = await request("session/new", () =>
        input.connection.agent.request(methods.agent.session.new, {
          cwd: input.workspace,
          mcpServers: [],
        }),
      );
      retained.sessionNewAfterDrift = driftSession.retained;
      await delay(150);
      const driftSessionId = sessionIdOf(driftSession.value);
      if (driftSessionId !== undefined) {
        retained.sessionCloseAfterDrift = (
          await request("session/close", () =>
            input.connection.agent.request(methods.agent.session.close, {
              sessionId: driftSessionId,
            }),
          )
        ).retained;
      }
    }
    retained.sessionList = (
      await request("session/list", () =>
        input.connection.agent.request(methods.agent.session.list, { cwd: input.workspace }),
      )
    ).retained;
    if (sessionId !== undefined) {
      retained.sessionClose = (
        await request("session/close", () =>
          input.connection.agent.request(methods.agent.session.close, { sessionId }),
        )
      ).retained;
    }
  } catch (error) {
    retained.workflowError =
      error instanceof ProbeRequestFailure
        ? error.evidence
        : input.evidence.error("workflow_failed", "workflow", error);
  }
  return retained;
};
