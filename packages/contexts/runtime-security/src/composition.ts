export { createNodePathCanonicalizer } from "./features/setup-source-inspection-authorization/adapters/outbound/node-path-canonicalizer.js";
export { createInMemoryDispatchConsumptionRepository } from "./features/contained-turn-dispatch-authority/adapters/outbound/in-memory-dispatch-consumption-repository.js";
export type { InMemoryDispatchConsumptionRepository } from "./features/contained-turn-dispatch-authority/adapters/outbound/in-memory-dispatch-consumption-repository.js";
export { createNodeSha256DispatchDigest } from "./features/contained-turn-dispatch-authority/adapters/outbound/node-sha256-dispatch-digest.js";
export type { DispatchControlClock } from "./features/contained-turn-dispatch-authority/application/ports/outbound/control-clock.js";
export type {
  DispatchConsumptionRepository,
  PersistedConsumption,
} from "./features/contained-turn-dispatch-authority/application/ports/outbound/dispatch-consumption-repository.js";
export type { DispatchDigest } from "./features/contained-turn-dispatch-authority/application/ports/outbound/dispatch-digest.js";
export {
  createContainedTurnDispatchAuthorityFeature,
  type ContainedTurnDispatchAuthorityFeatureDependencies,
} from "./features/contained-turn-dispatch-authority/composition/feature-module-factory.js";
export type {
  DispatchAuthorityHead,
  DispatchAuthorityScope,
} from "./features/contained-turn-dispatch-authority/domain/dispatch-authority-head.js";
export { createAuthorizeClaudeCodeSetupInspection } from "./features/setup-source-inspection-authorization/application/authorize-claude-code-setup-inspection.js";
export type { PathCanonicalizer } from "./features/setup-source-inspection-authorization/application/ports/outbound/path-canonicalizer.js";
export {
  createSetupInspectionAuthorizationFeature,
  type SetupInspectionAuthorizationDependencies,
} from "./features/setup-source-inspection-authorization/composition/feature-module-factory.js";
