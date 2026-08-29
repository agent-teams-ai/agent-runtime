import { createRequire } from "node:module";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import {
  ClientApp,
  methods,
  ndJsonStream,
  type ClientConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

const require = createRequire(import.meta.url);
const acpV1Schema = require("@agentclientprotocol/sdk/schema/schema.json") as object;
const ACP_V1_SCHEMA_ID = "urn:agent-runtime:official-acp-v1";
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema(acpV1Schema, ACP_V1_SCHEMA_ID);

const schemaValidator = (definition: string): ValidateFunction => {
  const validator = ajv.getSchema(`${ACP_V1_SCHEMA_ID}#/$defs/${definition}`);
  if (validator === undefined) {
    throw new Error(`Official ACP v1 schema lacks ${definition}`);
  }
  return validator;
};

const initializeResponse = schemaValidator("InitializeResponse");
const permissionRequest = schemaValidator("RequestPermissionRequest");
const sessionNotification = schemaValidator("SessionNotification");
const cancelNotification = schemaValidator("CancelNotification");

export const OPENCODE_PROVIDER_ID = "opencode";
export const OPENCODE_ACP_MAX_IDENTIFIER_LENGTH = 128;
export const OPENCODE_ACP_MAX_CAPABILITY_KEY_LENGTH = 64;
export const OPENCODE_ACP_MAX_UNKNOWN_CAPABILITIES = 32;

export type OpenCodeValidationErrorCode =
  | "malformed_observation"
  | "unsupported_capability"
  | "unsupported_protocol";

export class OpenCodeValidationError extends Error {
  public readonly code: OpenCodeValidationErrorCode;
  public readonly details: Readonly<Record<string, string | number | boolean | null>>;

  public constructor(
    code: OpenCodeValidationErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = "OpenCodeValidationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

const malformed = (kind: string): never => {
  throw new OpenCodeValidationError("malformed_observation", "Malformed OpenCode ACP observation", {
    kind,
  });
};

const officialSchemaValue = <Value>(
  validator: ValidateFunction,
  value: unknown,
  kind: string,
): Value => {
  if (!validator(value)) {
    return malformed(kind);
  }
  return value as Value;
};

const stableIdentifier = (value: unknown, kind: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > OPENCODE_ACP_MAX_IDENTIFIER_LENGTH ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return malformed(kind);
  }
  return value;
};

const boundedCapabilityKey = (value: string): string => {
  if (
    value.length === 0 ||
    value.length > OPENCODE_ACP_MAX_CAPABILITY_KEY_LENGTH ||
    !/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)
  ) {
    return malformed("capability_identifier");
  }
  return value;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const KNOWN_AGENT_CAPABILITIES = new Set([
  "_meta",
  "auth",
  "loadSession",
  "mcpCapabilities",
  "nes",
  "positionEncoding",
  "promptCapabilities",
  "providers",
  "sessionCapabilities",
]);
const KNOWN_SESSION_CAPABILITIES = new Set([
  "_meta",
  "additionalDirectories",
  "close",
  "delete",
  "fork",
  "list",
  "resume",
]);

export type OpenCodeCapabilityStatus = "baseline" | "deferred" | "supported" | "unsupported";

export interface OpenCodeCapabilityObservation {
  readonly providerId: typeof OPENCODE_PROVIDER_ID;
  readonly protocolVersion: 1;
  readonly providerName: string | null;
  readonly providerVersion: string | null;
  readonly session: Readonly<{
    new: "baseline";
    prompt: "baseline";
    cancel: "baseline";
    update: "baseline";
    load: "supported" | "unsupported";
    list: "supported" | "unsupported";
    resume: "supported" | "unsupported";
    close: "supported" | "unsupported";
    fork: "deferred" | "unsupported";
  }>;
  readonly prompt: Readonly<{
    audio: boolean;
    embeddedContext: boolean;
    image: boolean;
  }>;
  readonly mcp: Readonly<{ http: boolean; sse: boolean }>;
  readonly unknown: readonly string[];
}

const advertised = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.hasOwn(record, key) && record[key] !== null;

export const observeOpenCodeCapabilities = (value: unknown): OpenCodeCapabilityObservation => {
  const initialized = officialSchemaValue<InitializeResponse>(
    initializeResponse,
    value,
    "initialize_response",
  );
  if (initialized.protocolVersion !== 1) {
    throw new OpenCodeValidationError("unsupported_protocol", "OpenCode execution requires ACP v1", {
      protocolVersion: initialized.protocolVersion,
    });
  }

  const capabilities = isRecord(initialized.agentCapabilities)
    ? initialized.agentCapabilities
    : {};
  const sessions = isRecord(capabilities.sessionCapabilities)
    ? capabilities.sessionCapabilities
    : {};
  const prompt = isRecord(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
  const mcp = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
  const unknown = [
    ...Object.keys(capabilities)
      .filter((key) => !KNOWN_AGENT_CAPABILITIES.has(key))
      .map((key) => `agentCapabilities/${boundedCapabilityKey(key)}`),
    ...Object.keys(sessions)
      .filter((key) => !KNOWN_SESSION_CAPABILITIES.has(key))
      .map((key) => `sessionCapabilities/${boundedCapabilityKey(key)}`),
  ].toSorted();
  if (unknown.length > OPENCODE_ACP_MAX_UNKNOWN_CAPABILITIES) {
    return malformed("capability_count");
  }

  const providerName = initialized.agentInfo?.name ?? null;
  const providerVersion = initialized.agentInfo?.version ?? null;
  const observation: OpenCodeCapabilityObservation = {
    providerId: OPENCODE_PROVIDER_ID,
    protocolVersion: 1,
    providerName:
      providerName === null ? null : stableIdentifier(providerName, "provider_name"),
    providerVersion:
      providerVersion === null ? null : stableIdentifier(providerVersion, "provider_version"),
    session: Object.freeze({
      new: "baseline",
      prompt: "baseline",
      cancel: "baseline",
      update: "baseline",
      load: capabilities.loadSession === true ? "supported" : "unsupported",
      list: advertised(sessions, "list") ? "supported" : "unsupported",
      resume: advertised(sessions, "resume") ? "supported" : "unsupported",
      close: advertised(sessions, "close") ? "supported" : "unsupported",
      fork: advertised(sessions, "fork") ? "deferred" : "unsupported",
    }),
    prompt: Object.freeze({
      audio: prompt.audio === true,
      embeddedContext: prompt.embeddedContext === true,
      image: prompt.image === true,
    }),
    mcp: Object.freeze({ http: mcp.http === true, sse: mcp.sse === true }),
    unknown: Object.freeze(unknown),
  };
  return Object.freeze(observation);
};

export const observeOpenCodeNegotiation = (
  requestedVersion: number,
  response: unknown,
): OpenCodeCapabilityObservation => {
  if (!Number.isSafeInteger(requestedVersion) || (requestedVersion !== 1 && requestedVersion !== 2)) {
    return malformed("requested_protocol_version");
  }
  return observeOpenCodeCapabilities(response);
};

export const requireOpenCodeCapability = (
  observation: OpenCodeCapabilityObservation,
  capability: keyof OpenCodeCapabilityObservation["session"],
): void => {
  const status: OpenCodeCapabilityStatus = observation.session[capability];
  if (status === "baseline" || status === "supported") {
    return;
  }
  throw new OpenCodeValidationError(
    "unsupported_capability",
    "OpenCode ACP capability is unavailable for execution",
    { capability, deferred: status === "deferred" },
  );
};

const requireActiveSession = (activeSessionId: string, observedSessionId: unknown): string => {
  const active = stableIdentifier(activeSessionId, "active_session_id");
  const observed = stableIdentifier(observedSessionId, "observed_session_id");
  if (active !== observed) {
    return malformed("active_session_mismatch");
  }
  return observed;
};

export interface OpenCodePermissionObservation {
  readonly kind: "permission";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly autoApproved: false;
  readonly disposition: "deferred_to_runtime_authority";
}

export const observeOpenCodePermission = (
  activeSessionId: string,
  value: unknown,
): OpenCodePermissionObservation => {
  const request = officialSchemaValue<RequestPermissionRequest>(
    permissionRequest,
    value,
    "permission_request",
  );
  return Object.freeze({
    kind: "permission",
    sessionId: requireActiveSession(activeSessionId, request.sessionId),
    toolCallId: stableIdentifier(request.toolCall.toolCallId, "tool_call_id"),
    autoApproved: false,
    disposition: "deferred_to_runtime_authority",
  });
};

export interface OpenCodeToolObservation {
  readonly kind: "tool";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly autoApproved: false;
}

export const observeOpenCodeToolUpdate = (
  activeSessionId: string,
  value: unknown,
): OpenCodeToolObservation | null => {
  const notification = officialSchemaValue<SessionNotification>(
    sessionNotification,
    value,
    "session_notification",
  );
  if (
    notification.update.sessionUpdate !== "tool_call" &&
    notification.update.sessionUpdate !== "tool_call_update"
  ) {
    return null;
  }
  return Object.freeze({
    kind: "tool",
    sessionId: requireActiveSession(activeSessionId, notification.sessionId),
    toolCallId: stableIdentifier(notification.update.toolCallId, "tool_call_id"),
    autoApproved: false,
  });
};

export type OpenCodeCancellationDisposition =
  | "ambiguous_requires_reconciliation"
  | "cancelled_after_acceptance"
  | "cancelled_before_acceptance"
  | "completed_before_cancel";

export interface OpenCodeCancellationEvidence {
  readonly cancel: unknown;
  readonly explicitNoStartProof: boolean;
  readonly providerAccepted: boolean | "unknown";
  readonly terminalStopReason: "cancelled" | "end_turn" | null;
}

export const observeOpenCodeCancellation = (
  activeSessionId: string,
  evidence: OpenCodeCancellationEvidence,
): OpenCodeCancellationDisposition => {
  if (
    typeof evidence.explicitNoStartProof !== "boolean" ||
    ![true, false, "unknown"].includes(evidence.providerAccepted) ||
    ![null, "cancelled", "end_turn"].includes(evidence.terminalStopReason)
  ) {
    return malformed("cancellation_evidence");
  }
  const cancel = officialSchemaValue<{ readonly sessionId: string }>(
    cancelNotification,
    evidence.cancel,
    "cancel_notification",
  );
  requireActiveSession(activeSessionId, cancel.sessionId);

  if (
    evidence.explicitNoStartProof &&
    evidence.providerAccepted === false &&
    evidence.terminalStopReason === null
  ) {
    return "cancelled_before_acceptance";
  }
  if (
    !evidence.explicitNoStartProof &&
    evidence.providerAccepted !== false &&
    evidence.terminalStopReason === "end_turn"
  ) {
    return "completed_before_cancel";
  }
  if (
    !evidence.explicitNoStartProof &&
    evidence.providerAccepted === true &&
    evidence.terminalStopReason === "cancelled"
  ) {
    return "cancelled_after_acceptance";
  }
  return "ambiguous_requires_reconciliation";
};

export interface OpenCodeClientPolicy {
  readonly activeSessionId: string;
  readonly onPermission?: (observation: OpenCodePermissionObservation) => void;
  readonly onTool?: (observation: OpenCodeToolObservation) => void;
}

export const createOpenCodeClientApp = (policy: OpenCodeClientPolicy): ClientApp => {
  const activeSessionId = stableIdentifier(policy.activeSessionId, "active_session_id");
  return new ClientApp({ name: "agent-runtime-opencode-characterization" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      policy.onPermission?.(observeOpenCodePermission(activeSessionId, params));
      return { outcome: { outcome: "cancelled" } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      const observation = observeOpenCodeToolUpdate(activeSessionId, params);
      if (observation !== null) {
        policy.onTool?.(observation);
      }
    });
};

/** Streams carrying raw ACP bytes must already be bounded and owned by Host Custody. */
export interface CustodiedOpenCodeAcpStreams {
  readonly boundedByHostCustody: true;
  readonly fromAgent: ReadableStream<Uint8Array>;
  readonly toAgent: WritableStream<Uint8Array>;
}

export const attachOpenCodeClientToCustodiedStreams = (
  streams: CustodiedOpenCodeAcpStreams,
  policy: OpenCodeClientPolicy,
): ClientConnection => {
  if (streams.boundedByHostCustody !== true) {
    return malformed("unbounded_host_streams");
  }
  return createOpenCodeClientApp(policy).connect(ndJsonStream(streams.toAgent, streams.fromAgent));
};
