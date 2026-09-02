export class ContainedTurnConstructionCleanupError extends AggregateError {
  public readonly code = "contained_turn_construction_cleanup_failed";

  public constructor(primary: unknown, cleanup: unknown) {
    super(
      [primary, cleanup],
      "Contained turn construction failed and its owner could not be disposed",
      {cause: primary},
    );
    this.name = "ContainedTurnConstructionCleanupError";
  }
}

export const disposeAfterContainedTurnConstructionFailure = (
  primary: unknown,
  dispose: () => void,
): never => {
  try {
    dispose();
  } catch (cleanup) {
    throw new ContainedTurnConstructionCleanupError(primary, cleanup);
  }
  throw primary;
};
