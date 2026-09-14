import type { ContainedTurnCompositionScope } from "../../trusted-runtime-access-scope/index.js";

export interface ContainedTurnCompositionOperationRef<Scope extends ContainedTurnCompositionScope = ContainedTurnCompositionScope> {
  readonly operationId: string;
  readonly scope: Scope;
}
