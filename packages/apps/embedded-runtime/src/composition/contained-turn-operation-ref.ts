import type { ContainedTurnCompositionScope } from "./trusted-runtime-access-scope.js";

export interface ContainedTurnCompositionOperationRef {
  readonly operationId: string;
  readonly scope: ContainedTurnCompositionScope;
}
