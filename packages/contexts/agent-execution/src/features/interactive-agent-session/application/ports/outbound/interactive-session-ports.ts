import type {JsonValue, SessionLimits, SessionRecord, SessionRef, SessionScope} from "../../../domain/session.js";
import type {DriverFactory, InteractionReply} from "./interactive-provider-driver.js";

export type StoreWrite = "written" | "conflict" | "unknown";
/** Unknown commit never grants dispatch; adapter never chooses retry/readback policy. */
export interface InteractiveSessionStore {
  readonly create: (record: SessionRecord) => Promise<StoreWrite>;
  readonly read: (ref: SessionScope & {readonly sessionId: string}) => Promise<SessionRecord | undefined>;
  readonly compareAndSwap: (previous: SessionRecord, next: SessionRecord) => Promise<StoreWrite>;
}
export type InteractionAnswer = InteractionReply;
export interface InteractiveSessionDependencies {
  readonly scope: SessionScope;
  readonly store: InteractiveSessionStore;
  readonly drivers: DriverFactory;
  readonly authorize: (action: "open" | "submit" | "dispatch" | "reply" | "interrupt" | "close" | "restore", ref: SessionRef) => Promise<boolean>;
  readonly custody: {readonly close: (ref: SessionRef) => Promise<{
    readonly outputDrained: boolean;
    readonly resourcesStopped: boolean;
    /** Independent exact-generation custody evidence, never inferred from a stopped process. */
    readonly ownerClosure?: {readonly session: SessionRef; readonly logicalClosed: true; readonly grantsClosed: true};
  }>};
  readonly clock: {readonly now: () => number};
  readonly interactionTimeoutMs: number;
  /** Existing trusted Host/provider checkpoint storage; bytes never enter caller snapshots. */
  readonly checkpoints?: {readonly save: (binding: SessionRef & {readonly configRevision: string}, payload: unknown) => Promise<string>};
  readonly newOperationId: () => string;
  /** Host applies finite deadlines without interpreting timeout as proof of no effect. */
  readonly withinDeadline: <T>(phase: "handoff" | "observe" | "control" | "close", work: () => Promise<T>) => Promise<T>;
  readonly limits: SessionLimits;
}
export type DriverObservation = {
  readonly kind: "text" | "tool" | "tool-result" | "usage" | "diagnostic";
  readonly operationId?: string; readonly inputId?: string; readonly data: JsonValue;
} | {
  readonly kind: "result"; readonly operationId: string; readonly inputId: string;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
} | {
  readonly kind: "interaction"; readonly operationId?: string; readonly inputId?: string;
  readonly interactionId: string; readonly requestKind: "permission" | "question"; readonly expiresAt: number; readonly data?: JsonValue;
};
