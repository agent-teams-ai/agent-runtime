import type {Session} from "../../../dist/interactive-contracts.js";
import type {InteractiveSessionDependencies, InteractiveSessionStore, StoreWrite} from "../../../dist/features/interactive-agent-session/application/ports/outbound/interactive-session-ports.js";
import {InteractiveSessionOwner} from "../../../dist/features/interactive-agent-session/application/use-cases/interactive-session-owner.js";
import type {SessionRecord, SessionRef} from "../../../dist/features/interactive-agent-session/domain/session.js";

export const ref: SessionRef = {tenantId: "tenant-TEST", projectId: "project-TEST", sessionId: "session-TEST", generation: 1};
export class MemorySessionStore implements InteractiveSessionStore {
  readonly records = new Map<string, SessionRecord>();
  unknownNext = false;
  #key(value: Pick<SessionRef, "tenantId" | "projectId" | "sessionId">): string {return JSON.stringify([value.tenantId, value.projectId, value.sessionId]);}
  async create(record: SessionRecord): Promise<StoreWrite> {
    const key = this.#key(record); if (this.records.has(key)) {return "conflict";}
    this.records.set(key, structuredClone(record));
    if (this.unknownNext) {this.unknownNext = false; return "unknown";}
    return "written";
  }
  async read(value: Pick<SessionRef, "tenantId" | "projectId" | "sessionId">): Promise<SessionRecord | undefined> {
    const record = this.records.get(this.#key(value)); return record && structuredClone(record);
  }
  async compareAndSwap(previous: SessionRecord, next: SessionRecord): Promise<StoreWrite> {
    const current = this.records.get(this.#key(previous));
    if (!current || current.generation !== previous.generation || current.revision !== previous.revision) {return "conflict";}
    this.records.set(this.#key(previous), structuredClone(next));
    if (this.unknownNext) {this.unknownNext = false; return "unknown";}
    return "written";
  }
}
export function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => {complete = resolve;});
  return {promise, resolve: complete};
}
export function fixture(store: InteractiveSessionStore = new MemorySessionStore(), overrides: Partial<InteractiveSessionDependencies> = {}) {
  const calls = {opened: 0, handoffs: [] as string[], replies: [] as string[], interrupts: [] as string[], closes: 0, custody: 0};
  let identity = 0;
  const driver: {-readonly [K in keyof Session]: Session[K]} = {
    sessionRef: "TEST-provider-session",
    async *observe() {},
    async checkReadiness() {return {ok: true, value: undefined};},
    checkpoint() {return {ok: true, value: "TEST-private-checkpoint"};},
    async submit(input) {calls.handoffs.push(input.operationRef); return {ok: true, value: {...input, delivery: "sdk-consumed", providerAcceptance: "unknown"}};},
    respondToInteraction(id) {calls.replies.push(id); return {ok: true, value: undefined};},
    async interrupt(id) {calls.interrupts.push(id); return {ok: true, value: {requested: true, terminal: "unconfirmed"}};},
    async close() {calls.closes++; return {logicallyClosed: true, cleanup: "confirmed"};},
  };
  const deps: Omit<InteractiveSessionDependencies, "custody"> & {custody: {-readonly [K in keyof InteractiveSessionDependencies["custody"]]: InteractiveSessionDependencies["custody"][K]}} = {
    scope: {tenantId: ref.tenantId, projectId: ref.projectId}, store,
    drivers: {async open() {calls.opened++; return {driver, capabilities: ["mcp", "interactive"]};}},
    authorize: async () => true,
    custody: {async close() {calls.custody++; return {outputDrained: true, resourcesStopped: true};}},
    clock: {now: () => 100}, interactionTimeoutMs: 100, newOperationId: () => `operation-${++identity}`,
    checkpoints: {save: async () => "checkpoint:private-1"},
    withinDeadline: async (_phase, work) => work(),
    limits: {queuedInputs: 2, inputBytes: 1024, events: 20, eventBytes: 2048, interactions: 4, commands: 30},
    ...overrides,
  };
  return {deps, driver, calls, owner: new InteractiveSessionOwner(deps), store};
}
export async function open(f: ReturnType<typeof fixture>): Promise<void> {
  const result = await f.owner.open(ref, "open-1", "config-1", ["mcp"]);
  if (result.status !== "accepted") {throw new Error(`unexpected open: ${result.status}`);}
}
export async function submit(f: ReturnType<typeof fixture>, number = 1): Promise<{inputId: string; operationId: string}> {
  const result = await f.owner.submit(ref, {commandId: `command-${number}`, inputId: `input-${number}`, content: `private TEST prompt ${number}`});
  if (!result.receipt) {throw new Error(`unexpected submit: ${result.status}`);}
  return result.receipt;
}
