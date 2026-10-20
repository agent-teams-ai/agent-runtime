import {InteractiveSessionOwner} from "../application/use-cases/interactive-session-owner.js";
import type {InteractiveSessionDependencies} from "../application/ports/outbound/interactive-session-ports.js";
import type {InteractiveSessionApi, SessionRef, SessionReply} from "../contracts/interactive-session.js";

export interface InteractiveSessionFeature {
  readonly session: InteractiveSessionApi;
  /** Trusted Host scheduling only. No provider references or native configuration escape. */
  readonly control: {
    readonly dispatch: (ref: SessionRef) => Promise<SessionReply>;
    readonly pumpOutput: (ref: SessionRef) => Promise<SessionReply>;
    readonly recover: (ref: SessionRef) => Promise<SessionReply>;
    readonly checkpoint: (ref: SessionRef) => Promise<SessionReply>;
  };
}
export function createInteractiveSessionFeature(dependencies: InteractiveSessionDependencies): InteractiveSessionFeature {
  if (!Number.isSafeInteger(dependencies.interactionTimeoutMs) || dependencies.interactionTimeoutMs <= 0) {throw new TypeError("interactive_timeout_invalid");}
  const owner = new InteractiveSessionOwner(dependencies);
  return {session: {open: owner.open.bind(owner), read: owner.read.bind(owner), submit: owner.submit.bind(owner),
    reply: owner.reply.bind(owner), interrupt: owner.interrupt.bind(owner), close: owner.close.bind(owner), restore: owner.restore.bind(owner)},
  control: {dispatch: owner.dispatch.bind(owner), pumpOutput: owner.pumpOutput.bind(owner), recover: owner.recover.bind(owner), checkpoint: owner.checkpoint.bind(owner)}};
}
