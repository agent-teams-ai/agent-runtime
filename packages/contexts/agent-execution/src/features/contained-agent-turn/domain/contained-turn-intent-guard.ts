import type { ContainedTurnScope } from "./contained-turn-authority.js";
import { digestContainedTurnCanonicalValue, type ContainedTurnCanonicalDigest, type ContainedTurnCommandFingerprint } from "./contained-turn-codecs.js";
import { containedTurnIdentity, type ContainedTurnCancellationCommandId, type ContainedTurnCommandId, type ContainedTurnOperationId, type ContainedTurnProofId } from "./contained-turn-identities.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";
import { assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "./contained-turn-record.js";

/** Root-selected immutable V1 namespace. Advancing it requires a separate retirement decision. */
export interface ContainedTurnIntentAuthority {
  readonly audience: string;
  readonly authorityRevision: string;
  readonly deploymentId: string;
  readonly deploymentIncarnation: string;
  /** Digest of all applicable external authority preconditions, including explicit non-applicability. */
  readonly externalAuthorityDigest: ContainedTurnCanonicalDigest;
  readonly runtimeScopeRevision: string;
}

/** Owner-private command, never an ordinary RuntimeAccessHandle capability. */
export interface ContainedTurnPreventionCommand {
  readonly authority: ContainedTurnIntentAuthority;
  readonly commandFingerprint: ContainedTurnCommandFingerprint;
  readonly commandId: ContainedTurnCommandId;
  readonly preventionCommandId: ContainedTurnCancellationCommandId;
  readonly preventionDigest: ContainedTurnCanonicalDigest;
  readonly scope: ContainedTurnScope;
  readonly targetIntentCorrelation: string | null;
  readonly version: 1;
}

/** Immutable truth at the prevention transaction, not a claim about later containment. */
export interface ContainedTurnPreventionReceipt {
  readonly command: ContainedTurnPreventionCommand;
  readonly disposition: "intent_guarded" | "operation_fenced" | "cutoff_requested" | "already_terminal";
  readonly operationId: ContainedTurnOperationId | null;
  readonly operationRevision: number | null;
  readonly cutoffProofId: ContainedTurnProofId | null;
  readonly receiptId: ContainedTurnProofId;
  readonly version: 1;
}

// Check primitive type/length before UTF-8 encoding or canonicalization.
const guardText = (value: string, maximumBytes = 512): void => {
  if (typeof value !== "string" || value.length > maximumBytes) {throw new TypeError("invalid intent guard text");}
  validateContainedTurnText("intent guard text", value, { encoding: "ascii", maximumBytes });
};
const guardIdentity = (namespace: Parameters<typeof containedTurnIdentity>[0], value: string): void => {
  guardText(value);
  containedTurnIdentity(namespace, value);
};

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
export const validateContainedTurnGuardDigest = (value: string): void => {
  if (typeof value !== "string" || !digestPattern.test(value)) {throw new TypeError("invalid intent guard digest");}
};

export const validateContainedTurnIntentAuthority = (authority: ContainedTurnIntentAuthority): void => {
  assertContainedTurnExactRecord("intent authority", authority, [
    "audience", "authorityRevision", "deploymentId", "deploymentIncarnation", "externalAuthorityDigest", "runtimeScopeRevision",
  ]);
  for (const value of Object.values(authority)) {
    guardText(value);
  }
  validateContainedTurnGuardDigest(authority.externalAuthorityDigest);
};

export const containedTurnIntentAuthorityDigest = (authority: ContainedTurnIntentAuthority): ContainedTurnCanonicalDigest => {
  validateContainedTurnIntentAuthority(authority);
  return digestContainedTurnCanonicalValue({ ...authority });
};

export const containedTurnPreventionDigest = (
  command: Omit<ContainedTurnPreventionCommand, "preventionDigest">,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue({
  ...command, authority: { ...command.authority }, scope: { ...command.scope },
});

export const validateContainedTurnPreventionCommand = (command: ContainedTurnPreventionCommand): void => {
  assertContainedTurnExactRecord("prevention command", command, [
    "authority", "commandFingerprint", "commandId", "preventionCommandId", "preventionDigest", "scope", "targetIntentCorrelation", "version",
  ]);
  validateContainedTurnIntentAuthority(command.authority);
  assertContainedTurnExactRecord("prevention scope", command.scope, ["projectId", "tenantId"]);
  for (const value of Object.values(command.scope)) {
    guardText(value);
  }
  guardIdentity("command", command.commandId);
  guardText(command.commandId, CONTAINED_TURN_LIMITS.text.commandId.maximumBytes);
  guardIdentity("cancellation_command", command.preventionCommandId);
  validateContainedTurnGuardDigest(command.commandFingerprint);
  validateContainedTurnGuardDigest(command.preventionDigest);
  if (command.targetIntentCorrelation !== null) {
    guardText(command.targetIntentCorrelation);
  }
  const { preventionDigest, ...preimage } = command;
  if (command.version !== 1 || containedTurnPreventionDigest(preimage) !== preventionDigest) {
    throw new TypeError("prevention command digest or version mismatch");
  }
};

export const validateContainedTurnPreventionReceipt = (receipt: ContainedTurnPreventionReceipt): ContainedTurnPreventionReceipt => {
  assertContainedTurnExactRecord("prevention receipt", receipt, [
    "command", "disposition", "operationId", "operationRevision", "cutoffProofId", "receiptId", "version",
  ]);
  validateContainedTurnPreventionCommand(receipt.command);
  guardIdentity("proof", receipt.receiptId);
  if (receipt.receiptId !== `proof:intent-receipt:${receipt.command.preventionDigest}`) {
    throw new TypeError("intent receipt identity mismatch");
  }
  if (receipt.version !== 1 || !["intent_guarded", "operation_fenced", "cutoff_requested", "already_terminal"].includes(receipt.disposition)) {
    throw new TypeError("invalid prevention receipt disposition");
  }
  if (receipt.disposition === "intent_guarded") {
    if (receipt.operationId !== null || receipt.operationRevision !== null || receipt.cutoffProofId !== null) {
      throw new TypeError("pre-acceptance guard cannot materialize operation evidence");
    }
  } else {
    guardIdentity("operation", receipt.operationId!);
    if (!Number.isSafeInteger(receipt.operationRevision) || receipt.operationRevision! < 0) {
      throw new TypeError("invalid prevention operation revision");
    }
    if (receipt.disposition !== "already_terminal" || receipt.cutoffProofId !== null) {
      guardIdentity("proof", receipt.cutoffProofId!);
    }
  }
  return detachAndFreezeContainedTurnValue(receipt);
};
