/** Frozen contained-turn kernel facade. Domain responsibilities live in owner-local pure modules. */
export { ContainedTurnInvariantError } from "./contained-turn-invariant.js";
export type {
  ContainedTurnKernelOperation,
  ContainedTurnKernelOutputChunk,
  ContainedTurnKernelOutputKind,
} from "./contained-turn-kernel-model.js";
export { containedTurnSatisfactionDigest } from "./contained-turn-satisfaction.js";
export { appendContainedTurnOutputForOwnerStore } from "./contained-turn-output-transitions.js";
export {
  createContainedTurnOperation,
  type CreateContainedTurnOperationInput,
} from "./contained-turn-creation.js";
export {
  mutateContainedTurnOperation,
  type ContainedTurnKernelMutation,
} from "./contained-turn-transitions.js";
export { validateContainedTurnOperation } from "./contained-turn-validation.js";
