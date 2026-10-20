import type {InteractiveSessionStore} from "@agent-teams/agent-execution/composition";
import type {Event, Session} from "@agent-teams/agent-execution/interactive-contracts";
import type {InteractiveHostPorts, HostOwnership} from "../../../dist/features/interactive-session-runtime/internal.js";

export const ref = {tenantId: "TEST-tenant", projectId: "TEST-project", sessionId: "TEST-session", generation: 1};
type RecordState = NonNullable<Awaited<ReturnType<InteractiveSessionStore["read"]>>>;
export function fixture(shared = new Map<string, RecordState>()) {
  let operation = 0; let released = 0; let opens = 0; let closes = 0; let cleanup = true; let lostProof = false;
  const configs: unknown[] = [];
  const queue: Event[] = [];
  const store: InteractiveSessionStore = {
    create: async record => {if (shared.has(record.sessionId)) {return "conflict";} shared.set(record.sessionId, structuredClone(record)); return "written";},
    read: async key => {const record = shared.get(key.sessionId); return record && structuredClone(record);},
    compareAndSwap: async (before, after) => {
      const current = shared.get(before.sessionId);
      if (!current || current.revision !== before.revision || current.generation !== before.generation) {return "conflict";}
      shared.set(before.sessionId, structuredClone(after)); return "written";
    },
  };
  const driver: Session = {
    sessionRef: "TEST-private-provider-session",
    submit: async input => ({ok: true, value: {inputId: input.inputId, operationRef: input.operationRef, delivery: "client-consumed", providerAcceptance: "unknown"}}),
    observe: async function* () {while (queue.length) {yield queue.shift()!;}},
    respondToInteraction: () => ({ok: true, value: undefined}),
    interrupt: async () => ({ok: true, value: {requested: true, terminal: "unconfirmed"}}),
    checkReadiness: async () => ({ok: true, value: undefined}),
    checkpoint: () => ({ok: true, value: {version: 1, private: "TEST-checkpoint"}}),
    close: async () => {closes++; return {logicallyClosed: true, cleanup: "confirmed"};},
  };
  const ports: InteractiveHostPorts = {
    context: {scope: ref, clock: {now: () => 100}, limits: {queuedInputs: 8, inputBytes: 1024, events: 32, eventBytes: 8192, interactions: 8, commands: 32},
      interactionTimeoutMs: 1000, newOperationId: () => `TEST-operation-${++operation}`,
      withinDeadline: async (_phase, work) => work(), checkpoints: {save: async () => "TEST-checkpoint-ref"}},
    store, provider: {open: async config => {opens++; configs.push(structuredClone(config)); return {driver, capabilities: ["TEST-mcp"]};}},
    authority: {authorize: async () => true},
    custody: {close: async session => ({outputDrained: cleanup, resourcesStopped: cleanup,
      ...(lostProof ? {ownerClosure: {session, logicalClosed: true as const, grantsClosed: true as const}} : {})})},
  };
  const ownership: HostOwnership = {acquire: async () => ({release: async () => {released++;}})};
  return {ports, ownership, store, shared, queue, driver, configs,
    counts: () => ({opens, closes, released}), cleanup: (value: boolean) => {cleanup = value;}, proof: (value: boolean) => {lostProof = value;}};
}
