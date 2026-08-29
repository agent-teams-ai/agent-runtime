import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";

declare const containedTurnIdentityBrand: unique symbol;

export type ContainedTurnIdentity<Namespace extends string> = string & {
  readonly [containedTurnIdentityBrand]: Namespace;
};

export type ContainedTurnAttemptId = ContainedTurnIdentity<"attempt">;
export type ContainedTurnCancellationCommandId = ContainedTurnIdentity<"cancellation_command">;
export type ContainedTurnCommandId = ContainedTurnIdentity<"command">;
export type ContainedTurnCustodyId = ContainedTurnIdentity<"custody">;
export type ContainedTurnEffectId = ContainedTurnIdentity<"effect">;
export type ContainedTurnEvidenceId = ContainedTurnIdentity<"evidence">;
export type ContainedTurnHostBootId = ContainedTurnIdentity<"host_boot">;
export type ContainedTurnHostInstanceId = ContainedTurnIdentity<"host_instance">;
export type ContainedTurnOperationId = ContainedTurnIdentity<"operation">;
export type ContainedTurnProofId = ContainedTurnIdentity<"proof">;
export type ContainedTurnWorkspaceId = ContainedTurnIdentity<"workspace">;

export const CONTAINED_TURN_IDENTITY_PREFIXES = Object.freeze({
  attempt: "attempt:",
  cancellation_command: "cancellation-command:",
  command: "command:",
  custody: "custody:",
  effect: "effect:",
  evidence: "evidence:",
  host_boot: "host-boot:",
  host_instance: "host-instance:",
  operation: "operation:",
  proof: "proof:",
  workspace: "workspace:",
} as const);

export type ContainedTurnIdentityNamespace = keyof typeof CONTAINED_TURN_IDENTITY_PREFIXES;

export const validateContainedTurnIdentity = <Namespace extends ContainedTurnIdentityNamespace>(
  namespace: Namespace,
  value: string,
): ContainedTurnIdentity<Namespace> => {
  validateContainedTurnText(`${namespace} identity`, value, CONTAINED_TURN_LIMITS.text.identifier);
  if (!value.startsWith(CONTAINED_TURN_IDENTITY_PREFIXES[namespace])) {
    throw new TypeError(`${namespace} identity must use its exact disjoint namespace prefix`);
  }
  if (value.length === CONTAINED_TURN_IDENTITY_PREFIXES[namespace].length) {
    throw new TypeError(`${namespace} identity must have a non-empty suffix`);
  }
  return value as ContainedTurnIdentity<Namespace>;
};

export const containedTurnIdentity = <Namespace extends ContainedTurnIdentityNamespace>(
  namespace: Namespace,
  value: string,
): ContainedTurnIdentity<Namespace> => validateContainedTurnIdentity(namespace, value);
