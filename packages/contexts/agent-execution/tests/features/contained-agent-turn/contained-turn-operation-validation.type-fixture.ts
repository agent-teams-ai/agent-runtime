import type { ContainedTurnKernelOperation } from "../../../src/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { validateContainedTurnOperation } from "../../../src/features/contained-agent-turn/domain/contained-turn-validation.js";

export const validateUnknownOperation = (input: unknown): ContainedTurnKernelOperation => {
  validateContainedTurnOperation(input);
  return input;
};

export const retainPreviousCompatibility: (
  input: ContainedTurnKernelOperation, options?: Readonly<{ previous?: ContainedTurnKernelOperation }>,
) => void = validateContainedTurnOperation;
