import type {InteractiveSessionDependencies} from "../ports/outbound/interactive-session-ports.js";
import {sameScope, validateRecord, type SessionRecord, type SessionRef, type SessionReply} from "../../domain/session.js";

export interface Mutation {readonly record: SessionRecord; readonly reply: SessionReply}
export type MutationResult = {readonly reply: SessionReply; readonly record?: SessionRecord};
/** Retries only pure state transitions after an authoritative CAS conflict, never an external effect. */
export async function mutateSession(deps: InteractiveSessionDependencies, ref: SessionRef,
  change: (current: SessionRecord) => Mutation | SessionReply): Promise<MutationResult> {
  if (!sameScope(deps.scope, ref)) {return {reply: {status: "denied"}};}
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await deps.store.read(ref);
    if (!current || current.generation !== ref.generation) {return {reply: {status: "stale"}};}
    const changed = change(current);
    if (!("record" in changed)) {return {reply: changed, record: current};}
    const next = {...changed.record, revision: current.revision + 1};
    validateRecord(next);
    const disposition = await deps.store.compareAndSwap(current, next);
    if (disposition === "written") {return {reply: changed.reply, record: next};}
    if (disposition === "unknown") {return {reply: {status: "unknown"}};}
  }
  return {reply: {status: "unavailable"}};
}
export function priorCommand(record: SessionRecord, commandId: string, fingerprint: string): SessionReply | undefined {
  const prior = record.commands.find(item => item.commandId === commandId);
  if (!prior) {return record.commands.length >= record.limits.commands ? {status: "backpressure"} : undefined;}
  return {status: prior.fingerprint !== fingerprint ? "conflict" : prior.disposition === "unknown" ? "unknown" : "duplicate"};
}
export function command(record: SessionRecord, commandId: string, fingerprint: string): SessionRecord {
  return {...record, commands: [...record.commands, {commandId, fingerprint, disposition: "accepted"}]};
}
