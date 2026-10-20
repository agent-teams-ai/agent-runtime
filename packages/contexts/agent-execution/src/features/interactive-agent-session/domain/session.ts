export interface SessionScope {readonly tenantId: string; readonly projectId: string}
export interface SessionRef extends SessionScope {readonly sessionId: string; readonly generation: number}
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {readonly [key: string]: JsonValue};
export type SessionStatus = "opening" | "ready" | "unavailable" | "closing" | "closed" | "reconcile_required";
export interface SessionEvent {
  readonly sequence: number;
  readonly generation: number;
  readonly operationId?: string;
  readonly inputId?: string;
  readonly kind: "text" | "tool" | "tool-result" | "usage" | "result" | "interaction" | "diagnostic";
  readonly data: JsonValue;
}
export interface SessionLimits {
  readonly queuedInputs: number;
  readonly inputBytes: number;
  readonly events: number;
  readonly eventBytes: number;
  readonly interactions: number;
  readonly commands: number;
}
export type SessionOutcome = "accepted" | "duplicate" | "conflict" | "stale" | "unavailable" | "backpressure" | "unknown" | "unsupported" | "denied";
export interface SessionReply {readonly status: SessionOutcome; readonly receipt?: {readonly inputId: string; readonly operationId: string}}
export interface SessionView extends SessionRef {
  readonly revision: number;
  readonly status: SessionStatus;
  readonly inputs: readonly {readonly inputId: string; readonly operationId: string; readonly status: "admitted" | "dispatching" | "client_consumed" | "succeeded" | "failed" | "cancelled" | "reconcile_required"; readonly delivery: "admitted" | "dispatching" | "client_consumed" | "known_not_sent" | "unknown"; readonly cancellationRequested: boolean}[];
  readonly events: readonly SessionEvent[];
}


export type InputStatus = "admitted" | "dispatching" | "client_consumed" | "succeeded" | "failed" | "cancelled" | "reconcile_required";
export interface SessionInput {
  readonly inputId: string;
  readonly operationId: string;
  readonly content: string;
  readonly status: InputStatus;
  readonly delivery: "admitted" | "dispatching" | "client_consumed" | "known_not_sent" | "unknown";
  readonly cancellationRequested: boolean;
}
export interface Interaction {
  readonly interactionId: string;
  readonly generation: number;
  readonly operationId?: string;
  readonly kind: "permission" | "question";
  readonly expiresAt: number;
  readonly state: "pending" | "replying" | "replied" | "cancelled" | "unknown";
}
export interface SessionCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly disposition: "accepted" | "complete" | "unknown";
}
/** Private owner record. Prompts, commands and checkpoint references are never caller snapshots. */
export interface SessionRecord extends SessionRef {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly configRevision: string;
  readonly requiredCapabilities: readonly string[];
  readonly status: SessionStatus;
  readonly controlPending: boolean;
  readonly limits: SessionLimits;
  readonly inputs: readonly SessionInput[];
  readonly interactions: readonly Interaction[];
  readonly commands: readonly SessionCommand[];
  readonly events: readonly SessionEvent[];
  readonly checkpointRef?: string;
}
export function sessionView(record: SessionRecord): SessionView {
  return structuredClone({sessionId: record.sessionId, generation: record.generation, tenantId: record.tenantId,
    projectId: record.projectId, revision: record.revision, status: record.status,
    inputs: record.inputs.map(({inputId, operationId, status, delivery, cancellationRequested}) => ({inputId, operationId, status, delivery, cancellationRequested})), events: record.events});
}
export function sameScope(left: SessionScope, right: SessionScope): boolean {
  return left.tenantId === right.tenantId && left.projectId === right.projectId;
}
export function terminal(status: InputStatus): boolean {return ["succeeded", "failed", "cancelled"].includes(status);}
export function utf8Bytes(value: string): number {
  let length = 0;
  for (const character of value) {const point = character.codePointAt(0)!; length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;}
  return length;
}
const id = (value: string): boolean => typeof value === "string" && /^[A-Za-z0-9:._-]{1,128}$/u.test(value);
function invalidContents(record: SessionRecord): boolean {
  return record.inputs.some(input => !id(input.inputId) || !id(input.operationId) || typeof input.content !== "string" || utf8Bytes(input.content) > record.limits.inputBytes ||
        !["admitted", "dispatching", "client_consumed", "succeeded", "failed", "cancelled", "reconcile_required"].includes(input.status) ||
        !["admitted", "dispatching", "client_consumed", "known_not_sent", "unknown"].includes(input.delivery) || typeof input.cancellationRequested !== "boolean") ||
      record.commands.some(command => !id(command.commandId) || typeof command.fingerprint !== "string" || !["accepted", "complete", "unknown"].includes(command.disposition)) ||
      record.interactions.some(interaction => !id(interaction.interactionId) || !Number.isSafeInteger(interaction.generation) || interaction.generation < 1 || interaction.generation > record.generation || !Number.isFinite(interaction.expiresAt) ||
        !["permission", "question"].includes(interaction.kind) || !["pending", "replying", "replied", "cancelled", "unknown"].includes(interaction.state) ||
        interaction.operationId !== undefined && !record.inputs.some(input => input.operationId === interaction.operationId)) ||
      record.events.some((event, index) => event.sequence !== index + 1 || !Number.isSafeInteger(event.generation) || event.generation < 1 || event.generation > record.generation);
}
function invalidIdentity(record: SessionRecord): boolean {
  const validStatus = ["opening", "ready", "unavailable", "closing", "closed", "reconcile_required"].includes(record.status);
  return (record.schemaVersion !== 1 || ![record.tenantId, record.projectId, record.sessionId].every(id) ||
      !Number.isSafeInteger(record.generation) || record.generation < 1 || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      !validStatus || typeof record.controlPending !== "boolean" || typeof record.configRevision !== "string" || !record.configRevision );
}
export function validateRecord(record: SessionRecord): void {
  if (invalidIdentity(record) ||
      !["queuedInputs", "inputBytes", "events", "eventBytes", "interactions", "commands"].every(name => Number.isSafeInteger(record.limits[name as keyof SessionLimits]) && record.limits[name as keyof SessionLimits] > 0) ||
      record.commands.length > record.limits.commands || record.events.length > record.limits.events + 1 ||
      record.events.length > record.limits.events && (record.events.at(-1)?.kind !== "diagnostic" || JSON.stringify(record.events.at(-1)?.data) !== '{"code":"output-limit"}') ||
      new Set(record.inputs.map(input => input.inputId)).size !== record.inputs.length ||
      new Set(record.inputs.map(input => input.operationId)).size !== record.inputs.length ||
      new Set(record.commands.map(command => command.commandId)).size !== record.commands.length ||
      new Set(record.interactions.map(interaction => JSON.stringify([interaction.generation, interaction.interactionId]))).size !== record.interactions.length ||
      invalidContents(record)) {
    throw new TypeError("interactive_session_record_invalid");
  }
}
