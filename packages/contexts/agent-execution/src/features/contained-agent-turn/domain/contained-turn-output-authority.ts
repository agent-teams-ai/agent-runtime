import type { ContainedTurnProviderAdapterSnapshot, ContainedTurnScope } from "./contained-turn-authority.js";
import type { ContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnCustodyId,
  ContainedTurnEvidenceId,
  ContainedTurnExecutionGenerationId,
  ContainedTurnHostBootId,
  ContainedTurnHostInstanceId,
  ContainedTurnOperationId,
  ContainedTurnProofId,
  ContainedTurnWriterFence,
} from "./contained-turn-identities.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import { assertContainedTurnExactRecord } from "./contained-turn-record.js";

declare const operationCutoffRevisionBrand: unique symbol;

export type ContainedTurnOperationCutoffRevision = number & {
  readonly [operationCutoffRevisionBrand]: true;
};

export const containedTurnOperationCutoffRevision = (
  value: number,
): ContainedTurnOperationCutoffRevision => {
  invariant(Number.isSafeInteger(value) && value >= 0, "operation cutoff revision must be a non-negative safe integer");
  return value as ContainedTurnOperationCutoffRevision;
};

export const nextContainedTurnOperationCutoffRevision = (
  current: ContainedTurnOperationCutoffRevision,
): ContainedTurnOperationCutoffRevision => containedTurnOperationCutoffRevision(current + 1);

export type ContainedTurnOperationCutoff =
  | { readonly kind: "open"; readonly revision: ContainedTurnOperationCutoffRevision }
  | {
    readonly kind: "closed";
    readonly proofId: ContainedTurnProofId;
    readonly reason: "cancellation" | "prevention";
    readonly revision: ContainedTurnOperationCutoffRevision;
  }
  | {
    readonly evidenceId: ContainedTurnEvidenceId;
    readonly kind: "closed";
    readonly reason: "continuity_lost";
    readonly revision: ContainedTurnOperationCutoffRevision;
  };

/** Complete private credential required by the canonical-output owner-store predicate. */
export interface ContainedTurnOutputWriteAuthority {
  readonly acceptedAuthorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly adapterRevision: string;
  readonly attemptId: ContainedTurnAttemptId;
  readonly binaryRevision: string;
  readonly capabilityManifestRevision: string;
  readonly custodyId: ContainedTurnCustodyId;
  readonly executionGenerationId: ContainedTurnExecutionGenerationId;
  readonly hostBootId: ContainedTurnHostBootId;
  readonly hostInstanceId: ContainedTurnHostInstanceId;
  readonly operationCutoffRevision: ContainedTurnOperationCutoffRevision;
  readonly operationId: ContainedTurnOperationId;
  readonly provider: ContainedTurnProviderAdapterSnapshot["provider"];
  readonly writerFence: ContainedTurnWriterFence;
}

const OUTPUT_WRITE_AUTHORITY_FIELDS = Object.freeze([
  "acceptedAuthorityVectorDigest",
  "adapterRevision",
  "attemptId",
  "binaryRevision",
  "capabilityManifestRevision",
  "custodyId",
  "executionGenerationId",
  "hostBootId",
  "hostInstanceId",
  "operationCutoffRevision",
  "operationId",
  "provider",
  "writerFence",
] as const satisfies readonly (keyof ContainedTurnOutputWriteAuthority)[]);

const sameScope = (left: ContainedTurnScope, right: ContainedTurnScope): boolean =>
  left.projectId === right.projectId && left.tenantId === right.tenantId;

export const containedTurnOutputWriteAuthority = (
  operation: ContainedTurnKernelOperation,
): ContainedTurnOutputWriteAuthority => {
  invariant(
    operation.dispatch.kind === "claimed" && operation.custodyId !== undefined &&
      operation.hostBootId !== undefined && operation.hostInstanceId !== undefined &&
      operation.operationCutoff.kind === "open" &&
      operation.operationCutoff.revision === operation.dispatch.operationCutoffRevision,
    "canonical output authority exists only for the single claimed V1 execution",
  );
  if (operation.dispatch.kind !== "claimed" || operation.custodyId === undefined ||
      operation.hostBootId === undefined || operation.hostInstanceId === undefined ||
      operation.operationCutoff.kind !== "open" ||
      operation.operationCutoff.revision !== operation.dispatch.operationCutoffRevision) {
    throw new TypeError("canonical output authority is unavailable");
  }
  return Object.freeze({
    acceptedAuthorityVectorDigest: operation.acceptedAuthorityVectorDigest,
    adapterRevision: operation.adapterSnapshot.adapterRevision,
    attemptId: operation.dispatch.attemptId,
    binaryRevision: operation.adapterSnapshot.binaryRevision,
    capabilityManifestRevision: operation.adapterSnapshot.capabilityManifestRevision,
    custodyId: operation.custodyId,
    executionGenerationId: operation.dispatch.executionGenerationId,
    hostBootId: operation.hostBootId,
    hostInstanceId: operation.hostInstanceId,
    operationCutoffRevision: operation.dispatch.operationCutoffRevision,
    operationId: operation.operationId,
    provider: operation.adapterSnapshot.provider,
    writerFence: operation.dispatch.writerFence,
  });
};

export type ContainedTurnOutputAppendPredicate = "current" | "not_found" | "stale";

/**
 * Shared owner-store predicate. Scope is deliberately checked first so a
 * foreign record can never escape through stale-current diagnostics.
 */
export const classifyContainedTurnOutputAppend = (input: Readonly<{
  authority: ContainedTurnOutputWriteAuthority;
  current: ContainedTurnKernelOperation | undefined;
  expectedCursor: number;
  expectedRevision: number;
  operationId: ContainedTurnOperationId;
  scope: ContainedTurnScope;
}>): ContainedTurnOutputAppendPredicate => {
  assertContainedTurnExactRecord("output append predicate", input, [
    "authority", "current", "expectedCursor", "expectedRevision", "operationId", "scope",
  ]);
  const current = input.current;
  if (
    current === undefined || !sameScope(current.scope, input.scope) ||
    current.operationId !== input.operationId
  ) {return "not_found";}
  assertContainedTurnExactRecord("output write authority", input.authority, OUTPUT_WRITE_AUTHORITY_FIELDS);
  if (
    current.dispatch.kind !== "claimed" || current.custodyId === undefined ||
    current.hostBootId === undefined || current.hostInstanceId === undefined ||
    current.terminal.kind !== "open" || current.output.fence.kind !== "open" ||
    current.providerProcessStart.kind !== "execution_started" || current.providerExecution.kind !== "active" ||
    current.operationCutoff.kind !== "open" || current.revision !== input.expectedRevision ||
    current.output.chunks.length !== input.expectedCursor
  ) {return "stale";}
  const expected = containedTurnOutputWriteAuthority(current);
  return OUTPUT_WRITE_AUTHORITY_FIELDS.every(key => input.authority[key] === expected[key])
    ? "current"
    : "stale";
};
