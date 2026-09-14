export type ContainedTurnOwnerContractErrorCode =
  | "duplicate_operation_id"
  | "invalid_operation_id"
  | "malformed_owner_outcome"
  | "owner_invocation_failed"
  | "operation_id_mismatch";

export class ContainedTurnOwnerContractError extends Error {
  public readonly code: ContainedTurnOwnerContractErrorCode;

  public constructor(code: ContainedTurnOwnerContractErrorCode) {
    super("Contained-turn owner contract violation");
    this.name = "ContainedTurnOwnerContractError";
    this.code = code;
    Object.freeze(this);
  }
}

export const containedTurnOwnerInvocationFailed =
  new ContainedTurnOwnerContractError("owner_invocation_failed");
