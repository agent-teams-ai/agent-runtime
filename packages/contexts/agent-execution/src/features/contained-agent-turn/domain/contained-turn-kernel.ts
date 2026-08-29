/** Frozen contained-turn kernel facade. Domain responsibilities live in owner-local pure modules. */
export { ContainedTurnInvariantError } from "./contained-turn-invariant.js";
export type {
  ContainedTurnKernelOperation,
  ContainedTurnKernelOutputChunk,
  ContainedTurnKernelOutputKind,
} from "./contained-turn-kernel-model.js";
export { containedTurnSatisfactionDigest } from "./contained-turn-satisfaction.js";
export {
  createContainedTurnOperation,
  mutateContainedTurnOperation,
  type ContainedTurnKernelMutation,
  type CreateContainedTurnOperationInput,
} from "./contained-turn-transitions.js";
export { validateContainedTurnOperation } from "./contained-turn-validation.js";
