import { createHash } from "node:crypto";

export const MAX_EVIDENCE_ANOMALIES = 32;
export const MAX_RETAINED_CALLBACKS = 512;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_COMMANDS_PER_SESSION = 64;
const MAX_SMALL_ERROR_BYTES = 4 * 1024;

export type ProbeAnomalyCode =
  | "closure_timeout"
  | "diagnostic_truncated"
  | "evidence_anomaly_limit_exceeded"
  | "evidence_value_rejected"
  | "late_request_rejected_after_timeout"
  | "late_request_resolved_after_timeout"
  | "request_rejected"
  | "request_timeout_ambiguity"
  | "sdk_isolation_timeout"
  | "stderr_truncated"
  | "stdout_byte_limit_exceeded"
  | "stdout_line_limit_exceeded"
  | "termination_unconfirmed";

export interface ProbeAnomaly {
  readonly code: ProbeAnomalyCode;
  readonly field?: string;
  readonly digestSha256?: string;
}

export interface SafeSdkPayload {
  readonly observed: true;
  readonly protocolVersion?: number;
  readonly sessionId?: string;
  readonly stopReason?: string;
  readonly contentsRetained?: false;
}

export interface SafeSdkResult {
  readonly result: SafeSdkPayload;
}

export interface SafeCallbackEvidence {
  readonly kind: "permission" | "tool_update" | "available_commands" | "prompt_marker";
  readonly sessionId: string;
  readonly toolCallId?: string;
  readonly status?: string;
  readonly commandNames?: readonly string[];
  readonly promptMarkerMatched?: true;
}

export interface SafeErrorEvidence {
  readonly code: "request_rejected" | "request_timeout_ambiguity" | "workflow_failed";
  readonly operation: string;
  readonly digestSha256?: string;
}

export interface SafeStderrEvidence {
  readonly bytesObserved: number;
  readonly bytesRetained: 0;
  readonly digestSha256: string;
  readonly truncated: boolean;
}

const digest = (value: unknown): string => {
  const hash = createHash("sha256");
  if (value instanceof Error) {
    const name = Buffer.byteLength(value.name) <= MAX_IDENTIFIER_BYTES
      ? value.name
      : "oversized_error_name";
    const messageBytes = Buffer.byteLength(value.message);
    hash.update("error\0").update(name).update("\0");
    if (messageBytes <= MAX_SMALL_ERROR_BYTES) {
      hash.update("message\0").update(value.message);
    } else {
      hash.update(`oversized_message\0${messageBytes}`);
    }
    return hash.digest("hex");
  }
  if (typeof value === "string") {
    return hash.update("string\0").update(value).digest("hex");
  }
  if (value instanceof Uint8Array) {
    return hash.update("bytes\0").update(value).digest("hex");
  }
  const type = value === null ? "null" : typeof value;
  return hash.update(`unsupported\0${type}`).digest("hex");
};

export const mergeProbeAnomalies = (
  ...groups: readonly (readonly ProbeAnomaly[])[]
): readonly ProbeAnomaly[] => {
  const merged = groups.flat().slice(0, MAX_EVIDENCE_ANOMALIES);
  if (groups.reduce((total, group) => total + group.length, 0) > merged.length) {
    merged[MAX_EVIDENCE_ANOMALIES - 1] = {
      code: "evidence_anomaly_limit_exceeded",
    };
  }
  return merged;
};

const boundedIdentifier = (value: unknown): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_IDENTIFIER_BYTES ||
    /[\\/\n\r\0]/u.test(value)
  ) {
    return undefined;
  }
  return value;
};

const boundedField = (value: string): string =>
  value.length <= MAX_IDENTIFIER_BYTES && /^[a-z0-9_:/-]+$/u.test(value)
    ? value
    : "bounded_field";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const projectSdkResult = (method: string, value: unknown): SafeSdkPayload | undefined => {
  const result = asRecord(value);
  if (method === "initialize") {
    const protocolVersion = result.protocolVersion;
    return protocolVersion === 1 || protocolVersion === 2
      ? { observed: true, protocolVersion }
      : undefined;
  }
  if (method === "session/new" || method === "session/resume") {
    const sessionId = boundedIdentifier(result.sessionId);
    return sessionId === undefined ? undefined : { observed: true, sessionId };
  }
  if (method === "session/prompt") {
    const stopReason = boundedIdentifier(result.stopReason);
    return stopReason === undefined ? undefined : { observed: true, stopReason };
  }
  if (method === "session/list") {
    return { observed: true, contentsRetained: false };
  }
  if (method === "session/close") {
    return { observed: true };
  }
  return undefined;
};

const projectCallback = (
  kind: SafeCallbackEvidence["kind"],
  value: unknown,
): SafeCallbackEvidence | undefined => {
  const params = asRecord(value);
  const sessionId = boundedIdentifier(params.sessionId);
  if (sessionId === undefined) {
    return undefined;
  }
  if (kind === "permission") {
    const toolCallId = boundedIdentifier(asRecord(params.toolCall).toolCallId);
    return toolCallId === undefined ? undefined : { kind, sessionId, toolCallId };
  }
  const update = asRecord(params.update);
  if (kind === "tool_update") {
    const toolCallId = boundedIdentifier(update.toolCallId);
    const status = boundedIdentifier(update.status);
    return toolCallId === undefined
      ? undefined
      : { kind, sessionId, toolCallId, ...(status === undefined ? {} : { status }) };
  }
  if (kind === "prompt_marker") {
    const content = asRecord(update.content);
    return update.sessionUpdate === "agent_message_chunk" &&
      content.type === "text" &&
      content.text === "runtime-profile-acp-ok"
      ? { kind, sessionId, promptMarkerMatched: true }
      : undefined;
  }
  const commands = update.availableCommands;
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS_PER_SESSION) {
    return undefined;
  }
  const commandNames = commands.map((command) => boundedIdentifier(asRecord(command).name));
  return commandNames.some((name) => name === undefined)
    ? undefined
    : { kind, sessionId, commandNames: commandNames as string[] };
};

export class ProbeEvidence {
  readonly anomalies: ProbeAnomaly[] = [];
  readonly callbacks: SafeCallbackEvidence[] = [];

  private reject(field: string, value: unknown): undefined {
    this.anomaly("evidence_value_rejected", field, value);
    return undefined;
  }

  sdkResult(method: string, value: unknown): SafeSdkResult | undefined {
    const result = projectSdkResult(method, value);
    return result === undefined
      ? this.reject(`sdk_result:${method}`, value)
      : { result };
  }

  callback(
    kind: SafeCallbackEvidence["kind"],
    value: unknown,
  ): SafeCallbackEvidence | undefined {
    const callback = projectCallback(kind, value);
    if (callback === undefined) {
      return this.reject(`callback:${kind}`, value);
    }
    if (this.callbacks.length >= MAX_RETAINED_CALLBACKS) {
      return this.reject("callbacks", callback);
    }
    this.callbacks.push(callback);
    return callback;
  }

  error(code: SafeErrorEvidence["code"], operation: string, value?: unknown): SafeErrorEvidence {
    const safeOperation = boundedIdentifier(operation) ?? "unknown_operation";
    return {
      code,
      operation: safeOperation,
      ...(value === undefined ? {} : { digestSha256: digest(value) }),
    };
  }

  stderr(bytes: Uint8Array, observedBytes: number, truncated: boolean): SafeStderrEvidence {
    return this.boundedBytes("stderr", bytes, observedBytes, truncated);
  }

  boundedBytes(
    field: string,
    bytes: Uint8Array,
    observedBytes: number,
    truncated: boolean,
    truncationCode: "stderr_truncated" | "diagnostic_truncated" = "stderr_truncated",
  ): SafeStderrEvidence {
    if (truncated) {
      this.anomaly(truncationCode, field);
    }
    return {
      bytesObserved: Math.max(0, Math.min(observedBytes, Number.MAX_SAFE_INTEGER)),
      bytesRetained: 0,
      digestSha256: digest(bytes),
      truncated,
    };
  }

  anomaly(code: ProbeAnomalyCode, field?: string, rejectedValue?: unknown): void {
    if (this.anomalies.length >= MAX_EVIDENCE_ANOMALIES) {
      return;
    }
    this.anomalies.push({
      code,
      ...(field === undefined ? {} : { field: boundedField(field) }),
      ...(rejectedValue === undefined ? {} : { digestSha256: digest(rejectedValue) }),
    });
    if (
      this.anomalies.length === MAX_EVIDENCE_ANOMALIES &&
      code !== "evidence_anomaly_limit_exceeded"
    ) {
      this.anomalies[MAX_EVIDENCE_ANOMALIES - 1] = {
        code: "evidence_anomaly_limit_exceeded",
      };
    }
  }
}
