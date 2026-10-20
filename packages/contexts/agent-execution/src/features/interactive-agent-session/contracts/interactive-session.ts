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
  readonly inputs: readonly {readonly inputId: string; readonly operationId: string; readonly status: "admitted" | "dispatching" | "sdk_consumed" | "succeeded" | "failed" | "cancelled" | "reconcile_required"; readonly delivery: "admitted" | "dispatching" | "sdk_consumed" | "known_not_sent" | "unknown"; readonly cancellationRequested: boolean}[];
  readonly events: readonly SessionEvent[];
}

export interface InteractiveSessionApi {
  readonly open: (ref: SessionRef, commandId: string, configRevision: string, requiredCapabilities: readonly string[]) => Promise<SessionReply>;
  readonly read: (ref: SessionRef) => Promise<SessionView | undefined>;
  readonly submit: (ref: SessionRef, input: {readonly commandId: string; readonly inputId: string; readonly content: string}) => Promise<SessionReply>;
  readonly reply: (ref: SessionRef, commandId: string, interactionId: string, answer: import("./interactive-provider-driver.js").InteractionReply) => Promise<SessionReply>;
  readonly interrupt: (ref: SessionRef, commandId: string, operationId: string) => Promise<SessionReply>;
  readonly close: (ref: SessionRef) => Promise<SessionReply>;
  readonly restore: (ref: SessionRef, commandId: string, configRevision: string) => Promise<SessionReply>;
}
