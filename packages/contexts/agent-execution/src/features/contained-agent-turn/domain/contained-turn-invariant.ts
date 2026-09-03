export class ContainedTurnInvariantError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "ContainedTurnInvariantError";
  }
}

export function containedTurnInvariant(condition: boolean, message: string): asserts condition {
  if (!condition) {throw new ContainedTurnInvariantError(message);}
}
