import type {InteractiveSessionApi, SessionRef, SessionScope, SessionReply} from "../../domain/session-host.js";
import type {BuildInteractiveFeature, InteractiveHostPolicyPorts} from "../ports/outbound/interactive-host-ports.js";

const key = (ref: SessionRef): string => JSON.stringify([ref.tenantId, ref.projectId, ref.sessionId]);
const copyRef = (ref: SessionRef): SessionRef => Object.freeze({tenantId: ref.tenantId, projectId: ref.projectId,
  sessionId: ref.sessionId, generation: ref.generation});
const sameScope = (left: SessionScope, right: SessionScope): boolean => left.tenantId === right.tenantId && left.projectId === right.projectId;

/** One live effect owner under Host custody; no scheduler or provider loop is created here. */
export function createSessionHost(ports: InteractiveHostPolicyPorts, build: BuildInteractiveFeature) {
  const scope = Object.freeze({...ports.scope});
  const owned = new Map<string, SessionRef>();
  const attempts = new Set<Promise<SessionReply>>();
  let closing = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const available = (ref: SessionRef): boolean => !closing && sameScope(scope, ref);
  const retain = (ref: SessionRef): void => {
    if (!sameScope(scope, ref)) {throw new Error("interactive_host_unavailable");}
    const id = key(ref), previous = owned.get(id);
    if (previous && ref.generation !== previous.generation + 1) {throw new Error("interactive_host_generation_owned");}
    owned.set(id, copyRef(ref)); // retain even a late durable generation before refusing external acquisition
    if (closing) {throw new Error("interactive_host_unavailable");}
  };
  const feature = build(ref => available(ref) && owned.get(key(ref))?.generation === ref.generation, retain,
    (action, ref) => (action === "close" || available(ref)) && sameScope(scope, ref)
      ? ports.authorize(action, ref) : Promise.resolve(false));
  const track = (ref: SessionRef, reply: SessionReply): SessionReply => {
    if (sameScope(scope, ref) && ["accepted", "duplicate", "unknown"].includes(reply.status)) {
      const previous = owned.get(key(ref));
      if (!previous || previous.generation <= ref.generation) {owned.set(key(ref), copyRef(ref));}
    }
    return reply;
  };
  const schedule = (callerRef: SessionRef, work: (ref: SessionRef) => Promise<SessionReply>): Promise<SessionReply> => {
    const ref = copyRef(callerRef); // Work and post-await ownership use exactly the same immutable identity.
    if (!available(ref)) {return Promise.resolve({status: "unavailable"});}
    // Admission is synchronous. Disposal seals and joins every pending attempt before examining cleanup debt.
    const attempt = Promise.resolve().then(() => work(ref)).then(result => track(ref, result))
      .catch((error: unknown) => {track(ref, {status: "unknown"}); throw error;})
      .finally(() => {attempts.delete(attempt);});
    attempts.add(attempt);
    return attempt;
  };
  const api: InteractiveSessionApi = {
    open: (ref, ...args) => schedule(ref, captured => feature.session.open(captured, ...args)),
    read: callerRef => {const ref = copyRef(callerRef); return feature.session.read(ref);},
    submit: (ref, input) => schedule(ref, captured => feature.session.submit(captured, input)),
    reply: (ref, ...args) => schedule(ref, captured => feature.session.reply(captured, ...args)),
    interrupt: (ref, ...args) => schedule(ref, captured => feature.session.interrupt(captured, ...args)),
    close: ref => schedule(ref, feature.session.close),
    restore: (ref, ...args) => schedule(ref, async captured => {
      const result = await feature.session.restore(captured, ...args);
      if (["accepted", "duplicate", "unknown"].includes(result.status)) {
        const next = copyRef({...captured, generation: captured.generation + 1});
        if (await feature.session.read(next)) {track(next, result);}
      }
      return result;
    }),
  };
  return {
    bindAccess: (candidate: SessionScope): InteractiveSessionApi => {
      if (closing || !sameScope(scope, candidate)) {throw new Error("interactive_host_scope_denied");}
      return Object.freeze(api);
    },
    control: Object.freeze({dispatch: (ref: SessionRef) => schedule(ref, feature.control.dispatch),
      pumpOutput: (ref: SessionRef) => schedule(ref, feature.control.pumpOutput),
      recover: (ref: SessionRef) => schedule(ref, feature.control.recover),
      checkpoint: (ref: SessionRef) => schedule(ref, feature.control.checkpoint)}),
    dispose: (): Promise<void> => {
      if (disposed) {return Promise.resolve();}
      return disposal ??= (async () => {
        closing = true;
        await Promise.allSettled(attempts);
        let incomplete = false;
        for (const ref of owned.values()) {
          try {
            const result = await feature.control.cleanup(ref);
            if (result.status !== "accepted" && result.status !== "duplicate") {incomplete = true;}
          } catch {incomplete = true;}
        }
        if (incomplete) {throw new Error("interactive_host_cleanup_incomplete");}
        disposed = true;
      })().catch((error: unknown) => {disposal = undefined; throw error;});
    },
  };
}
