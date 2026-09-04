import type {
  ContainedTurnOwnerStoreAuthority,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";

export interface ContainedTurnPostgresIdentitySource {
  nextId(kind: "attempt" | "cancellation_command" | "cleanup" | "custody" | "effect" |
    "execution_generation" | "operation" | "operation_authority" | "proof" |
    "writer_fence", seed?: string): string;
}

export const defaultContainedTurnPostgresIdentities: ContainedTurnPostgresIdentitySource = Object.freeze({
  nextId(
    kind: Parameters<ContainedTurnPostgresIdentitySource["nextId"]>[0],
    seed = kind,
  ) {
    return `${kind.replaceAll("_", "-")}:${digestContainedTurnCanonicalValue({ kind, seed })}`;
  },
});

const sameScope = (
  authority: ContainedTurnOwnerStoreAuthority,
  operation: ContainedTurnKernelOperation,
): boolean =>
  authority.operationId === operation.operationId && authority.commandId === operation.commandId &&
  authority.effectId === operation.effectId && authority.scope.projectId === operation.scope.projectId &&
  authority.scope.tenantId === operation.scope.tenantId;

export const assertContainedTurnPostgresAuthority = (
  authority: ContainedTurnOwnerStoreAuthority,
  operation: ContainedTurnKernelOperation,
): void => {
  if (!sameScope(authority, operation)) {throw new TypeError("PostgreSQL owner-store authority mismatch");}
};

export const containedTurnPostgresOperationBinding = (operation: ContainedTurnKernelOperation) => Object.freeze({
  authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  operationId: operation.operationId,
});

export const containedTurnPostgresAttemptBinding = (operation: ContainedTurnKernelOperation) => {
  if (operation.dispatch.kind !== "claimed") {throw new TypeError("attempt proof requires the durable claim");}
  return Object.freeze({
    ...containedTurnPostgresOperationBinding(operation),
    attemptId: operation.dispatch.attemptId,
    effectId: operation.effectId,
  });
};
