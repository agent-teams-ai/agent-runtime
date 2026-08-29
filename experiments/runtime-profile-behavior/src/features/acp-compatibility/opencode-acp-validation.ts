import {
  AcpWireProtocolError,
  parseInitializeResult,
  type AcpInitializeResult,
} from "./acp-wire.ts";

export const OPENCODE_ACP_REQUEST_TIMEOUT_ENV = "AR_OPENCODE_ACP_REQUEST_TIMEOUT_MS";
export const OPENCODE_ACP_REQUEST_TIMEOUT_DEFAULT_MS = 15_000;
export const OPENCODE_ACP_REQUEST_TIMEOUT_MIN_MS = 1_000;
export const OPENCODE_ACP_REQUEST_TIMEOUT_MAX_MS = 120_000;

export const readOpenCodeAcpRequestTimeoutMs = (
  environment: Readonly<Record<string, string | undefined>>,
): number => {
  const raw = environment[OPENCODE_ACP_REQUEST_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return OPENCODE_ACP_REQUEST_TIMEOUT_DEFAULT_MS;
  if (!/^[0-9]+$/.test(raw)) {
    throw new RangeError(`${OPENCODE_ACP_REQUEST_TIMEOUT_ENV} must be an integer`);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < OPENCODE_ACP_REQUEST_TIMEOUT_MIN_MS ||
    value > OPENCODE_ACP_REQUEST_TIMEOUT_MAX_MS
  ) {
    throw new RangeError(
      `${OPENCODE_ACP_REQUEST_TIMEOUT_ENV} must be between ${OPENCODE_ACP_REQUEST_TIMEOUT_MIN_MS} and ${OPENCODE_ACP_REQUEST_TIMEOUT_MAX_MS}`,
    );
  }
  return value;
};

export interface OpenCodeCapabilityResult {
  readonly protocolVersion: 1;
  readonly session: Readonly<Record<"new" | "list" | "resume" | "close", boolean>>;
  readonly unknown: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateOpenCodeInitialize = (value: unknown): AcpInitializeResult =>
  parseInitializeResult(value, [1]);

export const mapOpenCodeCapabilities = (value: unknown): OpenCodeCapabilityResult => {
  const initialized = validateOpenCodeInitialize(value);
  const session = isRecord(initialized.capabilities.session)
    ? initialized.capabilities.session
    : {};
  const known = new Set(["new", "list", "resume", "close"]);
  return {
    protocolVersion: 1,
    session: {
      new: session.new === true,
      list: session.list === true,
      resume: session.resume === true,
      close: session.close === true,
    },
    unknown: Object.keys(session).filter((name) => !known.has(name)).sort(),
  };
};

export type OpenCodeCallbackDisposition =
  | { readonly kind: "permission"; readonly autoApproved: false }
  | { readonly kind: "tool"; readonly autoApproved: false }
  | { readonly kind: "unsupported"; readonly method: string };

export const classifyOpenCodeCallback = (method: string): OpenCodeCallbackDisposition => {
  if (method === "session/request_permission") return { kind: "permission", autoApproved: false };
  return { kind: "unsupported", method };
};

export const classifyOpenCodeNotification = (
  method: string,
  params: unknown,
): OpenCodeCallbackDisposition => {
  if (
    method === "session/update" &&
    isRecord(params) &&
    isRecord(params.update) &&
    params.update.sessionUpdate === "tool_call"
  ) {
    return { kind: "tool", autoApproved: false };
  }
  return { kind: "unsupported", method };
};

export type OpenCodeCancellationObservation =
  | "cancelled_before_acceptance"
  | "completed_before_cancel"
  | "ambiguous_requires_reconciliation";

export const classifyOpenCodeCancellation = (trace: {
  readonly cancelResponse?: unknown;
  readonly providerAccepted: boolean | "unknown";
  readonly terminalUpdate?: string;
}): OpenCodeCancellationObservation => {
  if (trace.providerAccepted === false) return "cancelled_before_acceptance";
  if (trace.terminalUpdate === "end_turn") return "completed_before_cancel";
  return "ambiguous_requires_reconciliation";
};

export const requireSupportedOpenCodeCapability = (
  capabilities: OpenCodeCapabilityResult,
  capability: keyof OpenCodeCapabilityResult["session"],
): void => {
  if (!capabilities.session[capability]) {
    throw new AcpWireProtocolError("unsupported_protocol", `OpenCode ACP capability is unsupported: session/${capability}`, {
      capability,
    });
  }
};
