import type {
  AgentRuntimeHostContainedTurnDisposalIssue,
} from "./agent-runtime-host-disposal.js";

export const CONTAINED_TURN_DISPOSAL_DIAGNOSTIC_LIMIT = 64;

export interface ContainedTurnDisposalDiagnostics {
  readonly containedTurns: readonly AgentRuntimeHostContainedTurnDisposalIssue[];
  readonly omittedContainedTurnCount: number;
}

interface DiagnosticOperation {
  readonly operation: Readonly<{ readonly operationId: string }>;
  readonly status: AgentRuntimeHostContainedTurnDisposalIssue["status"];
}

const compareOperationIds = (left: string, right: string): number => {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      return leftPoint.done === rightPoint.done ? 0 : leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0)! - rightPoint.value.codePointAt(0)!;
    if (difference !== 0) {
      return difference;
    }
  }
};

export const projectContainedTurnDisposalDiagnostics = (
  activeContainedTurns: ReadonlyMap<string, DiagnosticOperation>,
): ContainedTurnDisposalDiagnostics => {
  const selected: DiagnosticOperation[] = [];
  for (const active of activeContainedTurns.values()) {
    let insertionIndex = 0;
    while (insertionIndex < selected.length && compareOperationIds(
      selected[insertionIndex]!.operation.operationId,
      active.operation.operationId,
    ) <= 0) {
      insertionIndex += 1;
    }
    if (insertionIndex < CONTAINED_TURN_DISPOSAL_DIAGNOSTIC_LIMIT) {
      selected.splice(insertionIndex, 0, active);
      if (selected.length > CONTAINED_TURN_DISPOSAL_DIAGNOSTIC_LIMIT) {
        selected.pop();
      }
    }
  }
  return Object.freeze({
    containedTurns: Object.freeze(selected.map(active => Object.freeze({
      operationId: active.operation.operationId,
      status: active.status,
    }))),
    omittedContainedTurnCount: activeContainedTurns.size - selected.length,
  });
};
