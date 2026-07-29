import type { ScenarioEvidence } from "../../model.ts";
import type { ProbeScenario } from "../scenario-execution/scenario.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const assertions = (evidence: ScenarioEvidence) => {
  let output: Record<string, unknown> = {};
  try {
    output = record(JSON.parse(evidence.result.stdout));
  } catch {
    output = {};
  }
  const v1 = record(output.v1);
  const v2 = record(output.v2);
  const v1Session = record(record(v1.sessionNew).result);
  const v2Resume = record(v2.sessionResume);
  const negotiatedV2 = v2.negotiatedProtocolVersion;
  return [
    {
      id: "opencode.acp-probe-succeeded",
      passed: evidence.result.exitCode === 0,
      expected: 0,
      actual: evidence.result.exitCode,
    },
    {
      id: "opencode.acp-v1-negotiated",
      passed: v1.negotiatedProtocolVersion === 1,
      expected: 1,
      actual: v1.negotiatedProtocolVersion,
    },
    {
      id: "opencode.acp-v1-created-session",
      passed: typeof v1Session.sessionId === "string",
      expected: "opaque session id",
      actual: v1Session.sessionId,
    },
    {
      id: "opencode.acp-v1-prompt-completed",
      passed:
        record(v1.promptResponse).error === undefined &&
        String(v1.promptText).trim() === "runtime-profile-acp-ok",
      expected: "runtime-profile-acp-ok",
      actual: {
        promptText: v1.promptText,
        response: v1.promptResponse,
      },
    },
    {
      id: "opencode.acp-v2-request-returned-supported-version",
      passed: negotiatedV2 === 1 || negotiatedV2 === 2,
      expected: "1 or 2",
      actual: negotiatedV2,
    },
    {
      id: "opencode.acp-session-resumed-across-processes",
      passed: v2Resume.result !== undefined && v2Resume.error === undefined,
      expected: "successful session/resume",
      actual: v2Resume.error ?? v2Resume.result,
    },
  ];
};

export const acpCompatibilityScenarios = (
  opencodeExecutable: string,
  probeExecutable: string,
): readonly ProbeScenario[] => [
  {
    id: "opencode-acp-v1-v2-handshake",
    provider: "opencode",
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [probeExecutable, opencodeExecutable, sandbox.workspace],
      cwd: sandbox.workspace,
      timeoutMs: 100_000,
    }),
    assertions,
  },
];
