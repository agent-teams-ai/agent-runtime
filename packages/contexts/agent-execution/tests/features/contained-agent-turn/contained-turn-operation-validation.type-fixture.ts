import type { ContainedTurnKernelOperation } from "../../../src/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { validateContainedTurnOperation } from "../../../src/features/contained-agent-turn/domain/contained-turn-validation.js";
import { validateContainedTurnOperationShape } from "../../../src/features/contained-agent-turn/domain/contained-turn-operation-shape.js";

export const validateUnknownOperation = (input: unknown): ContainedTurnKernelOperation => {
  validateContainedTurnOperation(input);
  return input;
};

export const retainPreviousCompatibility: (
  input: ContainedTurnKernelOperation, options?: Readonly<{ previous?: ContainedTurnKernelOperation }>,
) => void = validateContainedTurnOperation;

export const structuralProofIsIncomplete = (input: unknown): void => {
  validateContainedTurnOperationShape(input);
  // Shape checks must not promote unvalidated scalar fields into authority.
  // @ts-expect-error Structural validation alone cannot establish a kernel operation.
  const complete: ContainedTurnKernelOperation = input;
  void complete;
};
