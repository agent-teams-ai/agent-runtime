import type { ContainedTurnCompositionScope } from "../../composition/trusted-runtime-access-scope.js";

export interface ContainedTurnCompositionOperationRef<Scope extends ContainedTurnCompositionScope = ContainedTurnCompositionScope> {
  readonly operationId: string;
  readonly scope: Scope;
}
