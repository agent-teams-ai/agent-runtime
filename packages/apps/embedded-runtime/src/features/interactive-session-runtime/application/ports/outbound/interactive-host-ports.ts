import type {InteractiveSessionApi, SessionRef, SessionReply, SessionScope} from "../../../domain/session-host.js";

export type HostAction = "open" | "submit" | "dispatch" | "reply" | "interrupt" | "close" | "restore";
export interface InteractiveHostPolicyPorts {
  readonly scope: SessionScope;
  readonly authorize: (action: HostAction, ref: SessionRef) => Promise<boolean>;
}
export interface InteractiveFeaturePort {
  readonly session: InteractiveSessionApi;
  readonly control: {
    readonly dispatch: (ref: SessionRef) => Promise<SessionReply>;
    readonly pumpOutput: (ref: SessionRef) => Promise<SessionReply>;
    readonly recover: (ref: SessionRef) => Promise<SessionReply>;
    readonly checkpoint: (ref: SessionRef) => Promise<SessionReply>;
    readonly cleanup: (ref: SessionRef) => Promise<SessionReply>;
  };
}
export interface HostOwnership {
  readonly acquire: () => Promise<{readonly release: () => Promise<void>}>;
}
/** A narrow construction port; concrete Agent Execution factory and persistence stay in composition. */
export type BuildInteractiveFeature = (current: (ref: SessionRef) => boolean, retain: (ref: SessionRef) => void, authorize: InteractiveHostPolicyPorts["authorize"]) => InteractiveFeaturePort;
