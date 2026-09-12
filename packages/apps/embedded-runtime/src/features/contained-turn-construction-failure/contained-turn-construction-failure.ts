export class ContainedTurnConstructionCleanupError extends Error {
  public readonly code = "contained_turn_construction_cleanup_failed";

  public constructor(options: { cause: unknown }) {
    super("Contained turn construction cleanup failed", { cause: options.cause });
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
    // Both failures are untrusted and may contain credentials or provider paths.
    // Keep the fixed cleanup-stage diagnostic; do not retain the raw cleanup
    // failure or stack, but preserve `primary` as `cause` so the failure that
    // triggered cleanup is not fully swallowed.
    throw new ContainedTurnConstructionCleanupError({ cause: primary });
  }
  throw primary;
};
