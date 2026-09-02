export class ContainedTurnConstructionCleanupError extends Error {
  public readonly code = "contained_turn_construction_cleanup_failed";

  public constructor() {
    super("Contained turn construction cleanup failed");
    this.name = "ContainedTurnConstructionCleanupError";
    delete this.stack;
    Object.freeze(this);
  }
}

export class ContainedTurnOwnerDisposalError extends Error {
  public readonly code = "contained_turn_owner_disposal_failed";

  public constructor() {
    super("Contained turn owner disposal failed");
    this.name = "ContainedTurnOwnerDisposalError";
    delete this.stack;
    Object.freeze(this);
  }
}

export const disposeAfterContainedTurnConstructionFailure = (
  primary: unknown,
  dispose: () => void,
): never => {
  try {
    dispose();
  } catch {
    throw new ContainedTurnConstructionCleanupError();
  }
  throw primary;
};
